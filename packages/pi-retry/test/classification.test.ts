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
	/**
	 * The expected category, optionally followed by its evidence (`context_overflow: ContextWindowExceeded`): the value
	 * is matched as a regular expression prefix of the notice's reason.
	 */
	category: string;
	/** Diagnostics the adapter attaches to the failed message. */
	diagnostics?: AssistantMessageDiagnostic[];
}

const retried = "giving up after 0 retries";
const stopped = "not retrying";

/** The message Zhipu/Z.ai sends with code 1308, as reported in Pi's #11537. */
const ZHIPU_LIMIT = "已达到 5 小时的使用上限。您的限额将在 2026-10-29 02:54:39 重置。";

/**
 * Zhipu/Z.ai's business codes, with the messages of https://docs.bigmodel.cn/cn/faq/api-code and
 * https://docs.z.ai/api-reference/api-code, in the renderings Pi's adapters produce.
 */
const ZHIPU_ROWS: Row[] = [
	// What must not change: transient codes, codes that only resemble a listed one, and failures already decided right.
	...(
		[
			["1302", "code 1302 is transient"],
			["1305", "code 1305 is transient"],
			["1312", "code 1312 is on neither table"],
			["1322", "code 1322 is on neither table"],
			["13090", "a longer code is not 1309"],
			["11130", "a longer code is not 1113"],
			["13110", "a longer code is not 1311"],
			["13150", "a longer code is not 1315"],
		] as const
	).map(
		([code, source]): Row => ({
			source,
			text: `429 {"code":"${code}","message":"x"}`,
			decision: retried,
			category: "rate_limit",
		}),
	),
	{
		source: "1316 English reset time carries no time zone: no hint",
		text: "429 Usage limit reached for the past 5 hours. Insufficient balance for extra usage. Resets at 2026-11-05 02:54:39.",
		decision: stopped,
		category: "quota",
	},
	{
		source: "1302 wording",
		text: "429 您的账户已达到速率限制，请您控制请求频率",
		decision: retried,
		category: "rate_limit",
	},
	{ source: "1305 wording", text: "429 该模型当前访问量过大，请您稍后再试", decision: retried, category: "rate_limit" },
	{
		source: "1302 English wording",
		text: "429 Rate limit reached for requests",
		decision: retried,
		category: "rate_limit",
	},
	{
		source: "1305 English wording",
		text: "429 The service may be temporarily overloaded, please try again later",
		decision: retried,
		category: "rate_limit",
	},
	{
		source: "1200",
		text: '500 {"error":{"code":"1200","message":"API 调用失败"}}',
		decision: retried,
		category: "server_error",
	},
	{
		source: "1230",
		text: '500 {"error":{"code":"1230","message":"API 调用流程出错"}}',
		decision: retried,
		category: "server_error",
	},
	{
		source: "1234",
		text: '500 {"error":{"code":"1234","message":"网络错误，错误id：20261104abc，请联系客服"}}',
		decision: retried,
		category: "server_error",
	},
	{
		source: "1261 table wording: no Pi overflow pattern matches it",
		text: "400 Prompt 超长",
		decision: stopped,
		category: "invalid_request: HTTP 400",
	},
	{
		source: "1261 wording of Pi's CN endpoint pattern",
		text: "400 Prompt exceeds max length",
		decision: stopped,
		category: "context_overflow: Pi's overflow patterns",
	},
	{
		source: "1261 English wording: Pi's overflow pattern",
		text: "400 Prompt too long",
		decision: stopped,
		category: "context_overflow: Pi's overflow patterns",
	},
	{
		source: "1001",
		text: '401 {"error":{"code":"1001","message":"Header 中未收到 Authentication 参数，无法进行身份验证"}}',
		decision: stopped,
		category: "auth: HTTP 401",
	},
	{
		source: "1211",
		text: '400 {"error":{"code":"1211","message":"模型不存在，请检查模型代码"}}',
		decision: stopped,
		category: "invalid_request: HTTP 400",
	},
	{
		source: "1301",
		text: '400 {"error":{"code":"1301","message":"系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语，感谢您的配合"}}',
		decision: stopped,
		category: "invalid_request: HTTP 400",
	},
	// Account and plan limits, then access restrictions. The code alone must match, for a message the wording misses.
	...["1113", "1309", "1310", "1313", "1314", "1316", "1317", "1318", "1319", "1320", "1321"].map(
		(code): Row => ({
			source: `code ${code} only`,
			text: `429 {"code":"${code}","message":"x"}`,
			decision: stopped,
			category: "quota",
		}),
	),
	...["1311", "1315"].map(
		(code): Row => ({
			source: `code ${code} only`,
			text: `429 {"code":"${code}","message":"x"}`,
			decision: stopped,
			category: "auth",
		}),
	),
	{
		source: "numeric quota code, form from Pi's pattern",
		text: '429 {"code":1309,"message":"x"}',
		decision: stopped,
		category: "quota",
	},
	{
		source: "numeric auth code, form from Pi's pattern",
		text: '429 {"code":1311,"message":"x"}',
		decision: stopped,
		category: "auth",
	},
	{
		source: "documented body, quota",
		text: '429 {"error":{"code":"1309","message":"您的 GLM Coding Plan 套餐已到期，暂无法使用，前往官方续订后即可恢复 https://bigmodel.cn/claude-code"}}',
		decision: stopped,
		category: "quota",
	},
	{
		source: "documented body, auth",
		text: '429 {"error":{"code":"1311","message":"当前订阅套餐暂未开放glm-x权限"}}',
		decision: stopped,
		category: "auth",
	},
	// The wording alone must match: Pi's Anthropic adapter drops the code from a top-level body.
	{
		source: "1113 wording without the code",
		text: "429 您的账户已欠费，请充值后重试",
		decision: stopped,
		category: "quota",
	},
	{
		source: "1309 wording without the code",
		text: "429 您的 GLM Coding Plan 套餐已到期，暂无法使用，前往官方续订后即可恢复 https://bigmodel.cn/claude-code",
		decision: stopped,
		category: "quota",
	},
	{
		source: "1313 wording without the code",
		text: "429 您的账户当前使用模式不符合公平使用策略，请求频率已受到限制。如需恢复请前往个人中心-编程套餐总览-顶部申请解除限制",
		decision: stopped,
		category: "quota",
	},
	{
		source: "1314 wording without the code",
		text: "429 您的企业套餐已失效，请联系企业管理员。",
		decision: stopped,
		category: "quota",
	},
	{
		source: "1311 wording without the code",
		text: "429 当前订阅套餐暂未开放glm-x权限",
		decision: stopped,
		category: "auth",
	},
	{
		source: "1315 wording without the code",
		text: "429 该 API Key 仅限企业编程套餐场景使用，请到官网更换对应产品类型的 API Key",
		decision: stopped,
		category: "auth",
	},
	{
		source: "1113 English wording without the code",
		text: "429 Insufficient balance or no resource package. Please recharge.",
		decision: stopped,
		category: "quota",
	},
	{
		source: "1309 English wording without the code",
		text: "429 Your GLM Coding Plan package has expired and is temporarily unavailable. You can resume using it after renewing the subscription on the official website.",
		decision: stopped,
		category: "quota",
	},
	{
		source: "1310 English wording without the code",
		text: "429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-05 02:54:39",
		decision: stopped,
		category: "quota",
	},
	{
		source: "1313 English wording without the code",
		text: "429 Your account's current usage pattern does not comply with the Fair Usage Policy, and your request frequency has been limited. To restore access, please submit a request.",
		decision: stopped,
		category: "quota",
	},
	{
		source: "1314 English wording without the code",
		text: "429 Your enterprise package has expired. Please contact your enterprise administrator.",
		decision: stopped,
		category: "quota",
	},
	{
		source: "1311 English wording without the code",
		text: "429 Your current subscription plan does not yet include access to glm-x",
		decision: stopped,
		category: "auth",
	},
	{
		source: "1315 English wording without the code",
		text: "429 This API Key is limited to enterprise coding package scenarios. Please go to the official website to replace the API Key of the corresponding product type.",
		decision: stopped,
		category: "auth",
	},
	{
		source: "1113 wording with the code in parentheses (pi-messages adapter)",
		text: "429 Too Many Requests: 您的账户已欠费，请充值后重试 (1113)",
		decision: stopped,
		category: "quota",
	},
	// `maxRetries: 0` never runs the wait, so this reads the hint from the notice and says nothing about scheduling;
	// test/hints.test.ts covers the wait for a text hint.
	{
		source: "quota code: the hint is read, not its schedule (maxRetries 0)",
		text: '429 {"code":"1309","message":"Try again in 2s"}',
		decision: retried,
		category: 'quota: "code":"1309; provider asked to wait 2s',
	},
	{
		source: "auth code ignores a hint",
		text: '429 {"code":"1311","message":"Try again in 2s"}',
		decision: stopped,
		category: "auth",
	},
];

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
	// The evidence tells pi-retry's overflow rule from Pi's overflow pattern: the prose text matches both.
	{
		source: "LiteLLM class name alone: this rule, not Pi's pattern",
		text: "litellm.ContextWindowExceededError",
		decision: stopped,
		category: "context_overflow: ContextWindowExceeded",
	},
	{
		source: "underscore form: this rule, not Pi's pattern",
		text: "context_window_exceeded",
		decision: stopped,
		category: "context_overflow: context_window_exceeded",
	},
	{
		source: "LiteLLM pre-call check: Pi's pattern since Pi 1.5",
		text: "litellm.ContextWindowExceededError: litellm.BadRequestError: litellm._pre_call_checks: Context Window exceeded for given call. No models have context window large enough for this call.",
		decision: stopped,
		category: "context_overflow: Pi's overflow patterns",
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
		source: "Codex usage limit relayed as a stream error event (Pi's Codex adapter)",
		text: "Codex error: The usage limit has been reached",
		decision: stopped,
		category: "quota",
	},
	{
		source: "Codex rate limit relayed as a stream error event (Pi's Codex adapter)",
		text: "Codex error: rate_limit_exceeded",
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
	// Pi 1.5 addition to its non-retryable list (#11537), and the renderings its pattern misses.
	{
		source: "Zhipu/Z.ai 1308, code only",
		text: '429 {"code":"1308","message":"x"}',
		decision: stopped,
		category: "quota",
	},
	{
		source: "code only, numeric form from Pi's pattern, not observed in a response",
		text: '429 {"code":1308,"message":"x"}',
		decision: stopped,
		category: "quota",
	},
	{
		source: "Zhipu/Z.ai 1308 (OpenAI Completions adapter)",
		text: `429: {"code":"1308","message":"${ZHIPU_LIMIT}"}`,
		decision: stopped,
		category: "quota",
	},
	{
		source: "nested body, numeric code (probe variant)",
		text: `429 {"error":{"code":1308,"message":"${ZHIPU_LIMIT}"}}`,
		decision: stopped,
		category: "quota",
	},
	{
		source: "Zhipu/Z.ai 1308 without a status (Google adapter)",
		text: `{"code":"1308","message":"${ZHIPU_LIMIT}"}`,
		decision: stopped,
		category: "quota",
	},
	{
		source: "Zhipu/Z.ai 1308 (Anthropic adapter)",
		text: `429 ${ZHIPU_LIMIT}`,
		decision: stopped,
		category: "quota",
	},
	{
		source: "nested body (pi-messages adapter)",
		text: `429 Too Many Requests: ${ZHIPU_LIMIT} (1308)`,
		decision: stopped,
		category: "quota",
	},
	{
		source: "a longer code is not 1308",
		text: '429 {"code":"13080","message":"x"}',
		decision: retried,
		category: "rate_limit",
	},
	{
		source: "a transient Zhipu/Z.ai code is not 1308",
		text: '429 {"code":"1302","message":"x"}',
		decision: retried,
		category: "rate_limit",
	},
	...ZHIPU_ROWS,
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
