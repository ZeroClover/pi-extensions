import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { runsFromEntries, summarizeRun, summarizeSession } from "./aggregate.ts";
import { CALIBRATION_DIR_NAME, CalibrationStore, calibrationKey, calibrationKeys } from "./calibration.ts";
import { monotonicClock } from "./clock.ts";
import { parseTpsCommand, TPS_USAGE, tpsCompletions } from "./command.ts";
import { CONFIG_FILE_NAME, parseConfig, resolveThresholds, type Threshold, type TpsConfig } from "./config.ts";
import { STATUS_KEY } from "./constants.ts";
import { errorMessage, nodeFiles } from "./files.ts";
import { formatSnapshot } from "./format.ts";
import { contentDelta, Measurement } from "./measurement.ts";
import { renderLine, StatusWriter } from "./render.ts";
import { RunTracker } from "./run.ts";
import {
	REQUEST_CHANNEL,
	RUN_CHANNEL,
	type RunRecord,
	STATUS_CHANNEL,
	type StatusSnapshot,
	type SummaryMode,
	TELEMETRY_CHANNEL,
	TELEMETRY_CUSTOM_TYPE,
} from "./telemetry.ts";
import { scheduleInterval, Ticker } from "./ticker.ts";

/** Session-scoped state, created on `session_start` and dropped on `session_shutdown`. */
interface Runtime {
	config: TpsConfig;
	calibration: CalibrationStore;
	meter: Measurement;
	run: RunTracker;
	ticker: Ticker;
	writer: StatusWriter;
	tui: boolean;
	visible: boolean;
	mode: SummaryMode;
	/** Settled runs: the current branch's when persisting, else this runtime's. */
	runs: RunRecord[];
	activeModel: { provider: string; id: string } | undefined;
	/** Thresholds of the model serving the request in flight. */
	liveThresholds: Threshold[];
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

export default function (pi: ExtensionAPI): void {
	let runtime: Runtime | undefined;

	function snapshotOf(rt: Runtime): StatusSnapshot {
		const live = rt.meter.snapshot(rt.run.requestCount + 1);
		if (live) return live;
		const working = rt.run.snapshot();
		if (working) return working;
		if (rt.mode === "session") {
			const session = summarizeSession(rt.runs);
			return session ? { phase: "session", session } : { phase: "empty", mode: rt.mode };
		}
		const last = rt.runs.at(-1);
		return last ? { phase: "run", run: summarizeRun(last) } : { phase: "empty", mode: rt.mode };
	}

	function thresholdsFor(rt: Runtime, snapshot: StatusSnapshot): readonly Threshold[] {
		switch (snapshot.phase) {
			case "waiting":
			case "streaming":
				return rt.liveThresholds;
			case "run":
			case "session": {
				const summary = snapshot.phase === "run" ? snapshot.run : snapshot.session;
				if (summary.provider !== undefined && summary.model !== undefined) {
					return resolveThresholds(rt.config, summary.provider, summary.model);
				}
				return rt.config.thresholds;
			}
			default:
				return rt.config.thresholds;
		}
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
		const line = formatSnapshot(snapshot, rt.config.labels, indicator);
		const text = renderLine(line, rt.config.labels, ui.theme, rt.config.baseColor, thresholdsFor(rt, snapshot));
		rt.writer.set(text, write);
	}

	function stopTicker(rt: Runtime): void {
		rt.ticker.stop();
		rt.tickUi = undefined;
	}

	function rebuild(rt: Runtime, ctx: ExtensionContext): void {
		rt.runs = runsFromEntries(ctx.sessionManager.getBranch());
	}

	pi.on("session_start", (_event, ctx) => {
		if (runtime) {
			stopTicker(runtime);
			runtime.unsubscribeRequest();
		}
		const agentDir = getAgentDir();
		const { config, warnings } = loadConfig(join(agentDir, CONFIG_FILE_NAME));
		const calibration = new CalibrationStore(join(agentDir, CALIBRATION_DIR_NAME), nodeFiles);
		const calibrationWarning = calibration.load();
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
			mode: config.summaryMode,
			runs: [],
			activeModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
			liveThresholds: config.thresholds,
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

	pi.on("model_select", (event) => {
		if (runtime) runtime.activeModel = { provider: event.model.provider, id: event.model.id };
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
		const dropped = rt.meter.active;
		rt.meter.turnStart();
		if (dropped) publish(rt, ctx.ui);
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
		const model = rt.activeModel ?? (ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined);
		const provider = model?.provider ?? "unknown";
		const id = model?.id ?? "unknown";
		const started = rt.meter.requestStart({
			provider,
			model: id,
			ratio: rt.calibration.ratio(calibrationKey(provider, id)),
			wallTime: Date.now(),
		});
		if (!started) return;
		rt.liveThresholds = resolveThresholds(rt.config, provider, id);
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
			ratio: rt.calibration.ratio(calibrationKey(message.provider, message.model)),
		});
		rt.liveThresholds = resolveThresholds(rt.config, message.provider, message.model);
	});

	pi.on("message_update", (event) => {
		const rt = runtime;
		if (!rt) return;
		const delta = contentDelta(event.assistantMessageEvent);
		if (delta) rt.meter.delta(delta.stream, delta.text);
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
			pi.events.emit(TELEMETRY_CHANNEL, record);
			if (outcome.calibration) {
				for (const key of calibrationKeys(record.provider, record.model, record.responseModel)) {
					const warning = rt.calibration.update(key, outcome.calibration, Date.now());
					if (warning) ctx.ui.notify(warning, "warning");
				}
			}
		}
		publish(rt, ctx.ui);
	});

	pi.registerCommand("tps", {
		description: "Toggle the TPS readout; /tps mode [last|session] switches the idle summary",
		getArgumentCompletions: tpsCompletions,
		handler: async (args, ctx) => {
			const rt = runtime;
			if (!rt) return;
			const command = parseTpsCommand(args);
			switch (command.kind) {
				case "invalid":
					ctx.ui.notify(TPS_USAGE, "warning");
					return;
				case "toggle":
					rt.visible = !rt.visible;
					break;
				case "mode":
					rt.mode = command.mode ?? (rt.mode === "last" ? "session" : "last");
					break;
			}
			publish(rt, ctx.ui);
		},
	});
}
