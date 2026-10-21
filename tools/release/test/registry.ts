import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** An upload the double accepted from `pnpm publish`. */
export interface Upload {
	readonly name: string;
	readonly version: string;
	readonly sha256: string;
}

interface Version {
	readonly manifest: Record<string, unknown>;
	readonly tarball: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function body(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	return Buffer.concat(chunks);
}

/**
 * A local npm registry: packuments and tarballs for the CLI's lookups and for pnpm, and the `PUT` that
 * `pnpm publish` sends. An accepted upload is installable at once, so pnpm's availability wait returns
 * immediately. It records every upload and every request.
 */
export class RegistryDouble {
	readonly uploads: Upload[] = [];
	readonly requests: string[] = [];
	readonly #packages = new Map<string, Map<string, Version>>();
	readonly #server: Server;
	#failLookups = 0;
	#url = "";

	private constructor() {
		this.#server = createServer((request, response) => {
			this.#handle(request, response).catch((error: unknown) => {
				response.writeHead(500, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: String(error) }));
			});
		});
	}

	static async start(): Promise<RegistryDouble> {
		const registry = new RegistryDouble();
		await new Promise<void>((resolve) => registry.#server.listen(0, "127.0.0.1", resolve));
		const address = registry.#server.address();
		if (address === null || typeof address === "string") throw new Error("the registry double has no port");
		registry.#url = `http://127.0.0.1:${address.port}/`;
		return registry;
	}

	/** The registry URL, with a trailing slash as `.npmrc` expects. */
	get url(): string {
		return this.#url;
	}

	/** Seeds a version as already published, with placeholder tarball bytes. */
	publish(name: string, version: string): void {
		this.#store(name, version, { name, version }, Buffer.from(`${name}@${version}`));
	}

	has(name: string, version: string): boolean {
		return this.#packages.get(name)?.has(version) === true;
	}

	/** Answers the next `count` packument lookups with HTTP 500. */
	failLookups(count = 1): void {
		this.#failLookups = count;
	}

	/** Forgets every version, upload, and request. */
	reset(): void {
		this.#packages.clear();
		this.uploads.length = 0;
		this.requests.length = 0;
		this.#failLookups = 0;
	}

	close(): Promise<void> {
		return new Promise((resolve) => this.#server.close(() => resolve()));
	}

	#store(name: string, version: string, manifest: Record<string, unknown>, tarball: Buffer): void {
		const versions = this.#packages.get(name) ?? new Map<string, Version>();
		versions.set(version, { manifest, tarball });
		this.#packages.set(name, versions);
	}

	#tarballUrl(name: string, version: string): string {
		return `${this.#url}${name}/-/${name.slice(name.indexOf("/") + 1)}-${version}.tgz`;
	}

	#packument(name: string, versions: Map<string, Version>): Record<string, unknown> {
		const entries = [...versions].map(([version, { manifest, tarball }]) => [
			version,
			{
				...manifest,
				name,
				version,
				dist: {
					tarball: this.#tarballUrl(name, version),
					shasum: createHash("sha1").update(tarball).digest("hex"),
					integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
				},
			},
		]);
		const latest = entries.at(-1)?.[0];
		return {
			name,
			"dist-tags": latest === undefined ? {} : { latest },
			versions: Object.fromEntries(entries),
		};
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const method = request.method ?? "GET";
		const path = decodeURIComponent(new URL(request.url ?? "/", this.#url).pathname).replace(/^\/+/, "");
		this.requests.push(`${method} ${path}`);
		const json = (status: number, data: unknown): void => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(method === "HEAD" ? undefined : JSON.stringify(data));
		};
		const tarball = /^(.+)\/-\/[^/]+-(\d+\.\d+\.\d+[^/]*)\.tgz$/.exec(path);
		if (tarball?.[1] !== undefined && tarball[2] !== undefined && (method === "GET" || method === "HEAD")) {
			const stored = this.#packages.get(tarball[1])?.get(tarball[2]);
			if (stored === undefined) {
				json(404, { error: "not found" });
				return;
			}
			response.writeHead(200, { "content-type": "application/octet-stream" });
			response.end(method === "HEAD" ? undefined : stored.tarball);
			return;
		}
		if (method === "GET" || method === "HEAD") {
			if (this.#failLookups > 0) {
				this.#failLookups--;
				json(500, { error: "internal server error" });
				return;
			}
			const versions = this.#packages.get(path);
			if (versions === undefined) {
				json(404, { error: "not found" });
				return;
			}
			json(200, this.#packument(path, versions));
			return;
		}
		if (method === "PUT") {
			await this.#accept(path, await body(request), json);
			return;
		}
		json(405, { error: `${method} not supported` });
	}

	/** `pnpm publish`: one version in `versions` and its tarball base64 in `_attachments`. */
	async #accept(name: string, raw: Buffer, json: (status: number, data: unknown) => void): Promise<void> {
		const data: unknown = JSON.parse(raw.toString("utf8"));
		const { versions, _attachments: attachments } = isRecord(data) ? data : {};
		const [entry] = isRecord(versions) ? Object.entries(versions) : [];
		const [attachment] = isRecord(attachments) ? Object.values(attachments) : [];
		const { data: encoded } = isRecord(attachment) ? attachment : {};
		if (entry === undefined || !isRecord(entry[1]) || typeof encoded !== "string") {
			json(400, { error: "expected one version and its attachment" });
			return;
		}
		const [version, manifest] = entry;
		if (this.has(name, version)) {
			json(403, { error: `cannot publish over the previously published version ${version}` });
			return;
		}
		const tarball = Buffer.from(encoded, "base64");
		this.#store(name, version, manifest, tarball);
		this.uploads.push({ name, version, sha256: createHash("sha256").update(tarball).digest("hex") });
		json(201, { ok: true });
	}
}
