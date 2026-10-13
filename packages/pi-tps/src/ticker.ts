/** Schedules a repeating callback and returns a function that cancels it. */
export type ScheduleInterval = (callback: () => void, intervalMs: number) => () => void;

export const scheduleInterval: ScheduleInterval = (callback, intervalMs) => {
	const handle = setInterval(callback, intervalMs);
	// The readout must never keep a print-mode process alive.
	handle.unref();
	return () => clearInterval(handle);
};

/** One throttled timer that drives the readout while a request is in flight. Idle means no timer at all. */
export class Ticker {
	private cancel: (() => void) | undefined;
	private frame = 0;

	constructor(
		private readonly schedule: ScheduleInterval,
		private readonly intervalMs: number,
		private readonly onTick: (frame: number) => void,
	) {}

	get running(): boolean {
		return this.cancel !== undefined;
	}

	/** Frame index of the spinner; advances once per tick. */
	get currentFrame(): number {
		return this.frame;
	}

	start(): void {
		if (this.cancel) return;
		this.frame = 0;
		this.cancel = this.schedule(() => {
			this.frame++;
			this.onTick(this.frame);
		}, this.intervalMs);
	}

	stop(): void {
		this.cancel?.();
		this.cancel = undefined;
	}
}
