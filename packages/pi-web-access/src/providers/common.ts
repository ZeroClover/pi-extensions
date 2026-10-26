import { siteHost, sitePath } from "../sites.ts";
import type { Recency } from "../types.ts";

const RECENCY_DAYS: Record<Recency, number> = { day: 1, week: 7, month: 30, year: 365 };

export function recencyDays(recency: Recency): number {
	return RECENCY_DAYS[recency];
}

/** The UTC date `recency` before now, as `YYYY-MM-DD`. */
export function recencyDate(recency: Recency, now: Date = new Date()): string {
	return new Date(now.getTime() - recencyDays(recency) * 86_400_000).toISOString().slice(0, 10);
}

/** The distinct hostnames of site patterns (`go.dev/doc` → `go.dev`), without suffix patterns. */
export function hostsOf(sites: readonly string[]): string[] {
	const hosts: string[] = [];
	for (const site of sites) {
		const host = siteHost(site);
		if (host !== "" && !host.startsWith(".") && !hosts.includes(host)) hosts.push(host);
	}
	return hosts;
}

/**
 * The hostnames of exclusions without a path. A backend that excludes whole hosts would otherwise drop every page of
 * `go.dev` for an exclusion of `go.dev/doc/install`; path exclusions are left to the search tool's result filter.
 */
export function excludedHosts(sites: readonly string[]): string[] {
	return hostsOf(sites.filter((site) => sitePath(site) === ""));
}

/** The date part of an ISO 8601 date-time, when the text starts with one. */
export function isoDate(text: string | undefined): string | undefined {
	const match = text?.match(/^\d{4}-\d{2}-\d{2}/);
	return match?.[0];
}

/** Joins a base URL and a path without doubling slashes. */
export function endpoint(base: string, path: string): string {
	return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** The list, or undefined when it is empty, so that JSON bodies leave the field out. */
export function nonEmpty<T>(list: readonly T[]): T[] | undefined {
	return list.length > 0 ? [...list] : undefined;
}

/** Merges header records case-insensitively; later records win. */
export function mergeHeaders(...records: Record<string, string>[]): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const record of records) for (const [name, value] of Object.entries(record)) merged[name.toLowerCase()] = value;
	return merged;
}

/** Headers carrying the bearer key, then the extra headers Pi resolved (which may carry the key themselves). */
export function bearerHeaders(apiKey: string | undefined, headers: Record<string, string>): Record<string, string> {
	return mergeHeaders(apiKey ? { authorization: `Bearer ${apiKey}` } : {}, headers);
}
