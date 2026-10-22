#!/bin/sh
# Set up pi on this machine, from scratch or by adding what is missing. Does nothing when everything is in place.
#
#   curl -fsSL https://raw.githubusercontent.com/iyazerski/pi-setup/main/scripts/setup.sh | sh
#
# 1. Installs Pi-Bolt (https://github.com/opensec-git/Pi-Bolt), pi compiled to native code, unless `pi-bolt` is there.
# 2. Uninstalls pi if present: a managed install (pi.dev/install.sh) or a global npm install. The agent directory stays,
#    Pi-Bolt uses its settings, logins, sessions and packages as is.
# 3. Links `pi` to `pi-bolt`, so scripts, skills and apps that run `pi` (such as Zeron) get Pi-Bolt.
# 4. Installs the packages in PACKAGES that are missing.
# 5. Links ~/.agents/AGENTS.md into the agent directory, if it exists. Skills in ~/.agents/skills need no link: pi reads
#    that directory itself, and a link would load every skill twice.
# 6. On macOS, runs dev-flows-plugin's own install script, which installs the tools its MCP servers need and skips the
#    installed ones. It prints its own status, and needs jq and Bun.
#
# macOS and Linux only. Needs curl, and git for git packages.
#
# Environment:
#   PIBOLT_BIN_DIR       where `pi-bolt` and the `pi` link go (default: ~/.local/bin)
#   PIBOLT_VARIANT       passed to the Pi-Bolt installer, e.g. arm64-jit (default: its own choice)
#   PI_CODING_AGENT_DIR  pi's agent directory (default: ~/.pi/agent)
set -eu

BIN_DIR="${PIBOLT_BIN_DIR:-$HOME/.local/bin}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PIBOLT="$BIN_DIR/pi-bolt"
PI_LINK="$BIN_DIR/pi"
PI_NPM_PACKAGE="@earendil-works/pi-coding-agent"
# pi-web-access first: pi-setup's web-codemode.ts moves its tools behind codemode.
PACKAGES="npm:pi-web-access git:github.com/iyazerski/pi-setup git:github.com/iyazerski/dev-flows-plugin"
DEV_FLOWS="git:github.com/iyazerski/dev-flows-plugin"
AGENTS_MD="$HOME/.agents/AGENTS.md"
NL='
'
CHANGED=0

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

# List every `pi` on PATH, in PATH order, one per line.
pi_commands() {
	old_ifs=$IFS
	IFS=:
	for dir in $PATH; do
		if [ -n "$dir" ] && { [ -x "$dir/pi" ] || [ -L "$dir/pi" ]; }; then printf '%s\n' "$dir/pi"; fi
	done
	IFS=$old_ifs
}

is_pi_bolt() { "$1" --version 2>/dev/null | grep -q 'Pi-Bolt'; }

# Run Pi-Bolt from the home directory without project-local files, so a project's settings never leak into the setup.
pibolt() { (cd "$HOME" && "$PIBOLT" "$@" --no-approve); }

ensure_pi_bolt() {
	if [ -x "$PIBOLT" ] && is_pi_bolt "$PIBOLT"; then return 0; fi
	say "Installing Pi-Bolt"
	# PIBOLT_YES=1 takes the default action without asking. OpenSec's optional extensions are left out.
	curl -fsSL https://pi-bolt.opensec.in/install.sh | PIBOLT_YES=1 PIBOLT_EXTENSIONS=no PIBOLT_BIN_DIR="$BIN_DIR" sh
	is_pi_bolt "$PIBOLT" || fail "Pi-Bolt did not install to $PIBOLT"
	CHANGED=1
}

# Remove a managed pi the way pi.dev/install.sh's own uninstall does: the `pi` links that point to its launcher, the
# launcher, and the installed releases. Everything else in its agent directory stays.
remove_managed_pi() {
	agent=$1
	launcher=$(resolve "$agent/bin/pi")
	old_ifs=$IFS
	IFS=$NL
	for cmd in $(pi_commands); do
		if [ -L "$cmd" ] && [ "$(resolve "$cmd")" = "$launcher" ]; then rm -f "$cmd"; fi
	done
	IFS=$old_ifs
	rm -f "$agent/bin/pi"
	rmdir "$agent/bin" 2>/dev/null || true
	rm -rf "$agent/install"
}

uninstall_pi() {
	# Loop in this shell, not a pipe, so CHANGED survives. The list is read once, before anything is removed.
	old_ifs=$IFS
	IFS=$NL
	for cmd in $(pi_commands); do
		IFS=$old_ifs
		[ -e "$cmd" ] || [ -L "$cmd" ] || continue # removed with an earlier entry
		if [ ! -e "$cmd" ]; then
			# A link whose target is gone, e.g. left by an interrupted uninstall.
			say "Removing broken link $cmd"
			rm -f "$cmd"
			CHANGED=1
			continue
		fi
		if is_pi_bolt "$cmd"; then continue; fi
		real=$(resolve "$cmd")
		bin=${real%/*}
		agent=${bin%/*}
		# A managed install keeps its launcher in <agent>/bin/pi and its releases in <agent>/install.
		if [ "${real##*/}" = pi ] && [ "${bin##*/}" = bin ] && [ -f "$agent/install/managed-install.json" ]; then
			say "Uninstalling managed pi from $agent/install (keeping the rest of $agent)"
			remove_managed_pi "$agent"
			CHANGED=1
		elif command -v npm >/dev/null 2>&1 && npm ls -g --depth=0 "$PI_NPM_PACKAGE" >/dev/null 2>&1; then
			say "Uninstalling pi with npm ($PI_NPM_PACKAGE)"
			npm uninstall -g "$PI_NPM_PACKAGE"
			CHANGED=1
		fi
	done
	IFS=$old_ifs
	hash -r 2>/dev/null || true
	# Anything left was installed some other way (Homebrew, Nix, a copy): stop before the `pi` link hides or fights it.
	left=""
	IFS=$NL
	for cmd in $(pi_commands); do
		if ! is_pi_bolt "$cmd"; then left="$left  $cmd$NL"; fi
	done
	IFS=$old_ifs
	[ -z "$left" ] || fail "pi is still installed here, remove it with the tool that installed it and run this again:$NL$left"
}

ensure_pi_link() {
	# Any link that ends at Pi-Bolt's executable is fine, also one made by hand straight to it.
	if [ -L "$PI_LINK" ] && [ "$(resolve "$PI_LINK")" = "$(resolve "$PIBOLT")" ]; then return 0; fi
	if [ -e "$PI_LINK" ] && [ ! -L "$PI_LINK" ]; then fail "$PI_LINK is a file, not a link: move it away and run this again"; fi
	# Link to the `pi-bolt` command, not to the executable behind it, so reinstalls and updates of Pi-Bolt keep working.
	say "Linking $PI_LINK -> $PIBOLT"
	ln -sfn "$PIBOLT" "$PI_LINK"
	CHANGED=1
}

clear_pi_executable() {
	# An override left from trying Pi-Bolt in a desktop app (Zeron reads it) would outlive this setup.
	[ "$(uname -s)" = Darwin ] || return 0
	[ -n "$(launchctl getenv PI_EXECUTABLE 2>/dev/null)" ] || return 0
	say "Clearing PI_EXECUTABLE from launchctl"
	launchctl unsetenv PI_EXECUTABLE
	CHANGED=1
}

# Print where a package is installed, or nothing when it is not.
package_path() {
	# `pi list` prints each package's source indented by two spaces, and the path it is installed at on the next line.
	# It reads the source from settings, so the path is checked too: settings copied from another machine list
	# packages whose files are not here.
	path=$(pibolt list | awk -v src="  $1" 'found { sub(/^ +/, ""); print; exit } $0 == src { found = 1 }')
	if [ -n "$path" ] && [ -d "$path" ]; then printf '%s' "$path"; fi
}

ensure_packages() {
	for source in $PACKAGES; do
		if [ -n "$(package_path "$source")" ]; then continue; fi
		case $source in git:*) command -v git >/dev/null 2>&1 || fail "git is needed to install $source" ;; esac
		say "Installing $source"
		pibolt install "$source"
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
command -v curl >/dev/null 2>&1 || fail "curl is needed"

ensure_pi_bolt
uninstall_pi
ensure_pi_link
clear_pi_executable
ensure_packages
ensure_agents_md
run_dev_flows_install

hash -r 2>/dev/null || true
found=$(command -v pi || true)
[ "$found" = "$PI_LINK" ] || say "warning: \`pi\` runs ${found:-nothing}, not $PI_LINK: put $BIN_DIR first on PATH"

if [ "$CHANGED" = 0 ]; then
	# dev-flows-plugin's install script reports its own changes above.
	say "pi is already set up: $("$PI_LINK" --version)"
else
	say "Done: $("$PI_LINK" --version)"
	say "Restart apps that run pi (such as Zeron). Update with: pi update --all"
fi
