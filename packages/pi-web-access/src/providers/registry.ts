import type { ProviderType } from "../types.ts";
import { deepseek } from "./deepseek.ts";
import { exa } from "./exa.ts";
import type { ProviderDefinition } from "./options.ts";
import { sub2apiClaude } from "./sub2api-claude.ts";
import { sub2apiCodex } from "./sub2api-codex.ts";
import { sub2apiGrok } from "./sub2api-grok.ts";
import { sub2apiSearch } from "./sub2api-search.ts";

/** Every provider type; adding a type is one adapter module and one entry here. */
export const PROVIDER_DEFINITIONS: Record<ProviderType, ProviderDefinition> = {
	"sub2api-search": sub2apiSearch,
	"sub2api-codex": sub2apiCodex,
	"sub2api-claude": sub2apiClaude,
	"sub2api-grok": sub2apiGrok,
	deepseek,
	exa,
};
