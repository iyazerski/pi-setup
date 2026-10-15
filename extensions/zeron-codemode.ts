import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Move Zeron's agent tools behind codemode.
 *
 * Zeron launches pi with its own bridge extension that registers every `zeron mcp` tool as a
 * direct `zeron_*` tool, so all their declarations (~10k tokens) are sent on every request.
 * pi keeps the first registration of a tool name and Zeron's bridge loads first, so the tools
 * can't be re-registered with another exposure. Instead, this connects the same `zeron mcp`
 * server through pi's MCP support with `codemode` exposure (`tools.mcp__zeron__*`) and
 * deactivates the direct `zeron_*` duplicates.
 */
export default function (pi: ExtensionAPI) {
	const raw = process.env.ZERON_PI_MCP;
	// Not launched by Zeron: nothing to do.
	if (!raw) return;

	const { command, args, env } = JSON.parse(raw) as {
		command: string;
		args?: string[];
		env?: Record<string, string>;
	};
	pi.registerMcpServer("zeron", {
		command,
		args,
		env,
		exposure: "codemode",
		description:
			"Zeron workspace: create and message other agent chats (delegation), and show inline visuals in this chat.",
	});

	const dropDirectZeronTools = (): void => {
		const active = pi.getActiveTools();
		const kept = active.filter((name) => !name.startsWith("zeron_"));
		if (kept.length !== active.length) pi.setActiveTools(kept);
	};
	// Zeron's bridge registers its tools in its own session_start handler, which runs before this one.
	pi.on("session_start", dropDirectZeronTools);
	// Resume or /tree can restore the old loadout from the transcript, so check again before each run.
	pi.on("before_agent_start", dropDirectZeronTools);
}
