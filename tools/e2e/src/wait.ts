/**
 * Polls `condition` until it returns a value other than `undefined` or `false`, and returns that value. Fails after
 * `timeoutMs` with `what` in the message, so a scenario that never reaches a state reports which state.
 */
export async function waitFor<T>(what: string, condition: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const value = condition();
		if (value !== undefined && value !== false) return value;
		if (performance.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
