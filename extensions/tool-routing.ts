import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Tell the model which tool to use for each kind of work, in one decision list.
 *
 * A model turn takes seconds, while starting rg, jq, python, or bun takes milliseconds. So the list
 * routes work by turns and output, not by runtime: batch into codemode, read with `read`, edit with
 * `edit`. It replaces pi's own codemode and read rules, which say less and would repeat it, and the
 * bash snippet's "(ls, grep, find, etc.)", which points the model at the wrong tools.
 * tool-hints.ts nudges the model when it drifts from the list anyway.
 */

const TOOL_ROUTING = `Model turns take seconds and tool runs take milliseconds, so cut turns and output first.
- One quick call whose full output you need: call the tool directly.
- Anything else: one \`codemode\` script. That covers parallel searches and reads, chained steps, loops over files or records, MCP and web calls, large output to filter, and edits followed by a check (tests, \`git diff --stat\`).
- Calls in one message run in parallel. When a step needs another step's output, such as reading a file a command creates, chain them in codemode.
- Search: \`rg\` for content, \`fd\` for file names, not grep or find. \`rg -n -C\` is fine to see matches in context.
- Read files: \`read\` with offset/limit once you know the file, not cat, head, tail, or sed -n. For many files or ranges, run \`tools.read\` calls in parallel in codemode.
- JSON: \`jq\` for files and command output, \`JSON.parse\` for tool results in codemode.
- Edit files: \`edit\` by default, with all changes to one file in one call. Across files, call \`tools.edit\` in a codemode loop, then run the check. Use \`sd\` only for the same literal replacement in many places, and count matches with \`rg -c\` before and after. Don't edit files with Python, sed -i, or heredocs.
- Create files: \`write\`, not cat or tee heredocs.
- Inline scripts only when the logic needs a real language or library: codemode JS for tool results, otherwise \`bun -e\` or \`uv run python -\`.
- Waiting: poll in one command with a bounded loop and a timeout, or start the work in the background and check once. Don't sleep across turns. codemode has no timers, so wait in bash.`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		if (options.toolSnippets.bash) options.toolSnippets.bash = "Execute bash commands in the cwd, fresh each call (rg, fd, jq, git, etc.)";
		// The list routes work through codemode, so it only applies while codemode is available.
		if (!pi.getActiveTools().includes("codemode")) return;
		options.sections.tool_routing = TOOL_ROUTING;
		// The list covers these built-in rules.
		options.toolGuidelines.read = (options.toolGuidelines.read ?? []).filter(
			(rule) => !rule.startsWith("Use read to examine files"),
		);
		options.toolGuidelines.codemode = (options.toolGuidelines.codemode ?? []).filter(
			(rule) => !rule.startsWith("Use codemode to batch"),
		);
	});
}
