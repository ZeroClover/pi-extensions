# provider-routing Specification

## Purpose
How a `web_search` or `web_fetch` call chooses providers: default priority chains, named site rules, the per-call override, fallback on failure, and the trace that tells the model what was tried.

## Requirements

### Requirement: Default provider chains
Each capability SHALL have an ordered default chain: the `search` and `fetch` arrays of the configuration file, or, when an array is omitted, every configured provider in declaration order. A call that matches no site rule and carries no override SHALL try the chain in order.

#### Scenario: Explicit chain
- **WHEN** the configuration declares providers `a`, `b`, `c` and `search: ["c", "a"]`
- **THEN** a plain search tries `c` first and `a` second, and never `b`

#### Scenario: Omitted chain
- **WHEN** the configuration declares providers `a`, `b` and no `fetch` array
- **THEN** a fetch tries `a` then `b`

### Requirement: Site pattern syntax
A site pattern SHALL be matched against a URL's host, lower-cased and without port, as follows: a pattern starting with `.` matches hosts ending with it (`.cn` matches `example.cn` and `www.example.com.cn`); a bare host matches that host and its subdomains (`github.com` matches `gist.github.com`); a host followed by a path (`github.com/golang`) additionally requires the URL path to start with that path, on a segment boundary.

#### Scenario: Suffix pattern
- **WHEN** the pattern is `.cn` and the hosts are `www.gov.cn` and `golang.google.cn`
- **THEN** the pattern matches both

#### Scenario: Bare host does not match a lookalike
- **WHEN** the pattern is `x.com` and the host is `codedtx.com`
- **THEN** the pattern does not match

#### Scenario: Path pattern
- **WHEN** the pattern is `github.com/golang` and the URLs are `https://github.com/golang/go` and `https://github.com/golang-migrate/migrate`
- **THEN** the first matches and the second does not

### Requirement: Hosts are compared without case, paths with it, and twitter.com is x.com
Site patterns SHALL compare hosts case-insensitively and paths case-sensitively, and SHALL treat `twitter.com` and `x.com` as the same site in bare-host and suffix patterns alike. A pattern naming one X post (`x.com/<user>/status/<id>`) SHALL match that post under any of its URL forms (`x.com/<user>/status/<id>`, `x.com/i/status/<id>`, `x.com/i/web/status/<id>`, also on X subdomains), in rules and result filters alike; a pattern naming a photo or subpage of a post is matched by its path only.

#### Scenario: Same site under two names
- **WHEN** the pattern is `.twitter.com` and the host is `mobile.x.com`
- **THEN** the pattern matches

#### Scenario: One X post under two URLs
- **WHEN** the pattern is `x.com/golang/status/1` and the URL is `https://x.com/i/status/1`
- **THEN** the pattern matches

#### Scenario: Path case
- **WHEN** the pattern is `example.com/Docs` and the URLs are `https://example.com/Docs/a` and `https://example.com/docs/b`
- **THEN** the first matches and the second does not

### Requirement: Site rules select the chain
A rule SHALL have a `name`, a list of site patterns, and a chain for `search`, for `fetch`, or both. For a search, a rule matches when any of its patterns matches any entry of `domains`; for a fetch, when any pattern matches the URL. Rules SHALL be evaluated in configuration order and the first match SHALL supply the chain for that capability; a matching rule without a chain for the capability SHALL leave the default chain in force.

#### Scenario: X search goes to the X-capable provider
- **WHEN** a rule `X` lists `x.com` and `twitter.com` with `search: ["grok"]` and the model searches with `domains: ["x.com/golang"]`
- **THEN** the search is attempted on `grok` and not on the default chain

#### Scenario: TLD rule for fetching
- **WHEN** a rule `CN` lists `.cn` with `fetch: ["deepseek", "codex-search"]` and the model fetches `https://www.gov.cn/`
- **THEN** the fetch tries `deepseek` first, then `codex-search`

#### Scenario: Search without a domain filter
- **WHEN** the model searches with no `domains` and no `site:` operator
- **THEN** no site rule applies and the default search chain is used

#### Scenario: Matching rule without a chain for the capability
- **WHEN** a rule `X` lists `x.com` with only a `search` chain, a later rule lists `docs.x.com` with a `fetch` chain, and the model fetches `https://docs.x.com/page`
- **THEN** the default fetch chain is used

#### Scenario: First matching rule wins
- **WHEN** two rules both match a request
- **THEN** the chain of the rule that appears first in the configuration is used

### Requirement: Suffix restrictions select rules
A suffix entry of a search's `domains` (`.gov.cn`, also written as `site:.gov.cn`) SHALL match a rule's suffix pattern that it ends with (`.cn`).

#### Scenario: Suffix restriction
- **WHEN** a rule `CN` lists `.cn` with a `search` chain and the model searches with `domains: [".gov.cn"]` or the query operator `site:.cn`
- **THEN** the search uses the `CN` chain

### Requirement: Per-call provider override
When a call carries `provider`, the named provider SHALL be the only one attempted, whether or not it appears in any chain or rule, and no fallback SHALL follow its failure. The error of a failed override SHALL name the provider and its failure reason.

#### Scenario: User asks for Exa explicitly
- **WHEN** the model calls `web_search` with `provider: "exa"` and a `domains` entry that a site rule routes elsewhere
- **THEN** only `exa` is attempted

#### Scenario: Override fails
- **WHEN** the overriding provider returns an error
- **THEN** the call fails with that provider's reason and no other provider is contacted

### Requirement: Fallback on failure
A provider attempt fails when its request cannot be sent (no credentials, transport error), times out, returns a non-success HTTP status, or reports a failure in its body; a fetch attempt also fails when it yields no text. On failure the next provider of the chain SHALL be tried. When every provider fails, the call SHALL fail with an error listing each provider and its reason.

#### Scenario: First provider is down
- **WHEN** the first provider of the chain answers HTTP 503 and the second succeeds
- **THEN** the result comes from the second provider

#### Scenario: Provider without credentials
- **WHEN** a provider in the chain has no usable credentials
- **THEN** it is skipped without a network request and the next provider is tried

#### Scenario: All providers fail
- **WHEN** every provider in the chain fails
- **THEN** the call returns an error that lists every provider with its reason

### Requirement: Empty search results
An unrestricted search (no `domains`) that returns zero results SHALL succeed with empty `results` from that provider. A domain-restricted search that yields zero results after client-side filtering SHALL record the attempt as `empty` and try the next provider, because several backends return nothing for sites they do not index; when every provider is empty the call SHALL succeed with empty `results` and the full trace.

#### Scenario: Unrestricted empty result
- **WHEN** the first provider returns zero results for a search without `domains`
- **THEN** the call succeeds with empty `results` from that provider

#### Scenario: Restricted search not covered by the first provider
- **WHEN** `domains` is `["reddit.com"]`, the first provider returns zero results and the second returns three
- **THEN** the results come from the second provider and `attempts` shows `empty` for the first

#### Scenario: Restricted search empty everywhere
- **WHEN** `domains` is `["example.invalid"]` and every provider returns zero results
- **THEN** the call succeeds with empty `results` and `attempts` shows `empty` for each provider

### Requirement: Timeouts and cancellation
Each attempt, including the resolution of its credentials, SHALL be bounded by the provider's `timeoutMs`; a timeout counts as a failure. When the tool call is aborted by Pi, the current request SHALL be cancelled and no further provider SHALL be attempted.

#### Scenario: Slow provider
- **WHEN** a provider does not answer within its `timeoutMs`
- **THEN** its attempt is recorded as a timeout and the next provider is tried

#### Scenario: Slow key command
- **WHEN** a provider's key comes from a command that has not finished within the provider's `timeoutMs`
- **THEN** the attempt is recorded as a timeout and the next provider is tried, the command is ended, and the next call runs it again with its own full `timeoutMs`; a command still running when a call is cancelled may instead finish and serve the next call

#### Scenario: User interrupts
- **WHEN** the user aborts the turn while a provider request is in flight
- **THEN** the request is cancelled and no other provider is contacted

### Requirement: Unsupported options degrade with a warning
When the selected provider cannot apply one of the call's options (for example `recency` or `includeContent`), the attempt SHALL proceed without it and `warnings` SHALL name the ignored option and the provider.

#### Scenario: Recency on a provider without date filters
- **WHEN** `recency: "week"` is requested on a provider that has no date filter
- **THEN** the search runs and `warnings` says `recency` was ignored by that provider

### Requirement: The routing trace is part of every result
`attempts` SHALL list, in order, every provider considered for the call as `{ provider, outcome, reason?, latencyMs? }` with `outcome` one of `ok`, `empty`, `error`, `skipped`, so that the model can see which provider answered and why others did not.

#### Scenario: Success after one failure
- **WHEN** the first provider fails and the second succeeds
- **THEN** `attempts` holds an `error` entry for the first and an `ok` entry for the second, and `provider` names the second
