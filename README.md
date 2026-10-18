# pi-setup

**A lean, fast [pi](https://pi.dev) setup in one command.** Runs pi as native code and sends the model about a third of the tokens on the first request.

```bash
curl -fsSL https://raw.githubusercontent.com/iyazerski/pi-setup/main/scripts/setup.sh | sh
```

- **~65% fewer input tokens.** The first request drops from ~20k to ~7k tokens. Web and [Zeron](https://zeron.sh) tools stay available, but their schemas are no longer sent with every request.
- **Faster and lighter pi.** Installs [Pi-Bolt](https://github.com/opensec-git/Pi-Bolt), the same pi compiled ahead of time to native code. It starts faster and uses less CPU and memory, with the same commands, settings, and sessions.
- **One script for every machine.** Works on a clean machine and on one that already has pi. It adds only what is missing, so it is safe to run again.

## Contents

- [What's inside](#whats-inside)
- [Quick start](#quick-start)
- [What the setup script does](#what-the-setup-script-does)
- [Install the extensions only](#install-the-extensions-only)
- [Update](#update)
- [Go back to pi](#go-back-to-pi)
- [Troubleshooting](#troubleshooting)

## What's inside

pi lists every tool's schema in every request, and `codemode` lets the model call tools from a script instead. These extensions move bulky tools behind `codemode` and steer the model to use it:

| Extension | What it does | Saves |
| --- | --- | --- |
| [`codemode-first.ts`](extensions/codemode-first.ts) | Adds a short system prompt section that steers every model to batch work into `codemode` scripts instead of chains of direct tool calls. Only added while `codemode` is active. | Tool turns and context |
| [`web-codemode.ts`](extensions/web-codemode.ts) | Keeps [pi-web-access](https://github.com/nicobailon/pi-web-access) tools (`web_search`, `source_check`, `fetch_content`, `get_search_content`) callable from `codemode` scripts, but stops sending their schemas. Also hides the `web_enable` loader. | ~3k tokens per request |
| [`zeron-codemode.ts`](extensions/zeron-codemode.ts) | When pi runs inside [Zeron](https://zeron.sh), reconnects Zeron's agent tools as the `mcp__zeron` MCP server with `codemode` exposure, and turns off Zeron's direct `zeron_*` tools. Does nothing outside Zeron. | ~9k tokens per request |

The setup script also installs these packages:

- [pi-web-access](https://github.com/nicobailon/pi-web-access): web search, page and PDF fetching, GitHub repos, and videos.
- [dev-flows-plugin](https://github.com/iyazerski/dev-flows-plugin): skills for commits, draft PRs, chat distillation, and second opinions from other models. It also includes MCP servers for Python navigation, Chrome DevTools, and desktop automation.

## Quick start

Requirements: macOS or Linux, `curl`, and `git`.

```bash
curl -fsSL https://raw.githubusercontent.com/iyazerski/pi-setup/main/scripts/setup.sh | sh
```

Then restart apps that run pi (such as Zeron) and start a new pi session. Sessions keep the tools they started with.

Already set up? Running the script again changes nothing and ends with `pi is already set up`.

## What the setup script does

[`scripts/setup.sh`](scripts/setup.sh) runs these steps in order. Each step is skipped when its result is already in place.

| Step | What happens | Skipped when |
| --- | --- | --- |
| 1. Install Pi-Bolt | Installs [Pi-Bolt](https://github.com/opensec-git/Pi-Bolt) to `~/.pi-bolt`, with `pi-bolt` in `~/.local/bin`. | `pi-bolt` is installed |
| 2. Remove pi | Uninstalls pi, from a managed install ([pi.dev/install.sh](https://pi.dev)) or a global npm install. Settings, logins, sessions, and packages in `~/.pi/agent` stay, and Pi-Bolt uses them as is. | No other `pi` is on `PATH` |
| 3. Link `pi` | Links `~/.local/bin/pi` to `pi-bolt`, so anything that runs `pi` (scripts, skills, Zeron) gets Pi-Bolt. | The link exists |
| 4. Install packages | Installs `pi-web-access`, this package, and `dev-flows-plugin`. | They are installed |
| 5. Link `AGENTS.md` | Links `~/.agents/AGENTS.md` to `~/.pi/agent/AGENTS.md`, so pi follows your shared agent instructions. | There is no `~/.agents/AGENTS.md`, or the link exists |
| 6. Install MCP tools (macOS) | Runs dev-flows-plugin's [install script](https://github.com/iyazerski/dev-flows-plugin#mcp-servers) for the tools behind its MCP servers. It skips installed tools and prints its own status. | Linux |

**What it never does:**

- It never deletes your pi data. Only pi's program files are removed.
- It never replaces a hand-written `~/.pi/agent/AGENTS.md`. It leaves the file and prints a warning.
- It never removes a pi installed another way, such as Homebrew or Nix. It stops and names it, so you can remove it with that tool and run the script again.

You don't need to link skills: pi reads `~/.agents/skills` directly.

<details>
<summary>Options</summary>

| Variable | Default | Effect |
| --- | --- | --- |
| `PIBOLT_BIN_DIR` | `~/.local/bin` | Where `pi-bolt` and the `pi` link go |
| `PIBOLT_VARIANT` | Installer's choice | Pi-Bolt build, for example `arm64-jit` for heavy extensions |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi's agent directory |

```bash
curl -fsSL https://raw.githubusercontent.com/iyazerski/pi-setup/main/scripts/setup.sh | PIBOLT_VARIANT=arm64-jit sh
```

</details>

## Install the extensions only

To keep your current pi and add only the extensions:

```bash
pi install npm:pi-web-access
pi install git:github.com/iyazerski/pi-setup
```

`web-codemode.ts` needs `pi-web-access`, and does nothing without it.

## Update

Update Pi-Bolt and every installed package:

```bash
pi update --all
```

Start a new session afterwards.

## Go back to pi

```bash
rm ~/.local/bin/pi
curl -fsSL https://pi.dev/install.sh | sh
```

Your settings, sessions, and packages in `~/.pi/agent` work with both. To also remove Pi-Bolt, run `curl -fsSL https://pi-bolt.opensec.in/install.sh | sh` and choose uninstall.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `warning: pi runs ..., not ~/.local/bin/pi` | Put `~/.local/bin` first on `PATH`, then open a new terminal. |
| `pi is still installed here` | That pi was installed another way, for example with Homebrew or Nix. Remove it with the tool that installed it, then run the script again. |
| `dev-flows-plugin's install script failed` | Read the error above it. It's usually a missing `jq` or Node.js. Install it, then run the script again. |
| An app still runs the old pi | Restart the app. Apps find `pi` when they start. |
| The model still sees the web or Zeron tool schemas | Start a new session. Sessions keep the tools they started with. |
