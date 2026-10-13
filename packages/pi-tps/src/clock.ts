/** Monotonic time source in milliseconds. Injected so the measurement core can be tested with synthetic timelines. */
export interface Clock {
	now(): number;
}

export const monotonicClock: Clock = {
	now: () => performance.now(),
};
