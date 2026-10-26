import { randomUUID } from "node:crypto";
import { type HttpResult, postJson, redact, statusError } from "../clients/http.ts";
import { asRecord, asString, field, records } from "../json.ts";
import {
	type FetchRequest,
	type ProviderEntry,
	ProviderError,
	type ProviderFetchResult,
	type ProviderSearchResult,
	type RunContext,
	type SearchHit,
	type SearchRequest,
} from "../types.ts";
import { bearerHeaders, endpoint, excludedHosts, hostsOf, mergeHeaders, nonEmpty, recencyDays } from "./common.ts";
import { locationOption, type ProviderDefinition, userLocation } from "./options.ts";

/** The most `open` windows one fetch requests, as a guard against a page that never reports its end. */
const MAX_WINDOWS = 40;

/** Private markers the endpoint puts into its text (`citeturn0view0`). */
const MARKERS = /[^]*/g;
/** Link markup `【id†text†host】` or `【id†text】`, reduced to its text. */
const LINK = /【\d+†([^†】]*)(?:†[^】]*)?】/g;
const LINE = /^L(\d+)(?:@P(\d+))?: ?(.*)$/;

async function post(
	entry: ProviderEntry,
	run: RunContext,
	commands: Record<string, unknown>,
	settings?: Record<string, unknown>,
): Promise<HttpResult> {
	const { credentials } = run;
	const result = await postJson({
		url: endpoint(credentials.baseUrl, "alpha/search"),
		body: { id: randomUUID(), model: entry.model, commands, ...(settings ? { settings } : {}) },
		headers: mergeHeaders(bearerHeaders(credentials.apiKey, credentials.headers), { originator: "codex_cli_rs" }),
		signal: run.signal,
		secrets: credentials.secrets,
	});
	if (result.status < 200 || result.status >= 300) {
		const code = asString(field(field(result.json, "error"), "code"));
		const error = statusError(result, credentials.secrets);
		throw code
			? new ProviderError(
					redact(`${result.status} ${code}: ${error.message.replace(/^\d+ /, "")}`, credentials.secrets),
				)
			: error;
	}
	return result;
}

interface Window {
	title?: string;
	finalUrl?: string;
	crawledAt?: string;
	totalLines?: number;
	lines: Map<number, { page?: number; text: string }>;
}

function cleanText(text: string): string {
	return text.replace(MARKERS, "").replace(LINK, "$1");
}

/** Parses one `open` output: the header (title, URL, crawl age, total lines) and the numbered lines. */
function parseWindow(output: string): Window {
	const window: Window = { lines: new Map() };
	const header: string[] = [];
	let last: { page?: number; text: string } | undefined;
	for (const line of output.replace(/\n$/, "").split("\n")) {
		const match = line.match(LINE);
		if (match) {
			const page = match[2] === undefined ? undefined : Number(match[2]);
			last = { ...(page === undefined ? {} : { page }), text: cleanText(match[3] ?? "") };
			window.lines.set(Number(match[1]), last);
		} else if (last) {
			last.text += `\n${cleanText(line)}`;
		} else {
			header.push(line);
		}
	}
	const titleLine = header[0]?.match(/^(.*) \((https?:\/\/[^\s)]+)\)\s*$/);
	if (titleLine) {
		const title = titleLine[1]?.trim();
		if (title) window.title = title;
		if (titleLine[2]) window.finalUrl = titleLine[2];
	}
	const meta = header.slice(1).join(" ");
	const crawled = meta.match(/Crawled: ([^;]+);/)?.[1]?.trim();
	if (crawled) window.crawledAt = crawled;
	const total = meta.match(/Total lines: (\d+)/)?.[1];
	if (total !== undefined) window.totalLines = Number(total);
	return window;
}

/** The reason an `Internal Error ()` output gives for a failed `open`. */
function openFailure(output: string): string {
	const line = output.match(/^L0: (.*)$/m)?.[1] ?? output.split("\n")[0] ?? "";
	const fetchFailure = line.match(/^Failed to fetch .*: \((\d+)\) (.*)$/);
	if (fetchFailure) return `${fetchFailure[1]} ${fetchFailure[2]?.trim()}`;
	if (line.includes("is not accessible via this tool")) return "not indexed";
	if (line.includes("invalid ref_id")) return "invalid ref";
	return line.trim() || "open failed";
}

function rebuild(lines: Window["lines"]): string {
	const out: string[] = [];
	let page: number | undefined;
	for (const [, line] of [...lines.entries()].sort(([a], [b]) => a - b)) {
		if (line.page !== undefined && line.page !== page) {
			page = line.page;
			out.push(`## Page ${page + 1}`);
		}
		out.push(line.text);
	}
	return out.join("\n");
}

export const sub2apiSearch: ProviderDefinition = {
	requires: ["provider", "model"],
	defaults: { timeoutMs: 60_000 },
	options: { userLocation: locationOption },
	create: (entry) => ({
		search: { domains: "hard", maxCount: 0, recency: true, content: false },
		fetchExtraction: "verbatim",
		async runSearch(request: SearchRequest, run: RunContext): Promise<ProviderSearchResult> {
			const query = {
				q: request.query,
				recency: request.recency ? recencyDays(request.recency) : undefined,
				domains: nonEmpty(hostsOf(request.domains)),
			};
			const blocked = nonEmpty(excludedHosts(request.excludeDomains));
			const location = userLocation(entry);
			const settings =
				blocked || location
					? { filters: blocked ? { blocked_domains: blocked } : undefined, user_location: location }
					: undefined;
			const result = await post(entry, run, { search_query: [query], response_length: "short" }, settings);
			const body = asRecord(result.json);
			const output = asString(field(body, "output")) ?? "";
			if (output.startsWith("Empty search results")) return { results: [], warnings: [] };
			if (output.startsWith("Internal Error ()"))
				throw new ProviderError(redact(openFailure(output), run.credentials.secrets));
			const results: SearchHit[] = records(field(body, "results")).flatMap((item) => {
				const url = asString(field(item, "url"));
				if (asString(field(item, "type")) !== "text_result" || !url) return [];
				return [
					{
						title: asString(field(item, "title")) || url,
						url,
						snippet: cleanText(asString(field(item, "snippet")) ?? ""),
					},
				];
			});
			return { results, warnings: [] };
		},
		async runFetch(request: FetchRequest, run: RunContext): Promise<ProviderFetchResult> {
			const wanted = request.offset + request.maxChars;
			const lines: Window["lines"] = new Map();
			let first: Window | undefined;
			let lineno: number | undefined;
			let complete = false;
			for (let windows = 0; windows < MAX_WINDOWS; windows++) {
				const open = { ref_id: request.url, ...(lineno === undefined ? {} : { lineno }) };
				const result = await post(entry, run, { open: [open], response_length: "long" });
				const output = asString(field(result.json, "output")) ?? "";
				if (output.startsWith("Internal Error ()"))
					throw new ProviderError(redact(openFailure(output), run.credentials.secrets));
				const window = parseWindow(output);
				first ??= window;
				const before = lines.size;
				for (const [number, line] of window.lines) if (!lines.has(number)) lines.set(number, line);
				const highest = Math.max(-1, ...lines.keys());
				const total = window.totalLines ?? first.totalLines;
				if (total === undefined || highest >= total - 1) {
					complete = true;
					break;
				}
				// A window past the end repeats the last one; nothing new means the page has ended.
				if (lines.size === before) {
					complete = true;
					break;
				}
				if (rebuild(lines).length >= wanted) break;
				lineno = highest + 1;
			}
			return {
				content: rebuild(lines),
				complete,
				extraction: "verbatim",
				...(first?.title ? { title: first.title } : {}),
				...(first?.finalUrl ? { finalUrl: first.finalUrl } : {}),
				...(first?.crawledAt ? { crawledAt: first.crawledAt } : {}),
				warnings: [],
			};
		},
	}),
};
