import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { ChainError, planChain, runChain } from "./routing.ts";
import { parseUrl } from "./sites.ts";
import type { WebAccessState } from "./state.ts";
import { ATTEMPT_OUTCOMES, ProviderError, type ProviderFetchResult } from "./types.ts";

const DEFAULT_MAX_CHARS = 20_000;

const parameters = Type.Object({
	url: Type.String({ description: "http or https URL" }),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character position to start from, default 0" })),
	maxChars: Type.Optional(
		Type.Integer({ minimum: 1000, maximum: 100_000, description: "Characters to return, default 20000" }),
	),
	provider: Type.Optional(Type.String({ description: "Configured provider name; only when the user asks for one" })),
});

const outputSchema = Type.Object({
	provider: Type.String(),
	url: Type.String(),
	finalUrl: Type.Optional(Type.String()),
	title: Type.Optional(Type.String()),
	content: Type.String(),
	extraction: StringEnum(["verbatim", "model"]),
	totalChars: Type.Optional(Type.Number()),
	truncated: Type.Boolean(),
	nextOffset: Type.Optional(Type.Number()),
	crawledAt: Type.Optional(Type.String()),
	attempts: Type.Array(
		Type.Object({
			provider: Type.String(),
			outcome: StringEnum(ATTEMPT_OUTCOMES),
			reason: Type.Optional(Type.String()),
			latencyMs: Type.Optional(Type.Number()),
		}),
	),
	warnings: Type.Array(Type.String()),
	costUsd: Type.Optional(Type.Number()),
	latencyMs: Type.Number(),
});

type FetchOutput = Static<typeof outputSchema>;

/** Cuts the window `offset … offset + maxChars` out of the provider's text and describes what remains. */
function window(page: ProviderFetchResult, offset: number, maxChars: number, warnings: string[]) {
	const text = page.content;
	// A model's rendition has its own length, not the page's.
	const totalChars = page.complete && page.extraction === "verbatim" ? text.length : undefined;
	if (offset >= text.length) {
		warnings.push(`offset ${offset} is past the end of the page (${text.length} characters)`);
		return { content: "", truncated: false, ...(totalChars === undefined ? {} : { totalChars }) };
	}
	const content = text.slice(offset, offset + maxChars);
	const nextOffset = offset + content.length;
	const truncated = nextOffset < text.length || !page.complete;
	if (truncated) {
		warnings.push(`the page continues; call web_fetch again with offset ${nextOffset} for the next part`);
	}
	return {
		content,
		truncated,
		...(truncated ? { nextOffset } : {}),
		...(totalChars === undefined ? {} : { totalChars }),
	};
}

function render(output: FetchOutput, offset: number): string {
	const size = output.totalChars === undefined ? "" : ` of ${output.totalChars}`;
	const range =
		output.content.length === 0 ? "no content" : `characters ${offset}-${offset + output.content.length}${size}`;
	const crawled = output.crawledAt ? `, crawled ${output.crawledAt}` : "";
	const title = output.title ? `${output.title} - ` : "";
	const lines = [
		`${title}${output.finalUrl ?? output.url} via ${output.provider} (${output.extraction}${crawled}), ${range}`,
	];
	if (output.content) lines.push("", output.content);
	if (output.warnings.length > 0) lines.push("", ...output.warnings.map((warning) => `Note: ${warning}`));
	return lines.join("\n");
}

export function createFetchTool(state: WebAccessState) {
	return defineTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: "Read a web page as markdown or text through the configured providers; long pages continue by offset.",
		promptSnippet: "web_fetch: read a URL as text; continue long pages with nextOffset",
		parameters,
		outputSchema,
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const started = performance.now();
			const url = parseUrl(params.url.trim());
			if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
				throw new Error("only http and https URLs are supported");
			}
			if (params.provider !== undefined && !state.entry(params.provider)) {
				const names = state.config.providers.map((entry) => entry.name);
				throw new Error(`unknown provider "${params.provider}"; configured providers: ${names.join(", ") || "(none)"}`);
			}
			const plan = planChain(state.config, { capability: "fetch", url }, params.provider);
			if (plan.chain.length === 0) {
				throw new Error(`no fetch provider is configured; add providers to ${state.displayPath()}`);
			}
			const offset = params.offset ?? 0;
			const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;
			try {
				const outcome = await runChain(
					plan,
					async (entry, attemptSignal) => {
						const credentials = await state.resolveCredentials(entry, ctx.modelRegistry, attemptSignal);
						const page = await state
							.adapter(entry)
							.runFetch({ url: url.toString(), offset, maxChars }, { credentials, signal: attemptSignal });
						if (page.content.trim() === "") throw new ProviderError("no text returned");
						// A provider that stopped before the requested offset, without reaching the end of the page,
						// cannot serve this window; another provider may.
						if (offset >= page.content.length && !page.complete) {
							throw new ProviderError(
								`could not reach offset ${offset} (the provider returned ${page.content.length} characters of a longer page)`,
							);
						}
						return { outcome: "ok", value: page };
					},
					{
						signal,
						onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: undefined }),
					},
				);
				const page = outcome.value;
				const warnings = [...page.warnings];
				if (page.extraction === "model") {
					warnings.push(
						`${outcome.provider}: the content is a model's rendition of the page and may be incomplete or inexact`,
					);
				}
				const output: FetchOutput = {
					provider: outcome.provider,
					url: url.toString(),
					...(page.finalUrl ? { finalUrl: page.finalUrl } : {}),
					...(page.title ? { title: page.title } : {}),
					...window(page, offset, maxChars, warnings),
					extraction: page.extraction,
					...(page.crawledAt ? { crawledAt: page.crawledAt } : {}),
					attempts: outcome.attempts,
					warnings,
					...(page.costUsd === undefined ? {} : { costUsd: page.costUsd }),
					latencyMs: Math.round(performance.now() - started),
				};
				return {
					content: [{ type: "text", text: render(output, offset) }],
					structuredContent: output,
					details: undefined,
				};
			} catch (error) {
				if (error instanceof ChainError || error instanceof ProviderError)
					throw new Error(`web_fetch: ${error.message}`);
				throw error;
			}
		},
	});
}
