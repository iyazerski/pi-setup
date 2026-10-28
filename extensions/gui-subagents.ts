import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/**
 * Run desktop and browser automation in subagents instead of the main agent.
 *
 * Screenshots, accessibility trees, and DOM snapshots fill the context fast, and the main agent
 * only needs the outcome. So the cua-driver and chrome-devtools MCP servers are not connected in
 * the main session at all. Instead, `computer_use` and `browser_use` hand a task to a child pi
 * process that runs a model tuned for computer use, sees only its own server's tools, and returns
 * a short report. Each tool keeps one child session per main session, so follow-up calls continue
 * on the same app or page.
 *
 * The child loads only this extension, codemode, and MCP support, with PI_GUI_SUBAGENT naming its
 * role. There it registers its MCP server with `codemode` exposure and sets the role prompt. In a
 * benchmark against direct tool calls, codemode was cheaper: requests leave out the tool schemas
 * (62 for cua-driver), and scripts batch steps and filter large snapshots.
 * The servers must not also be in mcp.json, or the main agent would reach them too (setup.sh
 * removes them).
 */

const ROLE_ENV = "PI_GUI_SUBAGENT";
// No provider prefix: pi picks a provider with credentials (OpenAI, LiteLLM, ...) that offers it.
const MODEL = process.env.PI_GUI_SUBAGENT_MODEL ?? "gpt-6.1-terra";
const THINKING = process.env.PI_GUI_SUBAGENT_THINKING ?? "medium";
// A stuck child keeps paying for tokens: stop it after this long.
const TIMEOUT_MS = 20 * 60_000;
const SESSION_DIR = path.join(getAgentDir(), "gui-subagent-sessions");
const COLLAPSED_STEPS = 5;
// How long the subagent waits for its MCP server before the first request.
const SERVER_WAIT_MS = 15_000;
const STDERR_TAIL = 2000;

const REPORT_FORMAT = `The caller can't see the screen or your tool output. It only gets your final message, so end with this report and keep it short:

Status: done | failed | needs_input
Result: what you found or did, with exact values.
Evidence: URLs, visible text, or file paths that prove it.
Notes: only what the caller must know, such as side effects or blockers.`;

const SAFETY = `Never send messages, post, submit forms, buy, delete, or change settings or accounts unless the task explicitly asks for it. Stop and report \`needs_input\` when a login, 2FA, CAPTCHA, permission prompt, or an unclear choice blocks you. Don't guess.`;

interface Role {
	tool: string;
	label: string;
	server: string;
	serverConfig: { command: string; args: string[] } | { url: string };
	description: string;
	prompt: string;
	// `deferred` keeps a rarely used tool out of every request, schema and codemode listing alike,
	// like the web tools: the gui_subagents prompt section names it instead.
	exposure: "direct" | "deferred";
	// A rule for the main agent, added to the gui_subagents prompt section while the tool is reachable.
	mainRule?: string;
}

const ROLES: Record<string, Role> = {
	computer: {
		tool: "computer_use",
		label: "Computer Use",
		server: "cua-driver",
		serverConfig: { command: "cua-driver", args: ["mcp"] },
		description: [
			"Delegate a macOS desktop task (native apps, windows, menus, dialogs) to a computer-use subagent driving cua-driver.",
			"It runs in the background on the user's real desktop and returns a short report: Status (done, failed, needs_input), Result, Evidence, Notes.",
			"The subagent only sees `task`, so make it self-contained: app, exact goal, input values, and what to report back.",
			"It keeps its state between calls in this session, so follow-ups can say 'now click Save'.",
			"For web pages in Chrome, use browser_use. For outcomes reachable by a CLI, API, or file, use those instead, but not UI scripting such as osascript.",
		].join(" "),
		exposure: "deferred",
		// Main agents fell back to osascript, which hung on a macOS automation permission prompt.
		mainRule:
			"To control or inspect macOS apps, windows, or menus, use `computer_use`, not your own osascript, AppleScript, JXA, or other UI scripting: those trigger macOS permission prompts that block until the user answers.",
		prompt: `You are a computer-use subagent on the user's macOS desktop. Another agent gave you a task. Do it with the cua-driver tools and follow their guidance: read windows narrowly by query, act by element token through run_steps, and verify at checkpoints. Call get_guide when unsure. Don't quit apps or close windows you didn't open.

${SAFETY}

${REPORT_FORMAT}`,
	},
	browser: {
		tool: "browser_use",
		label: "Browser Use",
		server: "chrome-devtools",
		serverConfig: { url: "http://127.0.0.1:8765/chrome-devtools/mcp" },
		description: [
			"Delegate a web task in the user's running Chrome (browse, read pages, fill forms, check console or network, debug a page) to a browser subagent driving chrome-devtools.",
			"It returns a short report: Status (done, failed, needs_input), Result, Evidence, Notes.",
			"The subagent only sees `task`, so make it self-contained: URL, exact goal, input values, and what to report back. Ask it to save a screenshot to a file path when you need visual proof.",
			"It keeps its state between calls in this session, so follow-ups can say 'now open the second result'.",
			"For plain page content without interaction or login, prefer the web tools.",
		].join(" "),
		exposure: "direct",
		prompt: `You are a browser subagent in the user's running Chrome. Another agent gave you a task. Do it with the chrome-devtools tools:
- Open your own tab with new_page and pass its pageId to page tools. Never navigate or close tabs you didn't open. Close your tabs when done, unless the task says to keep them.
- Read pages with take_snapshot (text and element uids). Take screenshots only when the layout matters, and save them to a file with filePath when the task asks for visual proof.
- If Chrome isn't reachable, report it as failed: the caller can start Chrome.

${SAFETY}

${REPORT_FORMAT}`,
	},
};

interface Step {
	tool: string;
	args: string;
}

interface RunDetails {
	model: string;
	steps: Step[];
	usage: Usage;
	sessionId: string;
	stopReason?: string;
	error?: string;
	done: boolean;
}

const params = Type.Object({
	task: Type.String({
		description: "Self-contained task: the goal, the app or URL, input values, and what to report back.",
	}),
});

/** Return an empty usage record to add child usage into. */
function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Add one assistant message's usage to the running total. */
function addUsage(total: Usage, usage: Usage): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

/** Return the text of the last assistant message, the child's report. */
function finalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

/** Return the command that starts another pi like this one, as the subagent example does. */
function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	// A compiled pi (Bun or Pi-Bolt) has its entry point inside the executable.
	if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	if (!/^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath))) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

/** Format a token count as 1.2k or 34k. */
function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

/** Summarize a run's steps, tokens, and cost in one line. */
function formatStats(details: RunDetails): string {
	const { usage } = details;
	return [
		`${details.steps.length} steps`,
		`↑${formatTokens(usage.input)}`,
		`↓${formatTokens(usage.output)}`,
		usage.cacheRead ? `R${formatTokens(usage.cacheRead)}` : "",
		`$${usage.cost.total.toFixed(4)}`,
		details.model,
	]
		.filter(Boolean)
		.join(" ");
}

/** Return the prefix pi gives the tools of an MCP server. */
function toolPrefix(server: string): string {
	return `mcp__${server.replace(/-/g, "_")}__`;
}

/** Describe a child tool call in one short line, without the MCP server prefix. */
function describeStep(tool: string, args: unknown, prefix: string): Step {
	const name = tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;
	const json = JSON.stringify(args) ?? "";
	return { tool: name, args: json.length > 80 ? `${json.slice(0, 80)}…` : json };
}

/** Register the role's MCP server and prompt: this process is a GUI subagent. */
function setUpSubagent(pi: ExtensionAPI, role: Role): void {
	pi.registerMcpServer(role.server, { ...role.serverConfig, exposure: "codemode" });
	const prefix = toolPrefix(role.server);

	pi.on("before_agent_start", async (event) => {
		const { sections } = event.systemPromptOptions;
		sections.gui_subagent = `${role.prompt}

Your ${role.server} tools are callable only from \`codemode\` scripts, as \`tools.${prefix}<name>(args)\`; \`describeTool(name)\` gives exact parameters. Batch steps that don't need you to look in between into one script. Filter large results (snapshots, trees, lists) inside the script and return only what you need. Use \`image(result.content[i])\` to see a screenshot.`;
		// Pi lists server instructions only for codemode and deferred servers, and the server may
		// still be connecting. It connects in well under a second, so wait for its tools.
		const deadline = Date.now() + SERVER_WAIT_MS;
		let tool = pi.getAllTools().find((candidate) => candidate.name.startsWith(prefix));
		while (!tool && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			tool = pi.getAllTools().find((candidate) => candidate.name.startsWith(prefix));
		}
		const instructions = tool?.namespace?.instructions;
		if (instructions) {
			sections.server_instructions = `<server_instructions server="${role.server}">\n${instructions}\n</server_instructions>`;
		}
	});
}

/** Register the delegating tools in the main session. */
function setUpMain(pi: ExtensionAPI): void {
	const extensionPath = fileURLToPath(import.meta.url);

	for (const [roleName, role] of Object.entries(ROLES)) {
		pi.registerTool({
			name: role.tool,
			label: role.label,
			description: role.description,
			parameters: params,
			exposure: role.exposure,
			// Calls of one tool share a child session, so they can't run in parallel.
			executionMode: "sequential",

			async execute(_toolCallId, { task }, signal, onUpdate, ctx) {
				// One child session per main session and role, kept across calls.
				const sessionId = `${ctx.sessionManager.getSessionId()}-${roleName}`;
				const args = [
					"--mode",
					"json",
					"-p",
					"--session-dir",
					SESSION_DIR,
					"--session-id",
					sessionId,
					"--model",
					MODEL,
					"--thinking",
					THINKING,
					// Only this extension, MCP, and codemode: no other tools, skills, or prompt templates.
					"--no-extensions",
					"-e",
					"builtin:mcp",
					"-e",
					"builtin:codemode",
					"-e",
					extensionPath,
					"--no-skills",
					"--no-prompt-templates",
					// AGENTS.md is about coding: the role prompt carries the rules that apply here.
					"--no-context-files",
					// Declares only codemode, and scripts reach only this role's MCP server.
					"--tools",
					`codemode,${toolPrefix(role.server)}*`,
				];
				const details: RunDetails = { model: MODEL, steps: [], usage: emptyUsage(), sessionId, done: false };
				const messages: Message[] = [];
				let stderr = "";

				const emit = (): void => {
					const last = details.steps.at(-1);
					onUpdate?.({
						content: [{ type: "text", text: last ? `${details.steps.length} steps, last: ${last.tool}` : "starting…" }],
						details: { ...details, steps: [...details.steps] },
					});
				};

				const handleEvent = (event: { type: string; [key: string]: unknown }): void => {
					if (event.type === "tool_execution_start") {
						details.steps.push(describeStep(event.toolName as string, event.args, toolPrefix(role.server)));
						emit();
					} else if (event.type === "message_end") {
						const message = event.message as Message;
						messages.push(message);
						if (message.role === "assistant") {
							addUsage(details.usage, message.usage);
							details.stopReason = message.stopReason;
							details.error = message.errorMessage;
						}
					}
				};

				const { command, args: commandArgs } = piInvocation(args);
				const exitCode = await new Promise<number>((resolve, reject) => {
					const child = spawn(command, commandArgs, {
						cwd: ctx.cwd,
						env: { ...process.env, [ROLE_ENV]: roleName },
						stdio: ["pipe", "pipe", "pipe"],
					});
					// The task goes through stdin, so pi never reads a leading `-` as an option or `@path` as a file.
					child.stdin.end(task);
					let buffer = "";
					let timedOut = false;
					const stop = (): void => {
						child.kill("SIGTERM");
						setTimeout(() => child.kill("SIGKILL"), 5000).unref();
					};
					const timer = setTimeout(() => {
						timedOut = true;
						stop();
					}, TIMEOUT_MS);
					if (signal?.aborted) stop();
					else signal?.addEventListener("abort", stop, { once: true });
					let parseError: Error | undefined;

					// JSONL records end with LF only; Unicode line separators may appear inside strings.
					child.stdout.setEncoding("utf8");
					child.stdout.on("data", (chunk: string) => {
						const lines = (buffer + chunk).split("\n");
						buffer = lines.pop() ?? "";
						for (const raw of lines) {
							const line = raw.replace(/\r$/, "");
							if (!line.trim()) continue;
							try {
								handleEvent(JSON.parse(line));
							} catch (error) {
								parseError = new Error(`${role.tool} got invalid output from pi: ${String(error)}`);
								stop();
							}
						}
					});
					child.stderr.setEncoding("utf8");
					child.stderr.on("data", (chunk: string) => {
						// Only the tail is reported, so don't keep more.
						stderr = (stderr + chunk).slice(-STDERR_TAIL);
					});
					child.on("error", reject);
					child.on("close", (code) => {
						clearTimeout(timer);
						signal?.removeEventListener("abort", stop);
						if (parseError) reject(parseError);
						else if (signal?.aborted) reject(new Error(`${role.tool} was aborted`));
						else if (timedOut) reject(new Error(`${role.tool} timed out after ${TIMEOUT_MS / 60_000} minutes`));
						else resolve(code ?? 1);
					});
				});

				details.done = true;
				const report = finalText(messages);
				const failed = exitCode !== 0 || details.stopReason === "error" || details.stopReason === "aborted";
				const text = failed
					? `${role.tool} failed (exit ${exitCode}, ${details.stopReason ?? "no response"}): ${details.error ?? (stderr.trim() || report || "no output")}`
					: report || "(the subagent returned no report)";
				return {
					content: [{ type: "text", text }],
					details,
					// Count the child's tokens in this session's totals.
					usage: details.usage,
					isError: failed,
				};
			},

			renderCall(args, theme) {
				const task = args.task ?? "";
				const preview = task.length > 100 ? `${task.slice(0, 100)}…` : task;
				return new Text(`${theme.fg("toolTitle", theme.bold(`${role.tool} `))}${theme.fg("dim", preview)}`, 0, 0);
			},

			renderResult(result, { expanded }, theme) {
				const details = result.details as RunDetails | undefined;
				const first = result.content[0];
				const text = first?.type === "text" ? first.text : "";
				if (!details) return new Text(text, 0, 0);

				const steps = expanded ? details.steps : details.steps.slice(-COLLAPSED_STEPS);
				const lines: string[] = [];
				const hidden = details.steps.length - steps.length;
				if (hidden > 0) lines.push(theme.fg("muted", `… ${hidden} earlier steps`));
				for (const step of steps) {
					lines.push(`${theme.fg("muted", "→ ")}${theme.fg("accent", step.tool)} ${theme.fg("dim", step.args)}`);
				}
				lines.push(theme.fg("dim", formatStats(details)));

				const container = new Container();
				container.addChild(new Text(lines.join("\n"), 0, 0));
				if (details.done) {
					container.addChild(new Spacer(1));
					const report = expanded ? text : text.split("\n").slice(0, 6).join("\n");
					container.addChild(new Markdown(report, 0, 0, getMarkdownTheme()));
				}
				return container;
			},
		});
	}

	pi.on("before_agent_start", (event) => {
		const active = pi.getActiveTools();
		// Deferred tools are reached here from codemode scripts, so only while codemode is active.
		const reachable = (role: Role): boolean =>
			active.includes(role.exposure === "deferred" ? "codemode" : role.tool);
		const tools = Object.values(ROLES).filter(reachable);
		if (tools.length === 0) return;
		const name = (role: Role): string =>
			role.exposure === "deferred" ? `\`tools.${role.tool}({ task })\` in \`codemode\` (${role.server})` : `\`${role.tool}\` (${role.server})`;
		// Instructions shared across harnesses may name these MCP servers: point the model to the tools.
		event.systemPromptOptions.sections.gui_subagents = [
			`Desktop and browser automation run in subagents: ${tools.map(name).join(", ")}.`,
			"Their MCP servers aren't connected here, so call these tools instead, also when instructions name those servers.",
			"Give each call one self-contained task. Check the reported Status and Evidence before you rely on the result.",
			...tools.flatMap((role) => (role.mainRule ? [role.mainRule] : [])),
		].join("\n");
	});
}

export default function (pi: ExtensionAPI) {
	const roleName = process.env[ROLE_ENV];
	if (!roleName) {
		setUpMain(pi);
		return;
	}
	const role = ROLES[roleName];
	if (!role) throw new Error(`Unknown ${ROLE_ENV}: ${roleName}`);
	setUpSubagent(pi, role);
}
