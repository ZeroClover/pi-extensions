/** Site patterns (`.cn`, `github.com`, `github.com/golang`), URL normalisation, and result filtering. */

/**
 * Normalises a pattern or domain entry as users and models write them: lower-case host, without scheme, query,
 * fragment or trailing slash. Returns undefined for an empty entry.
 */
export function normalizeSite(entry: string): string | undefined {
	let text = entry.trim();
	text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
	text = text.replace(/[?#].*$/, "");
	text = text.replace(/\/+$/, "");
	if (text === "" || text === ".") return undefined;
	// Hosts are case-insensitive, paths are not.
	const slash = text.indexOf("/");
	return slash < 0 ? text.toLowerCase() : `${text.slice(0, slash).toLowerCase()}${text.slice(slash)}`;
}

interface SitePattern {
	suffix: boolean;
	host: string;
	path: string;
}

function parseSite(site: string): SitePattern {
	const slash = site.indexOf("/");
	const host = (slash < 0 ? site : site.slice(0, slash)).replace(/:\d+$/, "");
	const path = slash < 0 ? "" : site.slice(slash);
	return { suffix: host.startsWith("."), host, path };
}

/** The host of a site pattern or domain entry, without path. */
export function siteHost(site: string): string {
	return parseSite(site).host;
}

/** The path of a site pattern or domain entry (`/golang`), or an empty string. */
export function sitePath(site: string): string {
	return parseSite(site).path;
}

/** twitter.com serves X under its old name and redirects to x.com, so both names denote the same site. */
function canonicalHost(host: string): string {
	return host === "twitter.com" || host.endsWith(".twitter.com")
		? `${host.slice(0, -"twitter.com".length)}x.com`
		: host;
}

function hostMatches(pattern: SitePattern, rawHost: string): boolean {
	const host = canonicalHost(rawHost);
	if (pattern.suffix) return host.endsWith(canonicalHost(pattern.host));
	const patternHost = canonicalHost(pattern.host);
	return host === patternHost || host.endsWith(`.${patternHost}`);
}

function pathMatches(prefix: string, path: string): boolean {
	return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

/** A post URL path: `/<user>/status/<id>`, `/i/status/<id>` or `/i/web/status/<id>`, nothing after the id. */
const X_POST = /^\/(?:[^/]+|i\/web)\/status\/(\d+)\/?$/;

/** The id of an X post URL or site entry, on x.com, twitter.com or their subdomains. */
function xPostId(host: string, path: string): string | undefined {
	const canonical = canonicalHost(host);
	return canonical === "x.com" || canonical.endsWith(".x.com") ? path.match(X_POST)?.[1] : undefined;
}

/** Whether `site` (a normalised pattern) matches `url`, per the provider-routing pattern syntax. */
export function siteMatchesUrl(site: string, url: URL): boolean {
	const pattern = parseSite(site);
	const host = url.hostname.toLowerCase();
	if (hostMatches(pattern, host) && pathMatches(pattern.path, url.pathname)) return true;
	// X cites one post as `x.com/i/status/<id>` as well as `x.com/<user>/status/<id>`; the id alone identifies it.
	const id = pattern.suffix ? undefined : xPostId(pattern.host, pattern.path);
	return id !== undefined && id === xPostId(host, url.pathname);
}

/** Whether a rule pattern matches a domain entry of a search (`x.com/golang` is matched like that URL). */
export function siteMatchesSite(pattern: string, entry: string): boolean {
	const target = parseSite(entry);
	// A suffix entry (`.gov.cn`) lies inside a suffix pattern it ends with (`.cn`).
	if (target.suffix) {
		const rule = parseSite(pattern);
		return rule.suffix && rule.path === "" && canonicalHost(target.host).endsWith(canonicalHost(rule.host));
	}
	const url = parseUrl(`https://${target.host}${target.path}`);
	return url !== undefined && siteMatchesUrl(pattern, url);
}

export function parseUrl(text: string): URL | undefined {
	try {
		return new URL(text);
	} catch {
		return undefined;
	}
}

const TRACKING = /^(utm_.*|fbclid|gclid)$/i;

/** Lower-cases scheme and host, removes the fragment and tracking parameters; unparsable URLs are returned as is. */
export function normalizeUrl(text: string): string {
	const url = parseUrl(text);
	if (!url) return text;
	url.hash = "";
	for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
	return url.toString();
}

/** Whether `url` passes the domain filters: inside one of `domains` (when any) and in none of `excludeDomains`. */
export function passesFilters(url: string, domains: readonly string[], excludeDomains: readonly string[]): boolean {
	const parsed = parseUrl(url);
	if (!parsed) return false;
	if (domains.length > 0 && !domains.some((site) => siteMatchesUrl(site, parsed))) return false;
	return !excludeDomains.some((site) => siteMatchesUrl(site, parsed));
}
