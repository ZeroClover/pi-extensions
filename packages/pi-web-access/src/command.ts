import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { WebAccessState } from "./state.ts";

function capabilities(state: WebAccessState, name: string): string {
	const entry = state.entry(name);
	if (!entry) return "";
	const { search, fetchExtraction } = state.adapter(entry);
	const searchParts = [`domains ${search.domains}`, search.recency ? "recency" : "", search.content ? "content" : ""];
	return `search (${searchParts.filter((part) => part !== "").join(", ")}), fetch (${fetchExtraction})`;
}

/** The `/web-access` report: providers with capabilities and credential status, chains, and rules; no secrets. */
export function renderStatus(state: WebAccessState, registry: ModelRegistry): string {
	const path = state.displayPath();
	const { providers, search, fetch, rules } = state.config;
	if (providers.length === 0) {
		const reason = state.found ? "it declares no usable provider" : "the file does not exist";
		return `pi-web-access: no provider is configured; expected configuration file: ${path} (${reason})`;
	}
	const lines = [`pi-web-access: ${path}`, "providers:"];
	for (const entry of providers) {
		const source = entry.apiKey !== undefined ? "key from apiKey" : `Pi provider ${entry.provider}`;
		lines.push(
			`  ${entry.name} (${entry.type}${entry.model ? `, ${entry.model}` : ""}; ${source}): ${state.credentialStatus(entry, registry)}`,
			`    ${capabilities(state, entry.name)}; timeout ${entry.timeoutMs} ms`,
		);
	}
	lines.push(`search chain: ${search.join(", ") || "(none)"}`, `fetch chain: ${fetch.join(", ") || "(none)"}`);
	lines.push(rules.length === 0 ? "rules: (none)" : "rules:");
	for (const rule of rules) {
		const chains = [
			rule.search ? `search: ${rule.search.join(", ")}` : "",
			rule.fetch ? `fetch: ${rule.fetch.join(", ")}` : "",
		];
		lines.push(`  ${rule.name}: ${rule.sites.join(", ")} -> ${chains.filter((part) => part !== "").join("; ")}`);
	}
	lines.push("Edits to the file take effect after /reload or in a new session.");
	return lines.join("\n");
}
