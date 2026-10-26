import type { WebAccessConfig } from "./config.ts";
import { errorMessage } from "./json.ts";
import { siteMatchesSite, siteMatchesUrl } from "./sites.ts";
import { type Attempt, type Capability, type ProviderEntry, ProviderError, ProviderSkip } from "./types.ts";

/** What a call targets: the domain entries of a search, or the URL of a fetch. */
export type Target = { capability: "search"; domains: readonly string[] } | { capability: "fetch"; url: URL };

export interface Plan {
	chain: ProviderEntry[];
	/** The rule that selected the chain, if any. */
	rule?: string;
	/** Whether a failure moves on to the next provider; false for a per-call override. */
	fallback: boolean;
}

function matches(sites: readonly string[], target: Target): boolean {
	if (target.capability === "fetch") return sites.some((site) => siteMatchesUrl(site, target.url));
	return sites.some((site) => target.domains.some((entry) => siteMatchesSite(site, entry)));
}

/**
 * The providers to try, in order. A per-call override names the only provider; otherwise the chain the first
 * matching rule has for the capability, otherwise the default chain. `override` must name a configured provider.
 */
export function planChain(config: WebAccessConfig, target: Target, override?: string): Plan {
	const byName = new Map(config.providers.map((entry) => [entry.name, entry]));
	const resolve = (names: readonly string[]): ProviderEntry[] =>
		names.flatMap((name) => {
			const entry = byName.get(name);
			return entry ? [entry] : [];
		});
	if (override !== undefined) return { chain: resolve([override]), fallback: false };
	const capability: Capability = target.capability;
	// The first rule whose sites match decides; without a chain for this capability it leaves the default in force.
	const rule = config.rules.find((candidate) => matches(candidate.sites, target));
	const chain = rule?.[capability];
	if (rule && chain) return { chain: resolve(chain), rule: rule.name, fallback: true };
	return { chain: resolve(config[capability]), fallback: true };
}

/** One attempt's result: `ok` stops the chain; `empty` records the attempt and moves on, keeping the value. */
export type AttemptResult<T> = { outcome: "ok" | "empty"; value: T };

export interface ChainResult<T> {
	value: T;
	provider: string;
	attempts: Attempt[];
}

export interface RunOptions {
	signal: AbortSignal | undefined;
	onProgress?: (message: string) => void;
}

/** Thrown when every provider failed; the message lists each provider with its reason. */
export class ChainError extends Error {
	constructor(
		message: string,
		readonly attempts: Attempt[],
	) {
		super(message);
	}
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("This operation was aborted");
}

/**
 * Tries each provider in turn. Each attempt runs under the call's signal combined with the provider's `timeoutMs`;
 * a ProviderSkip is recorded as `skipped`, any other failure as `error`. An abort of the call stops the chain.
 */
export async function runChain<T>(
	plan: Plan,
	attempt: (entry: ProviderEntry, signal: AbortSignal) => Promise<AttemptResult<T>>,
	options: RunOptions,
): Promise<ChainResult<T>> {
	const attempts: Attempt[] = [];
	let lastEmpty: { value: T; provider: string } | undefined;
	for (const [index, entry] of plan.chain.entries()) {
		if (options.signal?.aborted) throw abortError(options.signal);
		const timeout = AbortSignal.timeout(entry.timeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		const started = performance.now();
		const elapsed = (): number => Math.round(performance.now() - started);
		let failure: Attempt;
		try {
			const result = await attempt(entry, signal);
			attempts.push({ provider: entry.name, outcome: result.outcome, latencyMs: elapsed() });
			if (result.outcome === "ok") return { value: result.value, provider: entry.name, attempts };
			lastEmpty = { value: result.value, provider: entry.name };
			continue;
		} catch (error) {
			if (options.signal?.aborted) throw abortError(options.signal);
			if (error instanceof ProviderSkip) {
				failure = { provider: entry.name, outcome: "skipped", reason: error.message };
			} else {
				const reason = timeout.aborted
					? `timeout after ${entry.timeoutMs} ms`
					: error instanceof ProviderError
						? error.message
						: `unexpected error: ${errorMessage(error)}`;
				failure = { provider: entry.name, outcome: "error", reason, latencyMs: elapsed() };
			}
		}
		attempts.push(failure);
		if (!plan.fallback) break;
		const next = plan.chain[index + 1];
		if (next) options.onProgress?.(`${entry.name} failed (${failure.reason}); trying ${next.name}`);
	}
	if (lastEmpty) return { ...lastEmpty, attempts };
	const lines = attempts.map((entry) => `${entry.provider}: ${entry.outcome} (${entry.reason ?? "no reason"})`);
	const message =
		plan.fallback && attempts.length > 1
			? `every provider failed:\n${lines.join("\n")}`
			: `provider ${attempts[0]?.provider ?? "?"} failed: ${attempts[0]?.reason ?? "no reason"}`;
	throw new ChainError(message, attempts);
}
