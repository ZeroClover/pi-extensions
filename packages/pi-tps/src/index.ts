import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { runsFromEntries, sessionTotals } from "./aggregate.ts";
import { ModelAverages } from "./averages.ts";
import {
	CALIBRATION_DIR_NAME,
	CALIBRATION_KINDS,
	calibrationKey,
	calibrationKeys,
	openCalibration,
	type SessionCalibration,
} from "./calibration.ts";
import { monotonicClock } from "./clock.ts";
import { parseTpsCommand, TPS_USAGE } from "./command.ts";
import { CONFIG_FILE_NAME, type MetricConfig, parseConfig, resolveMetrics, type TpsConfig } from "./config.ts";
import { STATUS_KEY } from "./constants.ts";
import { errorMessage, nodeFiles } from "./files.ts";
import { formatSnapshot } from "./format.ts";
import { Measurement, phaseEvent } from "./measurement.ts";
import { renderLine, StatusWriter } from "./render.ts";
import { RunTracker } from "./run.ts";
import {
	type Averages,
	type ModelRef,
	REQUEST_CHANNEL,
	RUN_CHANNEL,
	type RunRecord,
	STATUS_CHANNEL,
	type StatusSnapshot,
	TELEMETRY_CHANNEL,
	TELEMETRY_CUSTOM_TYPE,
} from "./telemetry.ts";
import { scheduleInterval, Ticker } from "./ticker.ts";

/** Session-scoped state, created on `session_start` and dropped on `session_shutdown`. */
interface Runtime {
	config: TpsConfig;
	calibration: SessionCalibration;
	meter: Measurement;
	run: RunTracker;
	ticker: Ticker;
	writer: StatusWriter;
	tui: boolean;
	visible: boolean;
	/** Settled runs: the current branch's when persisting, else this runtime's. */
	runs: RunRecord[];
	/** Per-model averages over the request records of `runs` and of the active run. */
	averages: ModelAverages;
	/** The selected model: the model a new request starts under. */
	activeModel: ModelRef | undefined;
	/** Colour settings of the model serving the request in flight. */
	liveMetrics: MetricConfig;
	/** UI of the handler that started the run; held only while the ticker runs. */
	tickUi: ExtensionUIContext | undefined;
	unsubscribeRequest: () => void;
}

function loadConfig(path: string): { config: TpsConfig; warnings: string[] } {
	try {
		return parseConfig(nodeFiles.read(path), path);
	} catch (error) {
		const result = parseConfig(undefined, path);
		result.warnings.push(`pi-tps: cannot read ${path}: ${errorMessage(error)}; using defaults`);
		return result;
	}
}

function modelRef(model: { provider: string; id: string }): ModelRef {
	return { provider: model.provider, model: model.id };
}

export default function (pi: ExtensionAPI): void {
	let runtime: Runtime | undefined;

	function currentAverages(rt: Runtime): Averages {
		const current = rt.averages.current(rt.activeModel);
		return current ? rt.averages.of(current.provider, current.model) : {};
	}

	function snapshotOf(rt: Runtime): StatusSnapshot {
		const live = rt.meter.snapshot(rt.run.requestCount + 1);
		if (live) return { ...live, average: rt.averages.of(live.provider, live.model) };
		const working = rt.run.snapshot();
		if (working) return { ...working, average: currentAverages(rt) };
		const session = sessionTotals(rt.runs);
		const average = currentAverages(rt);
		return session ? { phase: "idle", average, session } : { phase: "idle", average };
	}

	/** Broadcasts the current snapshot and, in the TUI, writes it to the footer. */
	function publish(rt: Runtime, ui: ExtensionUIContext | undefined): void {
		const snapshot = snapshotOf(rt);
		pi.events.emit(STATUS_CHANNEL, snapshot);
		if (!rt.tui || !ui) return;
		const write = (text: string | undefined): void => ui.setStatus(STATUS_KEY, text);
		if (!rt.visible) {
			rt.writer.set(undefined, write);
			return;
		}
		const { frames, enabled } = rt.config.animation;
		const indicator = (enabled ? frames[rt.ticker.currentFrame % frames.length] : frames[0]) ?? "";
		const text = renderLine(formatSnapshot(snapshot, indicator, rt.liveMetrics), ui.theme, rt.config);
		rt.writer.set(text, write);
	}

	function stopTicker(rt: Runtime): void {
		rt.ticker.stop();
		rt.tickUi = undefined;
	}

	function rebuild(rt: Runtime, ctx: ExtensionContext): void {
		rt.runs = runsFromEntries(ctx.sessionManager.getBranch());
		rt.averages.rebuild(rt.runs.flatMap((run) => run.requests));
	}

	pi.on("session_start", (_event, ctx) => {
		if (runtime) {
			stopTicker(runtime);
			runtime.unsubscribeRequest();
		}
		const agentDir = getAgentDir();
		const { config, warnings } = loadConfig(join(agentDir, CONFIG_FILE_NAME));
		const { calibration, warning: calibrationWarning } = openCalibration(
			config.calibration,
			join(agentDir, CALIBRATION_DIR_NAME),
			nodeFiles,
		);
		if (calibrationWarning) warnings.push(calibrationWarning);
		for (const warning of warnings) ctx.ui.notify(warning, "warning");

		const rt: Runtime = {
			config,
			calibration,
			meter: new Measurement(monotonicClock),
			run: new RunTracker(monotonicClock),
			ticker: new Ticker(scheduleInterval, config.animation.intervalMs, () => publish(rt, rt.tickUi)),
			writer: new StatusWriter(),
			tui: ctx.mode === "tui",
			visible: config.enabled,
			runs: [],
			averages: new ModelAverages(),
			activeModel: ctx.model ? modelRef(ctx.model) : undefined,
			liveMetrics: { tps: config.tps, ttft: config.ttft },
			tickUi: undefined,
			unsubscribeRequest: pi.events.on(REQUEST_CHANNEL, () => {
				if (runtime === rt) pi.events.emit(STATUS_CHANNEL, snapshotOf(rt));
			}),
		};
		runtime = rt;
		if (config.persist) rebuild(rt, ctx);
		publish(rt, ctx.ui);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const rt = runtime;
		if (!rt) return;
		runtime = undefined;
		stopTicker(rt);
		rt.meter.reset();
		rt.run.discard();
		rt.unsubscribeRequest();
		// Samples that lost a publish race or hit a write failure get a last chance; then the session's record goes.
		const warning = rt.calibration.close();
		if (warning) ctx.ui.notify(warning, "warning");
		if (rt.tui) ctx.ui.setStatus(STATUS_KEY, undefined);
		pi.events.emit(STATUS_CHANNEL, null);
	});

	pi.on("session_tree", (_event, ctx) => {
		const rt = runtime;
		if (!rt) return;
		// Without persistence the runs are this runtime's own and do not follow the branch.
		if (rt.config.persist) rebuild(rt, ctx);
		publish(rt, ctx.ui);
	});

	pi.on("model_select", (event, ctx) => {
		const rt = runtime;
		if (!rt) return;
		rt.activeModel = modelRef(event.model);
		publish(rt, ctx.ui);
	});

	pi.on("agent_start", (_event, ctx) => {
		const rt = runtime;
		if (!rt?.run.start(Date.now())) return;
		rt.tickUi = ctx.ui;
		rt.ticker.start();
		publish(rt, ctx.ui);
	});

	pi.on("agent_settled", (event, ctx) => {
		const rt = runtime;
		if (!rt) return;
		rt.meter.reset();
		stopTicker(rt);
		const run = rt.run.settle(event.aborted);
		if (run) {
			rt.runs.push(run);
			if (rt.config.persist) pi.appendEntry(TELEMETRY_CUSTOM_TYPE, run);
			pi.events.emit(RUN_CHANNEL, run);
		}
		publish(rt, ctx.ui);
	});

	pi.on("turn_start", (_event, ctx) => {
		const rt = runtime;
		if (!rt) return;
		if (rt.meter.turnStart()) publish(rt, ctx.ui);
	});

	pi.on("turn_end", (_event, ctx) => {
		const rt = runtime;
		if (rt?.meter.turnEnd()) publish(rt, ctx.ui);
	});

	pi.on("agent_end", (_event, ctx) => {
		// The run may continue with a retry or a queued prompt; only the request in flight ends here.
		const rt = runtime;
		if (rt?.meter.reset()) publish(rt, ctx.ui);
	});

	pi.on("before_provider_request", (_event, ctx) => {
		const rt = runtime;
		if (!rt) return;
		const model = rt.activeModel ?? (ctx.model ? modelRef(ctx.model) : undefined);
		const provider = model?.provider ?? "unknown";
		const id = model?.model ?? "unknown";
		const started = rt.meter.requestStart({
			provider,
			model: id,
			ratios: rt.calibration.ratios(calibrationKey(provider, id)),
			wallTime: Date.now(),
		});
		if (!started) return;
		rt.liveMetrics = resolveMetrics(rt.config, provider, id);
		publish(rt, ctx.ui);
	});

	pi.on("after_provider_response", () => {
		runtime?.meter.responseHeaders();
	});

	pi.on("message_start", (event) => {
		const rt = runtime;
		const message = event.message;
		if (!rt || message.role !== "assistant" || !rt.meter.active) return;
		// The message names the model that serves the request; behind a virtual model it differs from ctx.model.
		rt.meter.messageStart({
			provider: message.provider,
			model: message.model,
			ratios: rt.calibration.ratios(calibrationKey(message.provider, message.model)),
		});
		rt.liveMetrics = resolveMetrics(rt.config, message.provider, message.model);
	});

	pi.on("message_update", (event) => {
		const rt = runtime;
		if (!rt) return;
		const phase = phaseEvent(event.assistantMessageEvent);
		if (phase) rt.meter.event(phase);
	});

	pi.on("message_end", (event, ctx) => {
		const rt = runtime;
		const message = event.message;
		if (!rt || message.role !== "assistant") return;
		const outcome = rt.meter.end(message);
		if (outcome.kind === "ignored") return;
		if (outcome.kind === "recorded") {
			const { record } = outcome;
			rt.run.add(record);
			// Before publishing, so that the working readout's averages include the request.
			rt.averages.fold(record);
			pi.events.emit(TELEMETRY_CHANNEL, record);
			const keys = calibrationKeys(record.provider, record.model, record.responseModel);
			const samples = CALIBRATION_KINDS.flatMap((kind) => {
				const sample = outcome.calibration[kind];
				return sample ? keys.map((key) => ({ key, kind, sample })) : [];
			});
			const warning = rt.calibration.update(samples, Date.now());
			if (warning) ctx.ui.notify(warning, "warning");
		}
		publish(rt, ctx.ui);
	});

	pi.registerCommand("tps", {
		description: "Show or hide the TPS readout",
		handler: async (args, ctx) => {
			const rt = runtime;
			if (!rt) return;
			if (parseTpsCommand(args).kind === "invalid") {
				ctx.ui.notify(TPS_USAGE, "warning");
				return;
			}
			rt.visible = !rt.visible;
			publish(rt, ctx.ui);
		},
	});
}
