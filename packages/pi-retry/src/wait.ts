/** `cancel` ends the wait without retrying; `proceed` ends it early and retries now. */
export type StopSignal = "cancel" | "proceed";

export type WaitOutcome = "completed" | "cancelled" | "proceed";

export interface WaitOptions {
	/** Asked after every slice; a signal ends the wait. */
	shouldStop: () => StopSignal | undefined;
	/** Called before the first slice and after every slice that does not end the wait, with the time left. */
	onTick: (remainingMs: number) => void;
	/** Clock in milliseconds; injected for tests. */
	now?: () => number;
	/** Aborting it ends the current slice at once, so a stop request does not wait for the slice to run out. */
	wake?: AbortSignal;
}

/** The longest slice: stop requests and the countdown are observed at least this often. */
export const SLICE_MS = 1000;

function sleep(ms: number, wake: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (wake?.aborted) {
			resolve();
			return;
		}
		const onWake = (): void => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			wake?.removeEventListener("abort", onWake);
			resolve();
		}, ms);
		wake?.addEventListener("abort", onWake, { once: true });
	});
}

/**
 * Waits `delayMs` in slices of at most one second. Each slice is a single timer that has fired or been cleared by
 * the time the next one starts, so no timer outlives the wait.
 */
export async function waitFor(delayMs: number, options: WaitOptions): Promise<WaitOutcome> {
	const now = options.now ?? Date.now;
	const endsAt = now() + delayMs;
	for (;;) {
		const signal = options.shouldStop();
		if (signal === "cancel") return "cancelled";
		if (signal === "proceed") return "proceed";
		const remaining = endsAt - now();
		if (remaining <= 0) return "completed";
		options.onTick(remaining);
		await sleep(Math.min(SLICE_MS, remaining), options.wake);
	}
}
