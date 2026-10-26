import type { AssistantMessageDiagnostic } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { failure, type Pi } from "../../../tools/e2e/src/index.ts";
import { notices, startRetry } from "./fixtures.ts";

let pi: Pi | undefined;

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
});

interface Row {
	/** Where the text comes from: the provider, gateway, or adapter that produces it. */
	source: string;
	text: string;
	/** With `maxRetries: 0`, a retryable failure gives up at once and a non-retryable one is not retried. */
	decision: "giving up after 0 retries" | "not retrying";
	category: string;
	/** Diagnostics the adapter attaches to the failed message. */
	diagnostics?: AssistantMessageDiagnostic[];
}

const retried = "giving up after 0 retries";
const stopped = "not retrying";

/** Real provider error texts: one per category and per provider family, then the documented precedence traps. */
const ROWS: Row[] = [
	// Anthropic
	{
		source: "Anthropic",
		text: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your organization\'s rate limit"}}',
		decision: retried,
		category: "rate_limit",
	},
	{
		source: "Anthropic",
		text: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
		decision: retried,
		category: "overloaded",
	},
	{
		source: "Anthropic",
		text: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
		decision: stopped,
		category: "auth",
	},
	{
		source: "Anthropic (Pi's adapter)",
		text: "Anthropic stream ended before message_stop",
		decision: retried,
		category: "transport",
	},
	// OpenAI
	{
		source: "OpenAI",
		text: "404 The model `gpt-9` does not exist or you do not have access to it.",
		decision: stopped,
		category: "not_found",
	},
	{
		source: "OpenAI",
		text: "400 Your request was rejected as a result of our safety system. content_policy_violation",
		decision: stopped,
		category: "content_policy",
	},
	{
		source: "OpenAI",
		text: "An error occurred while processing your request. You can retry your request, or contact us through our help center.",
		decision: retried,
		category: "server_error",
	},
	// Google and gRPC
	{
		source: "Google (gRPC DEADLINE_EXCEEDED)",
		text: '504 {"error":{"code":504,"message":"Deadline expired before operation could complete.","status":"DEADLINE_EXCEEDED"}}',
		decision: retried,
		category: "timeout",
	},
	{
		source: "Google (gRPC INVALID_ARGUMENT)",
		text: '400 {"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}',
		decision: stopped,
		category: "invalid_request",
	},
	{
		source: "Google per-minute quota",
		text: "429 Quota exceeded for quota metric 'Generate requests per minute'",
		decision: retried,
		category: "rate_limit",
	},
	// Bedrock (Pi's prefixes)
	{
		source: "Bedrock",
		text: "Throttling error: Too many tokens, please wait before trying again.",
		decision: retried,
		category: "rate_limit",
	},
	{
		source: "Bedrock",
		text: "AccessDeniedException: You don't have access to the model with the specified model ID.",
		decision: stopped,
		category: "auth",
	},
	// Mistral, OpenRouter
	{
		source: "Mistral",
		text: 'Mistral API error (429): {"object":"error","message":"Requests rate limit exceeded","type":"rate_limited","code":"1300"}',
		decision: retried,
		category: "rate_limit",
	},
	{ source: "OpenRouter", text: "Provider returned error", decision: retried, category: "server_error" },
	// LiteLLM proxy
	{
		source: "LiteLLM",
		text: 'litellm.RateLimitError: AnthropicException - {"type":"error","error":{"type":"rate_limit_error"}}',
		decision: retried,
		category: "rate_limit",
	},
	{
		source: "LiteLLM",
		text: "litellm.APIConnectionError: Connection error.",
		decision: retried,
		category: "transport",
	},
	{
		source: "LiteLLM",
		text: "litellm.BudgetExceededError: Budget has been exceeded! Current cost: 10.5, Max budget: 10.0",
		decision: stopped,
		category: "quota",
	},
	// Subscription and ChatGPT usage limits
	{
		source: "ChatGPT subscription (Pi's Codex adapter)",
		text: "You have hit your ChatGPT usage limit (plus plan). Try again in ~12 min.",
		decision: retried,
		category: "quota",
	},
	{
		source: "Codex 429 without resets_at (Pi's Codex adapter)",
		text: "You have hit your ChatGPT usage limit (plus plan).",
		decision: retried,
		category: "rate_limit",
	},
	{
		source: "Codex 429 without a plan (Pi's Codex adapter)",
		text: "You have hit your ChatGPT usage limit.",
		decision: retried,
		category: "rate_limit",
	},
	{
		source: "Codex 429 resetting in under 30 s (Pi's Codex adapter)",
		text: "You have hit your ChatGPT usage limit (plus plan). Try again in ~0 min.",
		decision: retried,
		category: "rate_limit",
	},
	{
		source: "Codex 429 over SSE after a WebSocket fallback (Pi's Codex adapter)",
		text: "You have hit your ChatGPT usage limit.",
		diagnostics: [
			{
				type: "provider_transport_failure",
				timestamp: 0,
				error: { message: "connect ECONNREFUSED 127.0.0.1:443", code: "ECONNREFUSED" },
			},
		],
		decision: retried,
		category: "rate_limit",
	},
	{
		source: "OpenCode Go subscription",
		text: '429 {"type":"error","error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached"}}',
		decision: stopped,
		category: "quota",
	},
	// Node transport
	{ source: "Node fetch", text: "fetch failed", decision: retried, category: "transport" },
	// Pi 1.4 additions to its retryable list
	{
		source: "proxy wrapping the Codex CLI",
		text: "stream disconnected before completion: stream closed before response.completed",
		decision: retried,
		category: "transport",
	},
	{
		source: "gateway response.failed",
		text: "The stream was interrupted before the response completed",
		decision: retried,
		category: "transport",
	},
	{ source: "gateway response.failed", text: "HTTP/2 stream failed", decision: retried, category: "transport" },
	{
		source: "node-fetch (google-vertex ADC token refresh)",
		text: "request to https://oauth2.googleapis.com/token failed, reason: ",
		decision: retried,
		category: "transport",
	},
	{
		source: "gateway response.failed code",
		text: "upstream_request_failed: Upstream request failed",
		decision: retried,
		category: "server_error",
	},
	{
		source: "gateway response.failed code",
		text: "upstream_stream_read_error",
		decision: retried,
		category: "server_error",
	},
	// No known wording: treated as transient.
	{
		source: "unrecognised gateway text",
		text: "Something went wrong (code 7)",
		decision: retried,
		category: "unknown",
	},

	// README precedence traps.
	{
		source: "OpenAI 429 body carrying invalid_request_error",
		text: '429 {"error":{"message":"Rate limit reached","type":"invalid_request_error","code":"rate_limit_exceeded"}}',
		decision: retried,
		category: "rate_limit",
	},
	{
		source: "OpenAI-compatible 400 echoing the prompt",
		text: "400 Bad Request: you mentioned a rate limit in your prompt",
		decision: stopped,
		category: "invalid_request",
	},
	{
		source: "Google",
		text: "503 The model is overloaded. Please try again later.",
		decision: retried,
		category: "overloaded",
	},
	{
		source: "OpenAI-compatible gateway: overflow wording on a 429",
		text: "429: Too many tokens per minute",
		decision: retried,
		category: "rate_limit",
	},
	{
		source: "Anthropic",
		text: "prompt is too long: 213462 tokens > 200000 maximum",
		decision: stopped,
		category: "context_overflow",
	},
	{
		source: "OpenAI billing quota without a reset time",
		text: "429 You exceeded your current quota, please check your plan and billing details.",
		decision: stopped,
		category: "quota",
	},
	{
		source: "Anthropic low credit balance typed as invalid_request_error",
		text: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
		decision: stopped,
		category: "quota",
	},
	{
		source: "OpenAI quota with a reset time",
		text: "429 You exceeded your current quota. Please try again in 2s.",
		decision: retried,
		category: "quota",
	},

	// User-defined patterns from pi-retry.json.
	{
		source: "OpenAI insufficient_quota, forced by patterns.retryable",
		text: '429 {"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}',
		decision: retried,
		category: "quota",
	},
	{
		source: "custom gateway, stopped by patterns.nonRetryable",
		text: "503 tenant suspended",
		decision: stopped,
		category: "server_error",
	},
];

describe("error classification", () => {
	// error-classification: Category taxonomy, Deterministic categories take precedence, HTTP status recognition,
	// Provider vocabulary, User-defined patterns.
	it("never retries a deterministic provider failure and never gives up on a transient one", async () => {
		pi = await startRetry({
			config: { maxRetries: 0, patterns: { retryable: ["insufficient_quota"], nonRetryable: ["tenant suspended"] } },
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
		});
		const outcomes: { source: string; text: string; notice: string | undefined }[] = [];
		for (const row of ROWS) {
			const before = notices(pi).length;
			pi.provider.respond(failure(row.text, row.diagnostics ? { diagnostics: row.diagnostics } : {}));
			await pi.prompt(`request for ${row.source}`);
			const said = notices(pi).slice(before);
			outcomes.push({ source: row.source, text: row.text, notice: said.length === 1 ? said[0] : said.join(" | ") });
		}
		expect(pi.provider.requests).toHaveLength(ROWS.length);
		expect(outcomes).toEqual(
			ROWS.map((row) => ({
				source: row.source,
				text: row.text,
				notice: expect.stringMatching(new RegExp(`^pi-retry: ${row.decision}: ${row.category}\\b`)),
			})),
		);
	});

	// error-classification: Classification inputs ("Diagnostic error code", "Deterministic type only in a nested diagnostic").
	it("classifies by the codes a provider adapter puts in diagnostics, not only by the error text", async () => {
		pi = await startRetry({ config: { maxRetries: 0 } });
		const cases = [
			{
				// Pi's Bedrock adapter: the exception name is only in the diagnostic.
				source: "Bedrock",
				text: "Validation error: malformed input",
				diagnostics: [
					{ type: "bedrock_response_failure", timestamp: 0, details: { errorCode: "ValidationException" } },
				],
				notice: /^pi-retry: not retrying: invalid_request\b/,
			},
			{
				source: "Bedrock",
				text: "Bedrock request failed",
				diagnostics: [
					{ type: "bedrock_response_failure", timestamp: 0, details: { errorCode: "ThrottlingException" } },
				],
				notice: /^pi-retry: giving up after 0 retries: rate_limit\b/,
			},
			{
				// pi-messages' parsed provider error object: a quota type behind a plain 429 text.
				source: "pi-messages",
				text: "429 Too Many Requests: slow down",
				diagnostics: [
					{
						type: "pi_messages_response_failure",
						timestamp: 0,
						details: { status: 429, error: { message: "slow down", type: "insufficient_quota" } },
					},
				],
				notice: /^pi-retry: not retrying: quota or billing limit without a reset time$/,
			},
		];
		for (const { text, diagnostics } of cases) {
			pi.provider.respond(failure(text, { diagnostics }));
			await pi.prompt(`request: ${text}`);
		}
		expect(pi.provider.requests).toHaveLength(cases.length);
		expect(notices(pi)).toEqual(cases.map((entry) => expect.stringMatching(entry.notice)));
	});
});
