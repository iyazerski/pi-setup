# pi-setup

Personal [pi](https://pi.dev) setup, packaged so every machine gets the same behavior.

## What it does

| Extension | Effect |
|---|---|
| `extensions/codemode-first.ts` | Adds a short system prompt section that steers every model to use `codemode` scripts instead of chains of direct tool calls. Only added while `codemode` is active. |
| `extensions/web-codemode.ts` | Keeps [pi-web-access](https://github.com/nicobailon/pi-web-access) tools (`web_search`, `source_check`, `fetch_content`, `get_search_content`) callable from `codemode` scripts, but stops sending their schemas to the model (~3k tokens). Also hides the `web_enable` loader. |
| `extensions/zeron-codemode.ts` | When pi runs inside [Zeron](https://zeron.sh), reconnects Zeron's agent tools as the `mcp__zeron` MCP server with `codemode` exposure, and turns off Zeron's direct `zeron_*` tools (~9k tokens). Does nothing outside Zeron. |

Together they cut the first request from ~20k to ~7k input tokens.

## Install

```bash
pi install git:github.com/iyazerski/pi-setup
```

Codemode must be on, for example in `~/.pi/agent/settings.json`:

```json
{ "defaultTools": ["+codemode"] }
```

`web-codemode.ts` expects `pi-web-access` (`pi install npm:pi-web-access`). Without it, it does nothing.

Start a new session after installing or updating. Sessions keep the tools they started with.

## Update and remove

```bash
pi update --extensions
pi remove git:github.com/iyazerski/pi-setup
```
