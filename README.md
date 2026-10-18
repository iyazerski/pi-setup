# pi-setup

Personal [pi](https://pi.dev) setup, packaged so every machine gets the same behavior.

## What it does

| Extension | Effect |
|---|---|
| `extensions/codemode-first.ts` | Adds a short system prompt section that steers every model to use `codemode` scripts instead of chains of direct tool calls. Only added while `codemode` is active. |
| `extensions/web-codemode.ts` | Keeps [pi-web-access](https://github.com/nicobailon/pi-web-access) tools (`web_search`, `source_check`, `fetch_content`, `get_search_content`) callable from `codemode` scripts, but stops sending their schemas to the model (~3k tokens). Also hides the `web_enable` loader. |
| `extensions/zeron-codemode.ts` | When pi runs inside [Zeron](https://zeron.sh), reconnects Zeron's agent tools as the `mcp__zeron` MCP server with `codemode` exposure, and turns off Zeron's direct `zeron_*` tools (~9k tokens). Does nothing outside Zeron. |

Together they cut the first request from ~20k to ~7k input tokens.

## Set up a machine

```bash
curl -fsSL https://raw.githubusercontent.com/iyazerski/pi-setup/main/scripts/setup.sh | sh
```

`scripts/setup.sh` works on a clean machine and on one that already has pi. It adds only what is missing, and does nothing when everything is in place, so it is safe to run again:

1. Installs [Pi-Bolt](https://github.com/opensec-git/Pi-Bolt), the same pi compiled to native code (faster start, less CPU and memory).
2. Uninstalls pi if present (managed or npm install). Settings, logins, sessions, and packages in `~/.pi/agent` stay, and Pi-Bolt uses them as is.
3. Links `pi` to `pi-bolt` in `~/.local/bin`, so anything that runs `pi` (scripts, skills, Zeron) gets Pi-Bolt. Restart such apps afterwards.
4. Installs this package and `pi-web-access`, if missing.
5. Links `~/.agents/AGENTS.md` to `~/.pi/agent/AGENTS.md`, if it exists. An existing `~/.pi/agent/AGENTS.md` that is not that link is left as is, with a warning. Skills in `~/.agents/skills` need no link: pi reads that directory itself.

macOS and Linux only. Needs `curl`, and `git` for this package. If pi was installed another way (Homebrew, Nix), the script stops and names it: remove it with that tool and run the script again. To go back to pi, delete the `~/.local/bin/pi` link and install pi again.

To install only this package on an existing pi:

```bash
pi install git:github.com/iyazerski/pi-setup
```

Start a new session after installing or updating. Sessions keep the tools they started with.

## Update

```bash
pi update --all
```
