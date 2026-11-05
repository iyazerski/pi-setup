import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Add a one-line hint to a tool result when the call drifts from tool-routing.ts's list.
 *
 * Rules in the system prompt alone didn't stop the habits: sessions still read files with sed -n and
 * edited them with Python scripts. A hint in the tool result lands right where the model decides its
 * next call, costs no extra turn (blocking the call would), and leaves the cached prompt alone.
 * Hints for calls made inside a codemode script are added to the script's result, since the script,
 * not the model, receives the nested result.
 */

export type HintKind = "edit" | "write" | "read" | "jq" | "sleep" | "batch" | "parallel";

const HINTS: Record<HintKind, string> = {
	edit: "Edit existing files with the `edit` tool, or `sd` for the same replacement in many places. Python and sed -i edits fail quietly when the text doesn't match.",
	write: "Create files with the `write` tool, not heredocs.",
	read: "Read files with the `read` tool (offset/limit), or parallel `tools.read` calls in codemode.",
	jq: "Use `jq` to read JSON, not a Python script.",
	sleep: "Poll in one command with a bounded loop and a timeout, not with sleep across turns.",
	parallel: "The file may not exist yet: calls in one message run in parallel. To read what another call creates, chain both in codemode.",
	batch: "Several turns of lookups in a row: batch the next ones that don't need you to look in between into one codemode script.",
};

const RUNS_SCRIPT = /\b(python3?|bun\s+-e|node\s+-e)\b/;
// Writes to stdout or stderr print, so they don't count.
const WRITES_FROM_SCRIPT = /\bwrite_text\(|(?<!\bsys\.std(out|err))\.write\(|\bopen\([^)]*,\s*["'][wa]|writeFileSync|Bun\.write\(/;
// A script that reads a file and changes its text edits it, unlike one that only writes new output.
const READS_FROM_SCRIPT = /\bread_text\(|\.read\(\)|readFileSync|Bun\.file\(/;
const CHANGES_TEXT = /\.replace\(|\.subn?\(|\.index\(/;
// sed -i, sed -Ei, perl -pi, ...
const EDITS_IN_PLACE = /\b(sed|perl)\s+(-\S+\s+)*-[a-zA-Z]*i/;
// `cat > file <<EOF`, `cat <<EOF > file`, `tee file <<EOF`, but not into /dev/null.
const HEREDOC_WRITE = /\b(cat\s*>>?\s*(?!\/dev\/)\S+\s*<<|cat\s+<<-?\s*\S+\s*>>?\s*(?!\/dev\/)\S|tee\s+(-a\s+)?(?!\/dev\/)\S+\s*<<)/;
const PARSES_JSON = /\bjson\.loads?\(|-m\s+json\.tool\b/;
// Scripts that do more than reshape JSON, where jq is no replacement.
const DOES_MORE = /\b(requests|urllib|http|subprocess|sqlite3|import\s+(?!json\b|sys\b)\w+)/;
// A command that reads a file, first in its pipeline: a file argument, not stdin.
const READS_FILE = /^(cat\s+(?!<<)[^\s|<>-]|head\s|tail\s(?!(.*\s)?(-[a-zA-Z]*[fF]|--follow))|sed\s+-n\s|nl\s)/;
const SLEEPS = /(^|[;&|\n(]\s*)sleep\s+\d/;
// Commands that run on another machine, where `read`, `edit`, and jq may not reach.
const REMOTE = /\b(ssh|docker\s+(exec|run)|kubectl\s+exec|adb\s+shell)\b/;
const LOOPS = /\b(while|until|for)\b/;
// Commands that only look things up, for counting turns of lookups in a row.
const LOOKUP_COMMANDS = new Set([
	"rg", "fd", "ls", "cat", "head", "tail", "sed", "nl", "wc", "jq", "tree", "pwd", "echo", "printf", "sort",
	"uniq", "cut", "tr", "awk", "file", "stat", "which", "command", "grep", "find", "du", "basename", "dirname",
	"readlink", "realpath", "cd", "true", "diff",
]);
const LOOKUP_GIT = /^git\s+(-C\s+\S+\s+)?(status|log|diff|show|blame|grep|ls-files|rev-parse|branch|remote)\b/;
// Lookups in a row before the batch hint: the third one gets it.
const BATCH_AFTER_TURNS = 2;
// Direct tool results to wait before repeating a hint: repeating it on every call adds noise, not habits.
const HINT_COOLDOWN = 10;

/** Split a command into its simple commands, at `;`, `&&`, `||`, newlines, and optionally pipes. */
export function segments(command: string, pipes: boolean): string[] {
	return command
		.split(pipes ? /&&|\|\||[;\n|]/ : /&&|\|\||[;\n]/)
		.map((part) => part.trim().replace(/^(\w+=\S*\s+)+/, ""))
		.filter(Boolean);
}

/** Return whether a command only looks things up and changes nothing. */
function isLookup(command: string): boolean {
	const unredirected = command.replace(/\d?>&\d|\d?>\s*\/dev\/null/g, "");
	if (/>|<</.test(unredirected) || EDITS_IN_PLACE.test(command) || RUNS_SCRIPT.test(command)) return false;
	return segments(unredirected, true).every(
		(part) => LOOKUP_COMMANDS.has(part.split(/\s/)[0]) || LOOKUP_GIT.test(part),
	);
}

/** Return the hints a bash command deserves, apart from the batch hint. */
export function commandHints(command: string): HintKind[] {
	const hints: HintKind[] = [];
	if (SLEEPS.test(command) && !LOOPS.test(command)) hints.push("sleep");
	// Only the part before the first remote command runs here.
	const remote = command.search(REMOTE);
	const local = remote < 0 ? command : command.slice(0, remote);
	const script = RUNS_SCRIPT.test(local);
	const writes = script && WRITES_FROM_SCRIPT.test(local);
	const rewrites = writes && READS_FROM_SCRIPT.test(local) && CHANGES_TEXT.test(local);
	if (rewrites || EDITS_IN_PLACE.test(local)) hints.push("edit");
	else if (HEREDOC_WRITE.test(local)) hints.push("write");
	if (script && !writes && PARSES_JSON.test(local) && !DOES_MORE.test(local)) hints.push("jq");
	if (segments(local, false).some((part) => READS_FILE.test(part))) hints.push("read");
	return hints;
}

/** Render hints as the text block appended to a tool result. */
function hintText(hints: Iterable<HintKind>): string {
	return [...hints].map((kind) => `Hint: ${HINTS[kind]}`).join("\n");
}

export default function (pi: ExtensionAPI) {
	// Hints from calls inside a codemode script, keyed by the script's tool call.
	const nested = new Map<string, Set<HintKind>>();
	// Turns in a row whose direct calls were all lookups in bash.
	let lookupTurns = 0;
	// What this turn's direct calls were: none yet, only bash lookups, or anything else.
	let turn: "none" | "lookup" | "other" = "none";
	// Names of this turn's direct calls, which all come from one message and run in parallel.
	const turnCalls = new Map<string, string>();
	// Direct tool results so far, and the one each hint was last shown on.
	let results = 0;
	const shown = new Map<HintKind, number>();

	pi.on("agent_start", () => {
		nested.clear();
		lookupTurns = 0;
	});
	pi.on("turn_start", () => {
		turn = "none";
		turnCalls.clear();
	});
	pi.on("tool_call", (event) => {
		if (!event.parentToolCallId) turnCalls.set(event.toolCallId, event.toolName);
	});
	pi.on("turn_end", () => {
		if (turn === "lookup") lookupTurns++;
		else if (turn === "other") lookupTurns = 0;
	});

	pi.on("tool_result", (event) => {
		const hints = new Set<HintKind>();
		const command = event.toolName === "bash" && typeof event.input.command === "string" ? event.input.command : "";
		if (command) for (const kind of commandHints(command)) hints.add(kind);
		// A read that fails on a missing file, next to a call that may be creating it.
		const siblings = [...turnCalls].filter(([id, name]) => id !== event.toolCallId && name !== "read");
		if (event.toolName === "read" && !event.parentToolCallId && event.isError && siblings.length > 0) {
			const text = event.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			if (text.includes("ENOENT")) hints.add("parallel");
		}

		if (event.parentToolCallId) {
			if (hints.size === 0) return;
			const pending = nested.get(event.parentToolCallId) ?? new Set<HintKind>();
			for (const kind of hints) pending.add(kind);
			nested.set(event.parentToolCallId, pending);
			return;
		}

		for (const kind of nested.get(event.toolCallId) ?? []) hints.add(kind);
		nested.delete(event.toolCallId);
		results++;

		const lookup = command !== "" && isLookup(command);
		if (!lookup) turn = "other";
		else if (turn === "none") {
			turn = "lookup";
			if (lookupTurns >= BATCH_AFTER_TURNS && pi.getActiveTools().includes("codemode")) {
				hints.add("batch");
				lookupTurns = 0;
			}
		}

		for (const kind of hints) {
			const last = shown.get(kind);
			if (last !== undefined && results - last < HINT_COOLDOWN) hints.delete(kind);
			else shown.set(kind, results);
		}
		if (hints.size === 0) return;
		return {
			content: [...event.content, { type: "text", text: hintText(hints) }],
			// Keep the machine-readable result, which replacing `content` alone would drop.
			structuredContent: event.structuredContent,
		};
	});
}
