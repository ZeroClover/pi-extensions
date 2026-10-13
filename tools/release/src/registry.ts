import { errorMessage, field, isRecord, ReleaseError } from "./errors.ts";

export const NPM_REGISTRY = "https://registry.npmjs.org";

export interface HttpResponse {
	readonly status: number;
	readonly body: string;
}

export type Http = (url: string, method: "GET" | "HEAD") => Promise<HttpResponse>;

export const fetchHttp: Http = async (url, method) => {
	const response = await fetch(url, {
		method,
		headers: {
			accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8",
			"cache-control": "no-cache",
		},
	});
	return { status: response.status, body: method === "HEAD" ? "" : await response.text() };
};

export type VersionLookup = { readonly kind: "found"; readonly tarball: string } | { readonly kind: "missing" };

async function request(http: Http, url: string, method: "GET" | "HEAD", what: string): Promise<HttpResponse> {
	try {
		return await http(url, method);
	} catch (error) {
		throw new ReleaseError(`${what}: ${errorMessage(error)}`);
	}
}

/**
 * Whether an exact version exists. Only a 404 for the package, or metadata without that version,
 * means absence; authentication, transport, and decoding failures are errors.
 */
export async function lookupVersion(
	http: Http,
	registry: string,
	name: string,
	version: string,
): Promise<VersionLookup> {
	const what = `registry lookup of ${name}@${version}`;
	const url = `${registry.replace(/\/+$/, "")}/${name.replace("/", "%2f")}`;
	const response = await request(http, url, "GET", what);
	if (response.status === 404) {
		return { kind: "missing" };
	}
	if (response.status !== 200) {
		throw new ReleaseError(`${what}: HTTP ${response.status}; only 404 counts as absence`);
	}
	let data: unknown;
	try {
		data = JSON.parse(response.body);
	} catch {
		throw new ReleaseError(`${what}: the registry returned invalid JSON`);
	}
	const versions = field(data, "versions");
	if (!isRecord(versions)) {
		throw new ReleaseError(`${what}: the metadata has no versions map`);
	}
	const entry = versions[version];
	if (entry === undefined) {
		return { kind: "missing" };
	}
	const tarball = field(field(entry, "dist"), "tarball");
	if (typeof tarball !== "string" || tarball === "") {
		throw new ReleaseError(`${what}: the version has no tarball URL`);
	}
	return { kind: "found", tarball };
}

/** Whether the registry serves a tarball (HTTP 200); 404 is not yet available, anything else an error. */
export async function tarballAvailable(http: Http, url: string): Promise<boolean> {
	const response = await request(http, url, "HEAD", `availability check of ${url}`);
	if (response.status === 200) {
		return true;
	}
	if (response.status === 404) {
		return false;
	}
	throw new ReleaseError(`availability check of ${url}: HTTP ${response.status}`);
}
