import { afterEach, describe, expect, it } from "vitest";
import { conversation, failure, type Pi, reply, text, waitFor } from "../../../tools/e2e/src/index.ts";
import { notices, request, startRetry, userTexts } from "./fixtures.ts";

let pi: Pi | undefined;

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
});

/**
 * With `baseDelayMs: 5000` the first backoff lasts 3.75 s to 5 s. Each case ends the wait about 0.1 s in; requiring
 * the end within 2.75 s keeps at least the 1 s margin design D4 asks of an upper bound.
 */
const EARLY_MS = 2750;

/** Starts a prompt whose request fails transiently and resolves once pi-retry's backoff wait is showing. */
async function failAndWait(session: Pi, prompt: string): Promise<{ run: Promise<void>; failedAt: number }> {
	session.provider.respond(failure("503 Service Unavailable", { status: 503 }));
	const before = session.provider.requests.length;
	const run = session.prompt(prompt);
	await waitFor("pi-retry's countdown", () => session.ui.currentStatus("pi-retry") !== undefined);
	return { run, failedAt: request(session, before).endedAt ?? Number.NaN };
}

/** Whether the run ended well before the backoff would have; a wait that runs on fails the case at that point. */
async function endedEarly(wait: { run: Promise<void>; failedAt: number }): Promise<boolean> {
	const left = wait.failedAt + EARLY_MS - performance.now();
	const late = new Promise<false>((resolve) => setTimeout(() => resolve(false), Math.max(0, left)));
	return Promise.race([wait.run.then(() => true), late]);
}

describe("ending a wait", () => {
	// retry-scheduling: Cancellable wait. retry-controls: Queued messages.
	it("lets the user end a backoff by command, Escape, a new message, or a session switch", async () => {
		pi = await startRetry({ config: { baseDelayMs: 5000 } });

		let wait = await failAndWait(pi, "cancel by command");
		await pi.prompt("/retry cancel");
		expect(await endedEarly(wait)).toBe(true);
		expect(pi.provider.requests).toHaveLength(1);
		expect(notices(pi).at(-1)).toBe("pi-retry: retry cancelled");

		wait = await failAndWait(pi, "cancel by Escape");
		pi.ui.press("\x1b");
		expect(await endedEarly(wait)).toBe(true);
		expect(pi.provider.requests).toHaveLength(2);
		expect(notices(pi).at(-1)).toBe("pi-retry: retry cancelled");

		wait = await failAndWait(pi, "retry with my message");
		pi.provider.respond(reply(text("retried")));
		await pi.session.steer("and this");
		await wait.run;
		expect(pi.provider.requests).toHaveLength(4);
		expect(request(pi, 3).startedAt - wait.failedAt).toBeLessThan(EARLY_MS);
		expect(userTexts(conversation(request(pi, 3))).slice(-2)).toEqual(["retry with my message", "and this"]);

		wait = await failAndWait(pi, "switch away");
		await pi.runtime.newSession();
		expect(await endedEarly(wait)).toBe(true);
		expect(pi.provider.requests).toHaveLength(5);
	});
});
