import { afterEach, describe, expect, it } from "vitest";
import { failure, type Pi, reply, text } from "../../../tools/e2e/src/index.ts";
import { notices, startRetry } from "./fixtures.ts";

let pi: Pi | undefined;

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
});

const LAYERING =
	'pi-retry: Pi\'s built-in retry is enabled and runs first; set "retry": { "enabled": false } in Pi settings to let pi-retry govern every attempt';

describe("configuration", () => {
	// retry-controls: Coexistence with Pi's retry.
	it("tells the user once when Pi's own retry also runs, and both layers then act in turn", async () => {
		pi = await startRetry({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } } });
		pi.provider.respond(
			failure("503 Service Unavailable", { status: 503 }),
			failure("503 Service Unavailable", { status: 503 }),
			reply(text("ok")),
		);
		await pi.prompt("flaky");
		// Pi retries once and gives up; pi-retry then continues once, which succeeds.
		expect(pi.provider.requests).toHaveLength(3);
		expect(notices(pi).filter((message) => message === LAYERING)).toHaveLength(1);
		expect(notices(pi).at(-1)).toBe("pi-retry: succeeded on retry 1");
	});

	// retry-configuration: Validation and fallback.
	it("keeps retrying with the default when one setting in pi-retry.json is invalid", async () => {
		pi = await startRetry({ config: { maxRetries: -1 } });
		const warnings = pi.ui.notices.filter((notice) => notice.level === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toMatch(/^pi-retry: .*pi-retry\.json: maxRetries: /);

		pi.provider.respond(failure("503 Service Unavailable", { status: 503 }), reply(text("ok")));
		await pi.prompt("flaky");
		expect(notices(pi)).toContainEqual(expect.stringMatching(/; retry 1\/10 in /));
		expect(notices(pi).at(-1)).toBe("pi-retry: succeeded on retry 1");
	});
});
