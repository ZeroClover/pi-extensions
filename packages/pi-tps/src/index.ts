import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { aggregate, lastRecord, recordsFromEntries } from "./aggregate.ts";
import { CALIBRATION_FILE_NAME, CalibrationStore, calibrationKey, calibrationKeys } from "./calibration.ts";
import { monotonicClock } from "./clock.ts";
import { parseTpsCommand, TPS_USAGE, tpsCompletions } from "./command.ts";
import { CONFIG_FILE_NAME, parseConfig, resolveThresholds, type Threshold, type TpsConfig } from "./config.ts";
import { STATUS_KEY } from "./constants.ts";
import { errorMessage, nodeFiles } from "./files.ts";
import { formatSnapshot } from "./format.ts";
import { contentDelta, Measurement } from "./measurement.ts";
import { renderSegments, StatusWriter } from "./render.ts";
import {
	REQUEST_CHANNEL,
	STATUS_CHANNEL,
	type StatusSnapshot,
	type SummaryMode,
	TELEMETRY_CHANNEL,
	TELEMETRY_CUSTOM_TYPE,
	type TelemetryRecord,
} from "./telemetry.ts";
import { scheduleInterval, Ticker } from "./ticker.ts";

/** Session-scoped state, created on `session_start` and dropped on `session_shutdown`. */
interface Runtime {
	config: TpsConfig;
	calibration: CalibrationStore;
	meter: Measurement;
	ticker: Ticker;
	writer: StatusWriter;
	tui: boolean;
	visible: boolean;
	mode: SummaryMode;
	records: TelemetryRecord[];
	activeModel: { provider: string; id: string } | undefined;
	/** Thresholds of the model of the request in flight. */
	liveThresholds: Threshold[];
	/** UI of the handler that started the ticker; held only while the ticker runs. */
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
		const live = rt.meter.snapshot();
		if (live) return live;
		if (rt.mode === "session") {
			const totals = aggregate(rt.records);
			return totals ? { phase: "session", aggregate: totals } : { phase: "empty", mode: rt.mode };
		}
		const last = lastRecord(rt.records);
		return last ? { phase: "last", ...last } : { phase: "empty", mode: rt.mode };
	}

	function thresholdsFor(rt: Runtime, snapshot: StatusSnapshot): readonly Threshold[] {
		switch (snapshot.phase) {
			case "waiting":
			case "streaming":
				return rt.liveThresholds;
			case "last":
				return resolveThresholds(rt.config, snapshot.record.provider, snapshot.record.model);
			default:
				return rt.activeModel
					? resolveThresholds(rt.config, rt.activeModel.provider, rt.activeModel.id)
					: rt.config.thresholds;
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
		const segments = formatSnapshot(snapshot, indicator);
		rt.writer.set(renderSegments(segments, ui.theme, rt.config.baseColor, thresholdsFor(rt, snapshot)), write);
	}

	function stopLive(rt: Runtime): void {
		rt.ticker.stop();
		rt.tickUi = undefined;
	}

	function rebuild(rt: Runtime, ctx: ExtensionContext): void {
		rt.records = rt.config.persist ? recordsFromEntries(ctx.sessionManager.getBranch()) : [];
	}

	pi.on("session_start", (_event, ctx) => {
		if (runtime) {
			stopLive(runtime);
			runtime.unsubscribeRequest();
		}
		const agentDir = getAgentDir();
		const { config, warnings } = loadConfig(join(agentDir, CONFIG_FILE_NAME));
		const calibration = new CalibrationStore(join(agentDir, CALIBRATION_FILE_NAME), nodeFiles);
		const calibrationWarning = calibration.load();
		if (calibrationWarning) warnings.push(calibrationWarning);
		for (const warning of warnings) ctx.ui.notify(warning, "warning");

		const rt: Runtime = {
			config,
			calibration,
			meter: new Measurement(monotonicClock),
			ticker: new Ticker(scheduleInterval, config.animation.intervalMs, () => publish(rt, rt.tickUi)),
			writer: new StatusWriter(),
			tui: ctx.mode === "tui",
			visible: config.enabled,
			mode: config.summaryMode,
			records: [],
			activeModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
			liveThresholds: config.thresholds,
			tickUi: undefined,
			unsubscribeRequest: pi.events.on(REQUEST_CHANNEL, () => {
				if (runtime === rt) pi.events.emit(STATUS_CHANNEL, snapshotOf(rt));
			}),
		};
		runtime = rt;
		rebuild(rt, ctx);
		publish(rt, ctx.ui);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const rt = runtime;
		if (!rt) return;
		runtime = undefined;
		stopLive(rt);
		rt.meter.reset();
		rt.unsubscribeRequest();
		if (rt.tui) ctx.ui.setStatus(STATUS_KEY, undefined);
		pi.events.emit(STATUS_CHANNEL, null);
	});

	pi.on("session_tree", (_event, ctx) => {
		const rt = runtime;
		if (!rt) return;
		if (rt.config.persist) rebuild(rt, ctx);
		publish(rt, ctx.ui);
	});

	pi.on("model_select", (event) => {
		if (runtime) runtime.activeModel = { provider: event.model.provider, id: event.model.id };
	});

	pi.on("turn_start", (_event, ctx) => {
		const rt = runtime;
		if (!rt) return;
		const dropped = rt.meter.active;
		rt.meter.turnStart();
		if (dropped) {
			stopLive(rt);
			publish(rt, ctx.ui);
		}
	});

	pi.on("turn_end", (_event, ctx) => {
		const rt = runtime;
		if (rt?.meter.turnEnd()) {
			stopLive(rt);
			publish(rt, ctx.ui);
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		const rt = runtime;
		if (!rt) return;
		const dropped = rt.meter.reset();
		stopLive(rt);
		if (dropped) publish(rt, ctx.ui);
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
		rt.tickUi = ctx.ui;
		rt.ticker.start();
		publish(rt, ctx.ui);
	});

	pi.on("after_provider_response", () => {
		runtime?.meter.responseHeaders();
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") runtime?.meter.messageStart();
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
		stopLive(rt);
		if (outcome.kind === "recorded") {
			const { record } = outcome;
			rt.records.push(record);
			if (rt.config.persist) pi.appendEntry(TELEMETRY_CUSTOM_TYPE, record);
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
