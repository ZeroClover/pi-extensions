/** A gap of at least this length between two consecutive output deltas is a stall (excluded from the output span). */
export const STALL_GAP_MS = 500;

/** Live TPS is computed over this trailing window. */
export const LIVE_WINDOW_MS = 5000;

/** Live TPS stays unavailable until the window holds this much counted generation time. */
export const LIVE_MIN_COUNTED_MS = 1500;

/** A settled TPS needs at least this much generation time; shorter spans are too noisy to report. */
export const MIN_SETTLED_SPAN_MS = 1000;

/** Deltas closer than this to their predecessor arrived in the same network read and form one batch. */
export const BURST_BATCH_GAP_MS = 1;

/** Burst criterion: fewer arrival batches than this, for a response of at least {@link BURST_MIN_TOKENS}. */
export const BURST_MIN_BATCHES = 5;

/** Below this many output tokens, a response in few batches is too short to measure rather than buffered. */
export const BURST_MIN_TOKENS = 50;

/** Burst criterion: width of the window searched for a token cluster. */
export const BURST_CLUSTER_WINDOW_MS = 100;

/** Burst criterion: share of all estimated tokens that one cluster window must carry. */
export const BURST_CLUSTER_SHARE = 0.5;

/** The cluster criterion only applies when the stream lasted longer than this. */
export const BURST_CLUSTER_MIN_SPAN_MS = 1000;

/** Burst criterion: any computed generation rate above this is not real streaming. */
export const MAX_PLAUSIBLE_TPS = 10_000;

/** A model's first samples of a metric form their plain mean, so a slow cold start does not anchor the average. */
export const AVERAGE_WARMUP_SAMPLES = 10;

/** Weight of the newest sample in a model's moving average after the warm-up: a memory of about 20 requests. */
export const AVERAGE_ALPHA = 0.1;

/** After the warm-up a sample is clamped to between the average divided by this and the average times this. */
export const AVERAGE_CLAMP_FACTOR = 3;

/** Weight of the newest sample in the calibration moving average. */
export const CALIBRATION_ALPHA = 0.3;

/** Lower clamp of the calibration ratio. */
export const CALIBRATION_MIN_RATIO = 0.25;

/** Upper clamp of the output calibration ratio. */
export const CALIBRATION_MAX_OUTPUT_RATIO = 4;

/** Upper clamp of the thinking calibration ratio: a summary is up to two orders of magnitude shorter than its reasoning. */
export const CALIBRATION_MAX_THINKING_RATIO = 100;

/** Requests whose raw estimate is not above this are too small to calibrate from. */
export const CALIBRATION_MIN_ESTIMATE = 50;

/** An open trailing segment longer than this is committed in chunks, bounding the work per delta. */
export const ESTIMATOR_MAX_OPEN_CHARS = 512;

/** Size of the chunks committed from an over-long open segment; each commit costs at most one token of rounding. */
export const ESTIMATOR_COMMIT_CHARS = 256;

/** A difference above this between Pi's `durationMs` and the measured elapsed time is recorded. */
export const CLOCK_SKEW_THRESHOLD_MS = 250;

/** Default refresh interval of the ticker while a request is in flight. */
export const DEFAULT_TICK_INTERVAL_MS = 100;

/** Smallest accepted ticker interval. */
export const MIN_TICK_INTERVAL_MS = 50;

/** Largest accepted ticker interval; beyond it the readout would lag and Node clamps huge values to 1 ms. */
export const MAX_TICK_INTERVAL_MS = 1000;

/** Key under which the readout is written with `ctx.ui.setStatus`. */
export const STATUS_KEY = "pi-tps";
