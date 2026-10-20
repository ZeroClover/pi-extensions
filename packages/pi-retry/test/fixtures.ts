import type { AssistantMessage, AssistantMessageDiagnostic, StopReason } from "@earendil-works/pi-ai";

export function assistant(
	stopReason: StopReason,
	errorMessage?: string,
	extra: Partial<Pick<AssistantMessage, "api" | "provider" | "model" | "diagnostics">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: 0,
		...extra,
	};
}

export function failure(errorMessage: string, diagnostics?: AssistantMessageDiagnostic[]): AssistantMessage {
	return assistant("error", errorMessage, diagnostics ? { diagnostics } : {});
}
