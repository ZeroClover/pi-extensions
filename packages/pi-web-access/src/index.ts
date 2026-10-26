import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { renderStatus } from "./command.ts";
import { CONFIG_FILE_NAME, loadConfig } from "./config.ts";
import { createFetchTool } from "./fetch-tool.ts";
import { PROVIDER_DEFINITIONS } from "./providers/registry.ts";
import { createSearchTool } from "./search-tool.ts";
import { WebAccessState } from "./state.ts";

export default function (pi: ExtensionAPI): void {
	const state = new WebAccessState();
	pi.registerTool(createSearchTool(state));
	pi.registerTool(createFetchTool(state));

	pi.registerCommand("web-access", {
		description: "Show pi-web-access providers, credential status, provider chains and site rules",
		handler: async (_args, ctx) => {
			ctx.ui.notify(renderStatus(state, ctx.modelRegistry), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const path = join(getAgentDir(), CONFIG_FILE_NAME);
		const { config, warnings, found } = await loadConfig(path, PROVIDER_DEFINITIONS);
		state.reset(path, config, found);
		if (!found) {
			ctx.ui.notify(
				`pi-web-access: ${path} not found; web_search and web_fetch will fail until providers are configured there`,
				"info",
			);
		}
		for (const warning of warnings) ctx.ui.notify(warning, "warning");
	});

	pi.on("session_shutdown", () => {
		state.clear();
	});
}
