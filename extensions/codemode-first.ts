import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Steer every model to prefer codemode scripts over chains of direct tool calls. */
const CODEMODE_FIRST = `\`codemode\` is your fastest, most context-efficient way to work: one script replaces many tool turns, and only its return value reaches your context. Use it by default whenever a task needs more than one tool call:
- parallel reads, searches, or MCP calls;
- chained steps (search → fetch → read);
- large output (logs, search results, lists): filter or summarize in the script;
- loops over files, URLs, tickets, or records;
- edits across files, followed by a check (tests, \`git diff --stat\`) in the same script.

Use a direct call only for a single quick call whose full output you need.`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		// Only useful while codemode is available.
		if (!pi.getActiveTools().includes("codemode")) return;
		event.systemPromptOptions.sections.codemode_first = CODEMODE_FIRST;
	});
}
