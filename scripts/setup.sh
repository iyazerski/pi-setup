#!/bin/sh
# Set up pi on this machine, from scratch or by adding what is missing. Does nothing when everything is in place.
#
#   curl -fsSL https://raw.githubusercontent.com/iyazerski/pi-setup/main/scripts/setup.sh | sh
#
# 1. Installs pi with Bun (`bun add -g`), unless it is installed there.
# 2. Writes ~/.local/bin/pi, a launcher that runs that pi on Bun. The `pi` Bun links starts with
#    `#!/usr/bin/env node`, and does not run without Node.js.
# 3. Uninstalls Pi-Bolt (https://github.com/opensec-git/Pi-Bolt), which earlier versions of this script installed in
#    place of pi: its `pi` and `pi-bolt` links and its install directory. The agent directory stays, pi uses its
#    settings, logins, sessions and packages as is.
# 4. Sets npmCommand to ["bun"] in settings.json, so pi installs and updates npm packages with Bun instead of npm.
# 5. Installs the packages in PACKAGES that are missing.
# 6. Sets pi-web-access's toolExposure to "deferred" and toolActivation to "none" in web-search.json, so its tools are
#    reached only from codemode scripts and their schemas are not sent with every request.
# 7. Removes the cua-driver and chrome-devtools MCP servers from mcp.json: pi-setup's gui-subagents.ts runs them in
#    subagents, and the main agent must not reach them.
# 8. Sets cacheWarming to "idle" in settings.json, so pi keeps eligible prompt caches warm between runs too, and a pause
#    of more than 5 minutes does not rewrite the whole context.
# 9. Caps the context window of every available model at CONTEXT_WINDOW tokens in models.json, so compaction starts
#    before requests grow past it: with a modelOverrides entry for built-in and extension models, and on the entry
#    itself for models defined in models.json. Models with a smaller window keep it.
# 10. Links ~/.agents/AGENTS.md into the agent directory, if it exists. Skills in ~/.agents/skills need no link: pi reads
#     that directory itself, and a link would load every skill twice.
# 11. On macOS, runs dev-flows-plugin's own install script, which installs the tools its MCP servers need and skips the
#     installed ones. It prints its own status.
#
# macOS and Linux only. Needs Bun, jq, and git for git packages.
#
# Environment:
#   PI_CODING_AGENT_DIR  pi's agent directory (default: ~/.pi/agent)
set -eu

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PI_PACKAGE="@earendil-works/pi-coding-agent"
# The `pi` that scripts, skills and apps (such as Zeron) run.
PI="$HOME/.local/bin/pi"
# The launcher's second line, which tells it apart from a `pi` this script did not write.
LAUNCHER_MARK="# pi-setup's pi launcher: runs pi, installed with Bun, on Bun, so that it needs no Node.js."
# Pi-Bolt's default install directory, where earlier versions of this script put it.
PIBOLT_HOME="$HOME/.pi-bolt"
PACKAGES="npm:pi-web-access git:github.com/iyazerski/pi-setup git:github.com/iyazerski/dev-flows-plugin"
DEV_FLOWS="git:github.com/iyazerski/dev-flows-plugin"
# MCP servers that gui-subagents.ts connects only in its subagents.
GUI_MCP_SERVERS="cua-driver chrome-devtools"
AGENTS_MD="$HOME/.agents/AGENTS.md"
# The largest context window, in tokens, any model may use.
CONTEXT_WINDOW=250000
NL='
'
CHANGED=0
# The `pi` Bun links, set by ensure_pi.
PI_SCRIPT=""

say() { printf '==> %s\n' "$1"; }
fail() {
	printf 'error: %s\n' "$1" >&2
	exit 1
}

# Print the path a command finally points to, following every symlink, with its directory made absolute.
resolve() {
	path=$1
	while [ -L "$path" ]; do
		target=$(readlink "$path")
		case $target in
		/*) path=$target ;;
		*) path=${path%/*}/$target ;;
		esac
	done
	dir=$(cd -P "${path%/*}" 2>/dev/null && pwd -P) || dir=${path%/*}
	printf '%s/%s' "$dir" "${path##*/}"
}

# List every command with this name on PATH, in PATH order, one per line. Broken links count too.
commands_named() {
	old_ifs=$IFS
	IFS=:
	for dir in $PATH; do
		if [ -n "$dir" ] && { [ -x "$dir/$1" ] || [ -L "$dir/$1" ]; }; then printf '%s\n' "$dir/$1"; fi
	done
	IFS=$old_ifs
}

# Whether a command is a link into Pi-Bolt's install directory, also one whose target is gone.
is_pi_bolt_link() {
	[ -L "$1" ] || return 1
	# resolve() prints physical paths, so the directory is compared as one too.
	home=$(cd -P "$PIBOLT_HOME" 2>/dev/null && pwd -P) || home=$PIBOLT_HOME
	case $(resolve "$1") in "$home"/*) return 0 ;; esac
	return 1
}

# Whether a file is a launcher this script wrote, of any version.
is_launcher() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(sed -n 2p "$1")" = "$LAUNCHER_MARK" ]; }

# Run pi from the home directory without project-local files, so a project's settings never leak into the setup.
run_pi() { (cd "$HOME" && "$PI" "$@" --no-approve); }

ensure_pi() {
	bun_bin=$(bun pm bin -g) || fail "could not find Bun's global bin directory"
	PI_SCRIPT="$bun_bin/pi"
	if [ -e "$PI_SCRIPT" ] && bun "$PI_SCRIPT" --version >/dev/null 2>&1; then return 0; fi
	say "Installing $PI_PACKAGE with Bun"
	# Like pi's own installers and `pi update`: pi needs none of its dependencies' install scripts.
	bun add -g --ignore-scripts "$PI_PACKAGE"
	bun "$PI_SCRIPT" --version >/dev/null 2>&1 || fail "pi did not install to $PI_SCRIPT"
	CHANGED=1
}

ensure_launcher() {
	# Absolute paths, so it runs also where Bun's bin directory is not on PATH. `pi update` keeps both paths.
	content="#!/bin/sh
$LAUNCHER_MARK
exec '$(command -v bun)' '$PI_SCRIPT' \"\$@\""
	if is_launcher "$PI" && [ "$(cat "$PI")" = "$content" ]; then return 0; fi
	# Replace only an older launcher or Pi-Bolt's link, never a `pi` installed another way.
	if { [ -e "$PI" ] || [ -L "$PI" ]; } && ! is_launcher "$PI" && ! is_pi_bolt_link "$PI"; then
		fail "$PI is not pi-setup's launcher: move it away and run this again"
	fi
	say "Writing the pi launcher $PI"
	mkdir -p "${PI%/*}"
	# Through a temporary file, so apps never start a half-written launcher.
	printf '%s\n' "$content" >"$PI.tmp.$$"
	chmod 755 "$PI.tmp.$$"
	mv -f "$PI.tmp.$$" "$PI"
	CHANGED=1
}

# Every other `pi` on PATH would run in place of the launcher wherever PATH is ordered differently, as in apps. The one
# Bun links is the launcher's, and fails only when it is run without it.
check_other_pis() {
	script=$(resolve "$PI_SCRIPT")
	left=""
	old_ifs=$IFS
	IFS=$NL
	for cmd in $(commands_named pi); do
		if [ "$cmd" != "$PI" ] && [ "$(resolve "$cmd")" != "$script" ]; then left="$left  $cmd$NL"; fi
	done
	IFS=$old_ifs
	[ -z "$left" ] || fail "another pi is installed here, remove it with the tool that installed it and run this again:$NL$left"
}

remove_pi_bolt() {
	links=""
	old_ifs=$IFS
	IFS=$NL
	# Pi-Bolt links its `pi-bolt` command into ~/.local/bin by default, also when that is not on PATH.
	for cmd in $(commands_named pi) $(commands_named pi-bolt) "$HOME/.local/bin/pi-bolt"; do
		if is_pi_bolt_link "$cmd"; then links="$links$cmd$NL"; fi
	done
	IFS=$old_ifs
	if [ -z "$links" ] && [ ! -e "$PIBOLT_HOME" ]; then return 0; fi
	say "Uninstalling Pi-Bolt from $PIBOLT_HOME (keeping $AGENT_DIR)"
	IFS=$NL
	for cmd in $links; do rm -f "$cmd"; done
	IFS=$old_ifs
	rm -rf "$PIBOLT_HOME"
	CHANGED=1
}

clear_pi_executable() {
	# An override of the `pi` that desktop apps run (Zeron reads it) would outlive this setup.
	[ "$(uname -s)" = Darwin ] || return 0
	[ -n "$(launchctl getenv PI_EXECUTABLE 2>/dev/null)" ] || return 0
	say "Clearing PI_EXECUTABLE from launchctl"
	launchctl unsetenv PI_EXECUTABLE
	CHANGED=1
}

configure_npm_command() {
	settings="$AGENT_DIR/settings.json"
	if [ -f "$settings" ] && jq -e '.npmCommand == ["bun"]' "$settings" >/dev/null; then return 0; fi
	say "Setting npmCommand to [\"bun\"] in $settings, so pi installs npm packages with Bun"
	mkdir -p "$AGENT_DIR"
	[ -f "$settings" ] || printf '{}\n' >"$settings"
	updated=$(jq '.npmCommand = ["bun"]' "$settings") || fail "$settings is not valid JSON"
	# Write in place, not with mv, so the file keeps its permissions.
	printf '%s\n' "$updated" >"$settings"
	CHANGED=1
}

configure_cache_warming() {
	settings="$AGENT_DIR/settings.json"
	if [ -f "$settings" ] && jq -e '.cacheWarming == "idle"' "$settings" >/dev/null; then return 0; fi
	say "Setting cacheWarming to \"idle\" in $settings, so prompt caches stay warm between runs"
	mkdir -p "$AGENT_DIR"
	[ -f "$settings" ] || printf '{}\n' >"$settings"
	updated=$(jq '.cacheWarming = "idle"' "$settings") || fail "$settings is not valid JSON"
	# Write in place, not with mv, so the file keeps its permissions.
	printf '%s\n' "$updated" >"$settings"
	CHANGED=1
}

# Print each available model with a context window above CONTEXT_WINDOW as `provider<TAB>model`, one per line.
models_over_context_window() {
	# `pi --list-models` prints a table with the provider, model and context window in the first three columns, and
	# the window rounded to thousands (`272K`) or millions (`1M`).
	run_pi --list-models | awk -v limit="$CONTEXT_WINDOW" '
		NR == 1 { if ($1 != "provider" || $3 != "context") exit 1; next }
		{
			size = $3 + 0
			if ($3 ~ /M$/) size *= 1000000; else if ($3 ~ /K$/) size *= 1000
			if (size > limit) printf "%s\t%s\n", $1, $2
		}' || fail "could not read the model list from \`pi --list-models\`"
}

cap_context_windows() {
	models=$(models_over_context_window)
	[ -n "$models" ] || return 0
	models_json="$AGENT_DIR/models.json"
	say "Capping the context window at $CONTEXT_WINDOW tokens in $models_json for:$NL$(printf '%s\n' "$models" | tr '\t' /)"
	mkdir -p "$AGENT_DIR"
	[ -f "$models_json" ] || printf '{}\n' >"$models_json"
	# modelOverrides applies only to built-in and extension models, so a model this file defines is changed in place.
	updated=$(jq --arg models "$models" --argjson limit "$CONTEXT_WINDOW" '
		reduce ($models | split("\n")[] | split("\t")) as [$provider, $id] (.;
			if any(.providers[$provider].models[]?; .id == $id) then
				.providers[$provider].models |= map(if .id == $id then .contextWindow = $limit else . end)
			else
				.providers[$provider].modelOverrides[$id].contextWindow = $limit
			end)' "$models_json") || fail "$models_json is not valid JSON"
	# Write in place, not with mv, so the file keeps its permissions: it may hold API keys.
	printf '%s\n' "$updated" >"$models_json"
	CHANGED=1
}

# Print where a package is installed, or nothing when it is not.
package_path() {
	# `pi list` prints each package's source indented by two spaces, and the path it is installed at on the next line.
	# It reads the source from settings, so the path is checked too: settings copied from another machine list
	# packages whose files are not here.
	path=$(run_pi list | awk -v src="  $1" 'found { sub(/^ +/, ""); print; exit } $0 == src { found = 1 }')
	if [ -n "$path" ] && [ -d "$path" ]; then printf '%s' "$path"; fi
}

ensure_packages() {
	for source in $PACKAGES; do
		if [ -n "$(package_path "$source")" ]; then continue; fi
		case $source in git:*) command -v git >/dev/null 2>&1 || fail "git is needed to install $source" ;; esac
		say "Installing $source"
		run_pi install "$source"
		CHANGED=1
	done
}

configure_web_access() {
	config="$AGENT_DIR/web-search.json"
	if [ -f "$config" ] && jq -e '.toolExposure == "deferred" and .toolActivation == "none"' "$config" >/dev/null; then
		return 0
	fi
	say "Moving pi-web-access tools behind codemode in $config"
	mkdir -p "$AGENT_DIR"
	[ -f "$config" ] || printf '{}\n' >"$config"
	updated=$(jq '. + {toolExposure: "deferred", toolActivation: "none"}' "$config") || fail "$config is not valid JSON"
	# Write in place, not with mv, so the file keeps its permissions: it may hold API keys.
	printf '%s\n' "$updated" >"$config"
	CHANGED=1
}

remove_gui_mcp_servers() {
	mcp_json="$AGENT_DIR/mcp.json"
	[ -f "$mcp_json" ] || return 0
	for server in $GUI_MCP_SERVERS; do
		grep -q "\"$server\"" "$mcp_json" || continue
		say "Removing MCP server $server from $mcp_json: gui-subagents.ts runs it in subagents"
		# Not through run_pi(): `mcp` commands reject --no-approve. Without --local, `mcp remove` edits the user-level file.
		"$PI" mcp remove "$server" >/dev/null
		CHANGED=1
	done
}

ensure_agents_md() {
	[ -f "$AGENTS_MD" ] || return 0
	target="$AGENT_DIR/AGENTS.md"
	if [ -L "$target" ] && [ "$(resolve "$target")" = "$(resolve "$AGENTS_MD")" ]; then return 0; fi
	if [ -e "$target" ] || [ -L "$target" ]; then
		# Never replace instructions written here by hand: they may differ from ~/.agents/AGENTS.md.
		say "warning: $target exists and is not a link to $AGENTS_MD, left as is"
		return 0
	fi
	say "Linking $target -> $AGENTS_MD"
	mkdir -p "$AGENT_DIR"
	ln -s "$AGENTS_MD" "$target"
	CHANGED=1
}

run_dev_flows_install() {
	if [ "$(uname -s)" != Darwin ]; then
		say "Skipping dev-flows-plugin's install script: it supports macOS only"
		return 0
	fi
	script="$(package_path "$DEV_FLOWS")/scripts/install.sh"
	[ -f "$script" ] || fail "dev-flows-plugin has no $script"
	# The installed copy, so the script matches the package version pi loads.
	say "Running $script"
	sh "$script" || fail "dev-flows-plugin's install script failed: fix the error above and run this again"
}

[ "$(uname -s)" = Darwin ] || [ "$(uname -s)" = Linux ] || fail "only macOS and Linux are supported"
command -v bun >/dev/null 2>&1 || fail "Bun is needed: https://bun.sh"
command -v jq >/dev/null 2>&1 || fail "jq is needed"

ensure_pi
ensure_launcher
remove_pi_bolt
check_other_pis
clear_pi_executable
configure_npm_command
ensure_packages
configure_web_access
remove_gui_mcp_servers
configure_cache_warming
cap_context_windows
ensure_agents_md
run_dev_flows_install

hash -r 2>/dev/null || true
found=$(command -v pi || true)
[ "$found" = "$PI" ] || say "warning: \`pi\` runs ${found:-nothing}, not $PI: put ${PI%/*} first on PATH"

if [ "$CHANGED" = 0 ]; then
	# dev-flows-plugin's install script reports its own changes above.
	say "pi is already set up: pi $("$PI" --version) at $PI"
else
	say "Done: pi $("$PI" --version) at $PI"
	say "Restart apps that run pi (such as Zeron). Update with: pi update --all"
fi
