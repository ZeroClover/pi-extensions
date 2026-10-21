import { afterEach, describe, expect, it } from "vitest";
import { conversation, failure, type Pi, reply, text, waitFor } from "../../../tools/e2e/src/index.ts";
import { notices, request, startRetry, userTexts } from "./fixtures.ts";

let pi: Pi | undefined;

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
});

/** The data of the `pi-retry` session entries. */
function records(session: Pi): unknown[] {
	return session
		.entries()
		.flatMap((entry) => (entry.type === "custom" && entry.customType === "pi-retry" ? [entry.data] : []));
}

/** Milliseconds from the end of the failed request to the start of its retry. */
function gap(session: Pi, failedIndex: number): number {
	return request(session, failedIndex + 1).startedAt - (request(session, failedIndex).endedAt ?? Number.NaN);
}

const TEXT_HINT =
	"429 Rate limit reached for gpt-4o in organization org-abc on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 1.2s.";

describe("provider-requested waits", () => {
	// retry-hints: Text hints, Acceptance limit, Header capture gate. retry-scheduling: Cancellable wait.
	// retry-controls: Queued messages.
	it("waits as long as the provider asks, also when the user types meanwhile, and never past the limit", async () => {
		// A 3 s limit (design D6 says 1 s) so that the 1.2 s hints of this session are accepted and the 5 s one is not.
		pi = await startRetry({ config: { maxRetryAfterMs: 3000 } });

		pi.provider.respond(failure(TEXT_HINT, { status: 429 }), reply(text("ok")));
		await pi.prompt("text hint");
		expect(gap(pi, 0)).toBeGreaterThanOrEqual(1450);
		expect(records(pi).at(-1)).toMatchObject({ hintSource: "text try again in", delayMs: 1450 });

		pi.provider.respond(failure("429 Too Many Requests. Please try again in 5s.", { status: 429 }));
		await pi.prompt("over the limit");
		expect(pi.provider.requests).toHaveLength(3);
		expect(notices(pi).at(-1)).toBe("pi-retry: not retrying: provider asked to wait 5s, limit is 3s");

		// Pi's default cacheWarming shares the response hook with warming requests, so headers are not attributable.
		pi.provider.respond(
			failure("429 Too Many Requests", { status: 429, headers: { "retry-after": "1" } }),
			reply(text("ok")),
		);
		await pi.prompt("header without the gate");
		const unattributed = records(pi).at(-1);
		expect(unattributed).not.toHaveProperty("hintSource");
		// The backoff of `baseDelayMs: 100`, not the header's 1 s.
		expect(unattributed).toMatchObject({ delayMs: expect.toSatisfy((ms: number) => ms <= 100) });
		await pi.prompt("/retry");
		expect(pi.ui.notices.at(-1)?.message).toContain("headerHints: off (cacheWarming is not off)");

		pi.provider.respond(failure(TEXT_HINT, { status: 429 }), reply(text("ok")));
		const run = pi.prompt("hinted wait with a message");
		await waitFor("the hinted wait", () => pi?.ui.currentStatus("pi-retry") !== undefined);
		await pi.session.steer("one more thing");
		await run;
		const failed = pi.provider.requests.length - 2;
		expect(gap(pi, failed)).toBeGreaterThanOrEqual(1450);
		expect(userTexts(conversation(request(pi, failed + 1))).at(-1)).toBe("one more thing");
	});

	// retry-hints: Header hints, Header capture gate.
	it("honours a retry-after header when Pi's settings make it attributable", async () => {
		pi = await startRetry({ settings: { retry: { enabled: false }, cacheWarming: "off" } });
		pi.provider.respond(
			failure("429 Too Many Requests", { status: 429, headers: { "retry-after": "1" } }),
			reply(text("ok")),
		);
		await pi.prompt("header hint");
		expect(records(pi).at(-1)).toMatchObject({ hintSource: "header retry-after", delayMs: 1250 });
		expect(gap(pi, 0)).toBeGreaterThanOrEqual(1250);
	});
});
