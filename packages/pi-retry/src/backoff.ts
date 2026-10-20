import type { Classification } from "./classify.ts";
import type { RetryConfig } from "./config.ts";
import { HINT_GRACE_MS } from "./hints.ts";

/** Uniform in [0, 1), like `Math.random`; injected so tests can pin the jitter. */
export type Random = () => number;

/**
 * `min(baseDelayMs × 2^(attempt−1), maxBackoffMs)` scaled by a jitter factor in [0.75, 1.0]; `attempt` is 1 for the
 * first retry.
 */
export function backoffDelay(
	config: Pick<RetryConfig, "baseDelayMs" | "maxBackoffMs">,
	attempt: number,
	random: Random,
): number {
	const exponential = config.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const capped = Math.min(exponential, config.maxBackoffMs);
	return Math.round(capped * (0.75 + 0.25 * random()));
}

/** An accepted hint is waited exactly, plus the grace, without jitter or cap; otherwise backoff applies. */
export function retryDelay(
	classification: Pick<Classification, "hint">,
	config: Pick<RetryConfig, "baseDelayMs" | "maxBackoffMs">,
	attempt: number,
	random: Random,
): number {
	return classification.hint ? classification.hint.delayMs + HINT_GRACE_MS : backoffDelay(config, attempt, random);
}
