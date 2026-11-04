# pi-setup

**A lean [pi](https://pi.dev) setup in one command.** Sends the model about a third of the tokens on the first request.

```bash
curl -fsSL https://raw.githubusercontent.com/iyazerski/pi-setup/main/scripts/setup.sh | sh
```

- **~65% fewer input tokens.** The first request drops from ~20k to ~7k tokens. Web and [Zeron](https://zeron.sh) tools stay available, but their schemas are no longer sent with every request.
- **One script for every machine.** Works on a clean machine and on one that already has pi or Pi-Bolt. It adds only what is missing, so it is safe to run again.

## Contents

- [What's inside](#whats-inside)
- [Quick start](#quick-start)
- [What the setup script does](#what-the-setup-script-does)
- [Install the extensions only](#install-the-extensions-only)
- [Update](#update)
- [Troubleshooting](#troubleshooting)

## What's inside

pi lists every tool's schema in every request, and `codemode` lets the model call tools from a script instead. These extensions move bulky tools behind `codemode` and steer the model to use it:

| Extension | What it does | Saves |
| --- | --- | --- |
| [`codemode-first.ts`](extensions/codemode-first.ts) | Adds a short system prompt section that steers every model to batch work into `codemode` scripts instead of chains of direct tool calls. Only added while `codemode` is active. | Tool turns and context |
| [`web-codemode.ts`](extensions/web-codemode.ts) | Tells the model it can call [pi-web-access](https://github.com/nicobailon/pi-web-access) tools (`web_search`, `source_check`, `fetch_content`, `get_search_content`) from `codemode` scripts, and what they return. The setup script configures pi-web-access to stop sending their schemas and to drop its `web_enable` loader. | ~1k tokens per request |
| [`gui-subagents.ts`](extensions/gui-subagents.ts) | Adds `computer_use` (desktop apps through [cua-driver](https://github.com/trycua/cua/tree/main/libs/cua-driver)) and `browser_use` (Chrome through [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)). Each hands its task to a subagent on `gpt-6.1-terra`, from any provider you're logged in to, that calls only its own MCP server's tools, from `codemode` scripts, and returns a short report. The main agent never sees those MCP servers, screenshots, or page snapshots. `computer_use` is rarely needed, so like the web tools it has `deferred` exposure: callable from `codemode` scripts, but neither declared nor listed in the `codemode` description, and a one-line prompt section names it. Set `PI_GUI_SUBAGENT_MODEL` and `PI_GUI_SUBAGENT_THINKING` (default `medium`) to change the model and reasoning level. | Context and cost of GUI work |
| [`zeron-codemode.ts`](extensions/zeron-codemode.ts) | When pi runs inside [Zeron](https://zeron.sh), reconnects Zeron's agent tools as the `mcp__zeron` MCP server with `codemode` exposure, and turns off Zeron's direct `zeron_*` tools. Does nothing outside Zeron. | ~9k tokens per request |

The setup script also installs these packages:

- [pi-web-access](https://github.com/nicobailon/pi-web-access): web search, page and PDF fetching, GitHub repos, and videos.
- [dev-flows-plugin](https://github.com/iyazerski/dev-flows-plugin): skills for commits, draft PRs, chat distillation, and second opinions from other models. It also includes MCP servers for Python navigation, Chrome DevTools, and desktop automation.

## Quick start

Requirements: macOS or Linux, `curl`, `jq`, `git`, and [Bun](https://bun.sh). pi runs on Bun, so Node.js is not needed.

```bash
curl -fsSL https://raw.githubusercontent.com/iyazerski/pi-setup/main/scripts/setup.sh | sh
```

Then restart apps that run pi (such as Zeron) and start a new pi session. Sessions keep the tools they started with.

Already set up? Running the script again changes nothing and ends with `pi is already set up`.

## What the setup script does

[`scripts/setup.sh`](scripts/setup.sh) runs these steps in order. Each step is skipped when its result is already in place.

| Step | What happens | Skipped when |
| --- | --- | --- |
| 1. Install pi | Runs `bun add -g --ignore-scripts @earendil-works/pi-coding-agent`. | pi is installed with Bun |
| 2. Write the `pi` launcher | Writes `~/.local/bin/pi`, a small script that runs pi on Bun, so anything that runs `pi` (scripts, skills, Zeron) gets it. The `pi` that Bun links in `~/.bun/bin` starts with `#!/usr/bin/env node` and doesn't run without Node.js. | The launcher is up to date |
| 3. Remove Pi-Bolt | Uninstalls [Pi-Bolt](https://github.com/opensec-git/Pi-Bolt), which earlier versions of this script installed in place of pi: its `pi` and `pi-bolt` links and `~/.pi-bolt`. Settings, logins, sessions, and packages in `~/.pi/agent` stay, and pi uses them as is. | Pi-Bolt is not installed |
| 4. Use Bun for packages | Sets `"npmCommand": ["bun"]` in `~/.pi/agent/settings.json`, so pi installs and updates npm packages with Bun instead of npm. | It is set |
| 5. Install packages | Installs `pi-web-access`, this package, and `dev-flows-plugin`. | They are installed |
| 6. Configure pi-web-access | Sets `"toolExposure": "deferred"` and `"toolActivation": "none"` in `~/.pi/agent/web-search.json`, so the web tools are reached only from `codemode` scripts. Other settings stay. | Both are set |
| 7. Move GUI MCP servers | Removes `cua-driver` and `chrome-devtools` from `~/.pi/agent/mcp.json`, since `gui-subagents.ts` connects them only in its subagents. | They are not in `mcp.json` |
| 8. Warm prompt caches between runs | Sets `"cacheWarming": "idle"` in `~/.pi/agent/settings.json`, so pi keeps eligible prompt caches warm between runs too. Without it, a pause of more than 5 minutes rewrites the whole context to the cache. | It is set |
| 9. Cap context windows | Sets the context window of every available model above 250k tokens to 250k in `~/.pi/agent/models.json`, so compaction starts before requests get that large. Built-in and extension models get a `modelOverrides` entry; models defined in `models.json` are changed in place. Models with a smaller window keep it. Run the script again after you log in to a new provider. | No available model is above 250k |
| 10. Link `AGENTS.md` | Links `~/.agents/AGENTS.md` to `~/.pi/agent/AGENTS.md`, so pi follows your shared agent instructions. | There is no `~/.agents/AGENTS.md`, or the link exists |
| 11. Install MCP tools (macOS) | Runs dev-flows-plugin's [install script](https://github.com/iyazerski/dev-flows-plugin#mcp-servers) for the tools behind its MCP servers. It skips installed tools and prints its own status. | Linux |

**What it never does:**

- It never deletes your pi data. Only Pi-Bolt's program files are removed, after pi is installed.
- It never replaces a `~/.local/bin/pi` it didn't write, other than Pi-Bolt's link. It stops and names it.
- It never replaces a hand-written `~/.pi/agent/AGENTS.md`. It leaves the file and prints a warning.
- It never removes a pi installed another way, such as Homebrew or Nix. It stops and names it, so you can remove it with that tool and run the script again.

You don't need to link skills: pi reads `~/.agents/skills` directly.

<details>
<summary>Options</summary>

| Variable | Default | Effect |
| --- | --- | --- |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi's agent directory |

```bash
curl -fsSL https://raw.githubusercontent.com/iyazerski/pi-setup/main/scripts/setup.sh | PI_CODING_AGENT_DIR=~/.pi-work/agent sh
```

</details>

## Install the extensions only

To keep your current pi and add only the extensions:

```bash
pi install npm:pi-web-access
pi install git:github.com/iyazerski/pi-setup
```

`web-codemode.ts` needs `pi-web-access` 0.44.0 or newer with `"toolExposure": "deferred"` and `"toolActivation": "none"` in `~/.pi/agent/web-search.json`, and does nothing without it. `gui-subagents.ts` needs the `cua-driver` and `chrome-devtools-mcp` services from [dev-flows-plugin's install script](https://github.com/iyazerski/dev-flows-plugin#mcp-servers). Remove those two servers from `~/.pi/agent/mcp.json` with `pi mcp remove`, or the main agent can still reach them.

## Update

Update pi and every installed package:

```bash
pi update --all
```

Start a new session afterwards.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `warning: pi runs ..., not ~/.local/bin/pi` | Put `~/.local/bin` first on `PATH`, before `~/.bun/bin`, then open a new terminal. |
| `~/.local/bin/pi is not pi-setup's launcher` | Something else installed a `pi` there. Remove it with the tool that installed it, or move it away, then run the script again. |
| `another pi is installed here` | A second `pi` is on `PATH`, installed another way. Remove it with the tool that installed it, then run the script again. |
| `dev-flows-plugin's install script failed` | Read the error above it. It's usually a missing `jq` or Bun. Install it, then run the script again. |
| An app still runs the old pi or Pi-Bolt | Restart the app. Apps find `pi` when they start. |
| The model still sees the web or Zeron tool schemas | Start a new session. Sessions keep the tools they started with. |
