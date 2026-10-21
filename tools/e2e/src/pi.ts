import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createEventBus,
	type EventBus,
	type ExtensionError,
	type ExtensionFactory,
	type SessionEntry,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createScriptedProvider, PROVIDER_ID, type ScriptedProvider } from "./provider.ts";
import { createRecordingUI, type RecordingUI } from "./ui.ts";

const REPO = resolve(import.meta.dirname, "../../..");

/** Pi's environment variable for the agent directory, which extensions read through `getAgentDir()`. */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

export interface StartOptions {
	/** Package directories under `packages/`, loaded from their `package.json` `pi` manifest as `pi -e` loads them. */
	extensions: string[];
	/** `ctx.mode`; `"tui"` by default. */
	mode?: "tui" | "rpc";
	/** Pi settings, held in memory. The scripted provider's first model is the default model. */
	settings?: Settings;
	/** Files written into the agent directory before the session starts; non-strings are written as JSON. */
	agentFiles?: Record<string, unknown>;
	/** A caller-owned agent directory, shared and left in place; a fresh one by default. */
	agentDir?: string;
	/** `process.env` changes applied until `dispose()`; `undefined` deletes a variable. */
	env?: Record<string, string | undefined>;
	/** A file-backed session, needed for `reopen()`; in memory by default. */
	session?: { file?: boolean };
	/** Pi's tool allowlist; Pi's default tools when omitted. */
	tools?: string[];
	/** Stand-ins for the tools of third-party extensions. */
	customTools?: ToolDefinition[];
}

/** Payloads seen on the shared event bus, by channel. */
export interface EventLog {
	/** Every payload emitted on `channel` since the session started. */
	collect(channel: string): unknown[];
	/** Emits on the current session's bus, as another extension would. */
	emit(channel: string, data: unknown): void;
}

export interface Pi {
	readonly provider: ScriptedProvider;
	readonly ui: RecordingUI;
	readonly events: EventLog;
	readonly cwd: string;
	readonly agentDir: string;
	/** Pi's own session and runtime; the session changes on `newSession`, `switchSession`, and `fork`. */
	readonly session: AgentSession;
	readonly runtime: AgentSessionRuntime;
	/** Handler errors Pi reported for loaded extensions. `dispose()` fails while this is not empty. */
	readonly errors: ExtensionError[];
	/** Sends a prompt or slash command and resolves when Pi settles. */
	prompt(text: string): Promise<void>;
	/** The session's entries, custom ones included. */
	entries(): SessionEntry[];
	/** The text of every tool result the model received, in order. */
	toolResults(): string[];
	/** Disposes this runtime and starts a new one on the same session file and agent directory; use only the result. */
	reopen(): Promise<Pi>;
	/** Emits `session_shutdown`, removes what this call created, and restores `process.env`. */
	dispose(): Promise<void>;
}

/** What one `startPi` call owns across `reopen()`. */
interface Owned {
	root: string | undefined;
	env: Map<string, string | undefined>;
}

function applyEnv(changes: Record<string, string | undefined>, saved: Map<string, string | undefined>): void {
	for (const [name, value] of Object.entries(changes)) {
		if (!saved.has(name)) saved.set(name, process.env[name]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

function restoreEnv(saved: Map<string, string | undefined>): void {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	saved.clear();
}

async function writeAgentFiles(agentDir: string, files: Record<string, unknown>): Promise<void> {
	for (const [name, content] of Object.entries(files)) {
		const file = join(agentDir, name);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, typeof content === "string" ? content : `${JSON.stringify(content, null, "\t")}\n`);
	}
}

/** An event bus that also records every payload, since a bus has no wildcard subscription. */
function recordingBus(log: { channel: string; data: unknown }[]): EventBus {
	const inner = createEventBus();
	return {
		emit: (channel, data) => {
			log.push({ channel, data });
			inner.emit(channel, data);
		},
		on: (channel, handler) => inner.on(channel, handler),
	};
}

interface Launch {
	options: StartOptions;
	owned: Owned;
	cwd: string;
	agentDir: string;
	provider: ScriptedProvider;
	sessionFile: string | undefined;
}

async function launch(state: Launch): Promise<Pi> {
	const { options, owned, cwd, agentDir, provider } = state;
	const mode = options.mode ?? "tui";
	const ui = createRecordingUI();
	const errors: ExtensionError[] = [];
	const log: { channel: string; data: unknown }[] = [];
	let bus: EventBus | undefined;

	const probe: ExtensionFactory = (pi) => {
		pi.registerProvider(provider.provider);
	};
	const [first] = provider.models;
	const settings: Settings = {
		defaultProvider: PROVIDER_ID,
		defaultModel: first.id,
		...options.settings,
	};

	const createRuntime: CreateAgentSessionRuntimeFactory = async (input) => {
		// Every runtime gets a new bus, as in Pi, so a subscription never outlives its session.
		bus = recordingBus(log);
		const services = await createAgentSessionServices({
			cwd: input.cwd,
			agentDir: input.agentDir,
			settingsManager: SettingsManager.inMemory(settings),
			resourceLoaderOptions: {
				eventBus: bus,
				additionalExtensionPaths: options.extensions.map((name) => join(REPO, "packages", name)),
				extensionFactories: [probe],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const failures = services.diagnostics.filter((diagnostic) => diagnostic.type === "error");
		if (failures.length > 0) {
			throw new Error(`Pi services failed: ${failures.map((diagnostic) => diagnostic.message).join("; ")}`);
		}
		// Pi checks a registered provider's auth asynchronously; without a configured key, model selection could read
		// the snapshot first and start the session without a model.
		await services.modelRuntime.refresh({ providers: [PROVIDER_ID], allowNetwork: false });
		const result = await createAgentSessionFromServices({
			services,
			sessionManager: input.sessionManager,
			...(input.sessionStartEvent ? { sessionStartEvent: input.sessionStartEvent } : {}),
			...(options.tools ? { tools: options.tools } : {}),
			...(options.customTools ? { customTools: options.customTools } : {}),
		});
		if (result.extensionsResult.errors.length > 0) {
			const messages = result.extensionsResult.errors.map((error) => `${error.path}: ${error.error}`);
			throw new Error(`extensions failed to load: ${messages.join("; ")}`);
		}
		return { ...result, services, diagnostics: services.diagnostics };
	};

	const sessionDir = join(agentDir, "sessions");
	const sessionManager =
		state.sessionFile !== undefined
			? SessionManager.open(state.sessionFile, sessionDir)
			: options.session?.file
				? SessionManager.create(cwd, sessionDir)
				: SessionManager.inMemory(cwd);
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
	const bind = async (session: AgentSession): Promise<void> => {
		await session.bindExtensions({
			uiContext: ui.context,
			mode,
			onError: (error) => {
				errors.push(error);
			},
		});
	};
	runtime.setRebindSession(bind);
	await bind(runtime.session);

	let disposed = false;
	/** Set by `reopen()`: the new runtime owns the directories and the environment from then on. */
	let handedOver = false;
	const shutdown = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		await runtime.dispose();
	};

	return {
		provider,
		ui,
		cwd,
		agentDir,
		errors,
		get session() {
			return runtime.session;
		},
		runtime,
		events: {
			collect: (channel) => log.filter((entry) => entry.channel === channel).map((entry) => entry.data),
			emit: (channel, data) => {
				if (!bus) throw new Error("no session is running");
				bus.emit(channel, data);
			},
		},
		prompt: (text) => runtime.session.prompt(text),
		entries: () => runtime.session.sessionManager.getEntries(),
		toolResults: () =>
			runtime.session.messages.flatMap((message) =>
				message.role === "toolResult"
					? [message.content.map((block) => (block.type === "text" ? block.text : "")).join("")]
					: [],
			),
		reopen: async () => {
			const sessionFile = runtime.session.sessionFile;
			if (sessionFile === undefined) throw new Error("reopen() needs startPi({ session: { file: true } })");
			await shutdown();
			// Until the new runtime is up, this object still owns the directories and the environment, so a failed
			// launch leaves `dispose()` able to clean up.
			const next = await launch({ ...state, sessionFile });
			handedOver = true;
			return next;
		},
		dispose: async () => {
			if (handedOver) return;
			try {
				await shutdown();
			} finally {
				if (owned.root !== undefined) await rm(owned.root, { recursive: true, force: true });
				restoreEnv(owned.env);
			}
			if (errors.length > 0) {
				throw new Error(`extension errors: ${errors.map((error) => `${error.event}: ${error.error}`).join("; ")}`);
			}
		},
	};
}

/**
 * Starts a real Pi session runtime in this process with the named packages loaded, a scripted provider, and a
 * recording UI. Sessions of one test file run one after another: they share `process.env`.
 */
export async function startPi(options: StartOptions): Promise<Pi> {
	const root = await mkdtemp(join(tmpdir(), "e2e-pi-"));
	const owned: Owned = { root, env: new Map() };
	try {
		const cwd = join(root, "cwd");
		const agentDir = options.agentDir ?? join(root, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeAgentFiles(agentDir, options.agentFiles ?? {});
		applyEnv({ PI_OFFLINE: "1", [AGENT_DIR_ENV]: agentDir, ...options.env }, owned.env);
		return await launch({
			options,
			owned,
			cwd,
			agentDir,
			provider: createScriptedProvider(),
			sessionFile: undefined,
		});
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		restoreEnv(owned.env);
		throw error;
	}
}
