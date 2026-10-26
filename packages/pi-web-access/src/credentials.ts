import { spawn } from "node:child_process";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./json.ts";
import { type Credentials, type ProviderEntry, ProviderSkip } from "./types.ts";

/** `retry`: the failure was a timeout, so the next use runs the command again instead of reusing the failure. */
type KeyResult = { ok: true; key: string } | { ok: false; reason: string; retry?: true };

/** A parsed key expression, following Pi's grammar for `models.json` values. */
type KeyExpression = { kind: "command"; command: string } | { kind: "template"; parts: TemplatePart[] };
type TemplatePart = { kind: "literal"; text: string } | { kind: "env"; name: string };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const WHOLE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseKeyExpression(text: string): KeyExpression {
	if (text.startsWith("!")) return { kind: "command", command: text.slice(1).trim() };
	const parts: TemplatePart[] = [];
	const literal = (value: string): void => {
		const last = parts.at(-1);
		if (last?.kind === "literal") last.text += value;
		else if (value !== "") parts.push({ kind: "literal", text: value });
	};
	let index = 0;
	while (index < text.length) {
		const dollar = text.indexOf("$", index);
		if (dollar < 0) {
			literal(text.slice(index));
			break;
		}
		literal(text.slice(index, dollar));
		const next = text[dollar + 1];
		if (next === "$" || next === "!") {
			literal(next);
			index = dollar + 2;
			continue;
		}
		if (next === "{") {
			const end = text.indexOf("}", dollar + 2);
			const name = end < 0 ? "" : text.slice(dollar + 2, end);
			if (end >= 0 && WHOLE_ENV_NAME.test(name)) {
				parts.push({ kind: "env", name });
				index = end + 1;
			} else {
				literal("$");
				index = dollar + 1;
			}
			continue;
		}
		const name = text.slice(dollar + 1).match(ENV_NAME)?.[0];
		if (name) {
			parts.push({ kind: "env", name });
			index = dollar + 1 + name.length;
		} else {
			literal("$");
			index = dollar + 1;
		}
	}
	return { kind: "template", parts };
}

function resolveTemplate(parts: TemplatePart[]): KeyResult {
	let key = "";
	for (const part of parts) {
		if (part.kind === "literal") {
			key += part.text;
			continue;
		}
		const value = process.env[part.name];
		if (!value) return { ok: false, reason: `no credentials: environment variable ${part.name} is not set` };
		key += value;
	}
	return key === "" ? { ok: false, reason: "no credentials" } : { ok: true, key };
}

/**
 * Runs a key command for at most `timeoutMs`, the provider's attempt timeout: a password manager may wait for the
 * user's approval, and an attempt never outlasts that bound anyway. The command runs in its own process group, so
 * that a timeout ends it with everything it started, and the timeout settles the result at once rather than when
 * the last process has released the output pipes.
 */
function runCommand(command: string, timeoutMs: number): Promise<KeyResult> {
	const { SHELL: shell = "/bin/sh" } = process.env;
	return new Promise((resolve) => {
		const child = spawn(shell, ["-c", command], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			resolve({ ok: false, reason: `key command \`${command}\` timed out after ${timeoutMs} ms`, retry: true });
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
			} catch {
				// The group has already exited.
			}
		}, timeoutMs);
		const fail = (detail: string): void => {
			clearTimeout(timer);
			resolve({ ok: false, reason: `key command \`${command}\` failed: ${detail}` });
		};
		child.on("error", (error) => fail(errorMessage(error)));
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			const key = stdout.trim();
			if (code !== 0) fail(stderr.trim() || `exit ${code ?? signal}`);
			else if (key === "") resolve({ ok: false, reason: `key command \`${command}\` printed nothing` });
			else resolve({ ok: true, key });
		});
	});
}

/**
 * Settles with `promise`, or rejects with the signal's reason once it aborts. The work itself goes on, so a key
 * command still running when a call is cancelled can finish and settle the cache for the next call.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function findModel(registry: ModelRegistry, entry: ProviderEntry): Model<Api> | undefined {
	const provider = entry.provider;
	if (provider === undefined) return undefined;
	const exact = entry.model === undefined ? undefined : registry.find(provider, entry.model);
	return exact ?? registry.getAll().find((model) => model.provider === provider);
}

/** Credentials and their status for one session; key expressions are resolved once and cached. */
export class CredentialStore {
	private readonly keys = new Map<string, Promise<KeyResult>>();
	private readonly settled = new Map<string, KeyResult>();

	private resolveKey(entry: ProviderEntry, expression: string): Promise<KeyResult> {
		let pending = this.keys.get(entry.name);
		if (!pending) {
			const parsed = parseKeyExpression(expression);
			pending = (
				parsed.kind === "command"
					? runCommand(parsed.command, entry.timeoutMs)
					: Promise.resolve(resolveTemplate(parsed.parts))
			).then((result) => {
				this.settled.set(entry.name, result);
				if (!result.ok && result.retry) this.keys.delete(entry.name);
				return result;
			});
			this.keys.set(entry.name, pending);
		}
		return pending;
	}

	/**
	 * The credentials for one attempt, or a ProviderSkip with the reason. The base URL is the entry's `baseUrl`, else
	 * `defaultBaseUrl` (types with a fixed endpoint), else the one Pi resolves for the provider's models. Waiting for
	 * a key ends when `signal` (the attempt's timeout or the call's abort) fires.
	 */
	async resolve(
		entry: ProviderEntry,
		registry: ModelRegistry,
		signal: AbortSignal,
		defaultBaseUrl?: string,
	): Promise<Credentials> {
		const model = findModel(registry, entry);
		const notFound = `Pi provider "${entry.provider}" not found`;
		if (entry.provider !== undefined && model === undefined && entry.apiKey === undefined)
			throw new ProviderSkip(notFound);

		let apiKey: string | undefined;
		const headers: Record<string, string> = {};
		let resolvedBase: string | undefined;
		if (entry.apiKey !== undefined) {
			let key = await untilAborted(this.resolveKey(entry, entry.apiKey), signal);
			// A timeout reported while this attempt still runs belongs to a command an earlier, cancelled call started;
			// this attempt gets its own command and its own time.
			if (!key.ok && key.retry) key = await untilAborted(this.resolveKey(entry, entry.apiKey), signal);
			if (!key.ok) throw new ProviderSkip(key.reason);
			apiKey = key.key;
		} else {
			if (model === undefined) throw new ProviderSkip("no credentials");
			const auth = await untilAborted(registry.getApiKeyAndHeaders(model), signal);
			if (!auth.ok) throw new ProviderSkip(`no credentials: ${auth.error}`);
			for (const [name, value] of Object.entries(auth.headers ?? {})) if (value !== null) headers[name] = value;
			if (!auth.apiKey && Object.keys(headers).length === 0) throw new ProviderSkip("no credentials");
			apiKey = auth.apiKey || undefined;
			resolvedBase = auth.baseUrl;
		}
		const baseUrl = entry.baseUrl ?? defaultBaseUrl ?? resolvedBase ?? model?.baseUrl;
		if (!baseUrl)
			throw new ProviderSkip(entry.provider !== undefined && model === undefined ? notFound : "no base URL");
		const headerValues = Object.values(headers).map((value) => value.replace(/^Bearer\s+/i, ""));
		const secrets = [apiKey ?? "", ...headerValues].filter((value) => value.length >= 8);
		return { ...(apiKey ? { apiKey } : {}), headers, baseUrl: baseUrl.replace(/\/+$/, ""), secrets };
	}

	/** `ready`, `not resolved yet`, or `failed: <reason>`, without resolving commands. */
	status(entry: ProviderEntry, registry: ModelRegistry): string {
		if (entry.apiKey !== undefined) {
			const parsed = parseKeyExpression(entry.apiKey);
			const result = parsed.kind === "template" ? resolveTemplate(parsed.parts) : this.settled.get(entry.name);
			if (result === undefined) return "not resolved yet";
			return result.ok ? "ready" : `failed: ${result.reason}`;
		}
		const model = findModel(registry, entry);
		if (model === undefined) return `failed: Pi provider "${entry.provider}" not found`;
		return registry.hasConfiguredAuth(model) ? "ready" : `failed: no credentials for Pi provider "${entry.provider}"`;
	}
}
