import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Make pi-web-access tools reachable only through codemode.
 *
 * pi only lets codemode call `direct` tools while they are active, so the web tools can't simply
 * be deactivated. Instead, they are kept active and an invisible helper tool uses
 * `prepareLoadout` to hide their declarations from requests: scripts can still call them, but
 * their schemas (~3k tokens) are no longer sent. pi-web-access's `web_enable` loader, which
 * activates the tools on demand, is hidden too, since the tools are always active here.
 */
const WEB_TOOLS = ["web_search", "source_check", "fetch_content", "get_search_content"];
const WEB_LOADER = "web_enable";
const HELPER = "web_codemode_loadout";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: HELPER,
		label: "Web tools via codemode",
		description: "Internal loadout helper. Never declared to the model.",
		parameters: Type.Object({}),
		// Active (so its prepareLoadout hook runs) but never callable.
		exposure: "model-only",
		prepareLoadout: () => ({ hiddenDeclarations: [HELPER, WEB_LOADER, ...WEB_TOOLS] }),
		async execute() {
			throw new Error(`${HELPER} is not callable`);
		},
	});

	/** Activate every registered web tool, which pi-web-access may have left inactive. */
	const activateWebTools = (): string[] => {
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		const available = WEB_TOOLS.filter((name) => registered.has(name));
		const active = pi.getActiveTools();
		const missing = available.filter((name) => !active.includes(name));
		if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
		return available;
	};

	// pi-web-access picks its loadout on session_start and session_tree. Re-checking before each
	// run makes the result independent of extension load order.
	pi.on("session_start", activateWebTools);
	pi.on("session_tree", activateWebTools);
	pi.on("before_agent_start", (event) => {
		const available = activateWebTools();
		if (available.length === 0) return;
		// Hidden tools drop out of the prompt's tool list, so tell the model where they went.
		event.systemPromptOptions.sections.web_tools = [
			`Web tools are callable only from \`codemode\` scripts: ${available.map((name) => `\`tools.${name}()\``).join(", ")}.`,
			"Use them for web research, docs lookups, and fetching URLs, GitHub repos, PDFs, and videos.",
			"`web_search` resolves to `{ responseId, fetchId, queries: [{ query, answer, error, results: [{ title, url, snippet }] }] }`.",
			"`fetch_content` resolves to `{ responseId, urls: [{ url, title, content, error }] }`, with full `content`.",
			"Get exact parameters with `await describeTool(name)`.",
		].join("\n");
	});
}
