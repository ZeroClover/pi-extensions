import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { emptyConfig, type WebAccessConfig } from "./config.ts";
import { CredentialStore } from "./credentials.ts";
import { PROVIDER_DEFINITIONS } from "./providers/registry.ts";
import type { Credentials, ProviderEntry, WebProvider } from "./types.ts";

/** What one session knows: the configuration file, its parsed content, adapters, and resolved credentials. */
export class WebAccessState {
	/** The configuration file path; undefined before the first `session_start`. */
	path: string | undefined;
	found = false;
	config: WebAccessConfig = emptyConfig();
	private credentials = new CredentialStore();
	private adapters = new Map<string, WebProvider>();

	reset(path: string, config: WebAccessConfig, found: boolean): void {
		this.path = path;
		this.config = config;
		this.found = found;
		this.credentials = new CredentialStore();
		this.adapters = new Map(
			config.providers.map((entry) => [entry.name, PROVIDER_DEFINITIONS[entry.type].create(entry)]),
		);
	}

	clear(): void {
		this.reset(this.path ?? "", emptyConfig(), false);
	}

	entry(name: string): ProviderEntry | undefined {
		return this.config.providers.find((entry) => entry.name === name);
	}

	adapter(entry: ProviderEntry): WebProvider {
		const adapter = this.adapters.get(entry.name);
		if (!adapter) throw new Error(`no adapter for provider ${entry.name}`);
		return adapter;
	}

	resolveCredentials(entry: ProviderEntry, registry: ModelRegistry, signal: AbortSignal): Promise<Credentials> {
		return this.credentials.resolve(entry, registry, signal, PROVIDER_DEFINITIONS[entry.type].defaults.baseUrl);
	}

	credentialStatus(entry: ProviderEntry, registry: ModelRegistry): string {
		return this.credentials.status(entry, registry);
	}

	/** The configuration file as named in messages; Pi's default location before the first session start. */
	displayPath(): string {
		return this.path ?? "pi-web-access.json";
	}
}
