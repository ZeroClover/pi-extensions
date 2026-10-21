import { afterEach, describe, expect, it } from "vitest";
import { conversation, failure, type Pi, reply, text } from "../../../tools/e2e/src/index.ts";
import { notices, request, sessionFileEntries, startRetry, userTexts } from "./fixtures.ts";

let pi: Pi | undefined;

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
});

describe("recovery", () => {
	// retry-scheduling: Trigger point, Continuation. retry-controls: Reporting.
	it("retries a rate-limited request on a context without the failure and keeps the attempt in the session file", async () => {
		pi = await startRetry({ session: { file: true } });
		pi.provider.respond(failure("429 Too Many Requests", { status: 429 }), reply(text("recovered")));
		await pi.prompt("hello");

		expect(pi.provider.requests).toHaveLength(2);
		const retried = conversation(request(pi, 1));
		expect(retried.at(-1)?.role).toBe("user");
		expect(userTexts(retried)).toEqual(["hello"]);

		const said = notices(pi);
		expect(said[0]).toMatch(/^pi-retry: rate_limit \(rate_limit: HTTP 429\); retry 1\/10 in \d+ms$/);
		expect(said.at(-1)).toBe("pi-retry: succeeded on retry 1");
		const countdown = pi.ui.status("pi-retry");
		expect(countdown[0]).toBe("retry 1/10 in 1s");
		expect(countdown.at(-1)).toBeUndefined();

		const entries = await sessionFileEntries(pi);
		const failed = entries.find(({ type, message }) => {
			return type === "message" && JSON.stringify(message).includes('"errorMessage":"429 Too Many Requests"');
		});
		expect(failed).toBeDefined();
		const { id: failedId } = failed ?? {};
		expect(entries).toContainEqual(expect.objectContaining({ type: "context_edit", targetId: failedId }));
		expect(entries).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: "pi-retry",
				data: expect.objectContaining({ attempt: 1, category: "rate_limit", outcome: "scheduled" }),
			}),
		);
	});

	// error-classification: Retry decision by category. retry-scheduling: Attempt budget, Retry of retries.
	it("stops at once on an auth error and bounds a transient failure by the attempt budget", async () => {
		pi = await startRetry({ config: { maxRetries: 2 } });
		const unavailable = () => failure("503 Service Unavailable", { status: 503 });

		pi.provider.respond(
			failure('401 {"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}', { status: 401 }),
		);
		await pi.prompt("auth");
		expect(pi.provider.requests).toHaveLength(1);
		expect(notices(pi)).toEqual([expect.stringMatching(/^pi-retry: not retrying: auth: /)]);

		pi.provider.respond(unavailable(), unavailable(), reply(text("ok")));
		await pi.prompt("flaky");
		expect(pi.provider.requests).toHaveLength(4);
		expect(notices(pi).at(-1)).toBe("pi-retry: succeeded on retry 2");

		pi.provider.respond(unavailable(), unavailable(), unavailable());
		await pi.prompt("down");
		expect(pi.provider.requests).toHaveLength(7);
		expect(notices(pi).at(-1)).toMatch(/^pi-retry: giving up after 2 retries: server_error: /);

		pi.provider.respond(unavailable(), reply(text("ok")));
		await pi.prompt("again");
		expect(pi.provider.requests).toHaveLength(9);
		expect(notices(pi).at(-1)).toBe("pi-retry: succeeded on retry 1");
	});
});
