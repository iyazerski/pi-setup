#!/bin/sh
# Count how pi sessions used their tools, to check the effect of tool-routing.ts and tool-hints.ts.
#
#   scripts/tool-stats.sh [days]
#
# Reads the sessions changed in the last `days` days (default: 7) and prints one JSON object: calls per tool, and
# bash commands that tool-hints.ts hints at. The bash patterns are rough and count commands, not hints shown.
#
# Environment:
#   PI_CODING_AGENT_DIR  pi's agent directory (default: ~/.pi/agent)
set -eu

DAYS="${1:-7}"
SESSIONS="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions"

find "$SESSIONS" -name '*.jsonl' -mtime "-$DAYS" -exec cat {} + | jq -sc --arg days "$DAYS" '
	[.[] | select(.type == "message" and .message.role == "assistant") | .message.content[]?
		| select(.type == "toolCall") | {name, c: (.arguments.command // .arguments.code // "")}] as $calls
	| ($calls | map(select(.name == "bash") | .c)) as $bash
	| ($calls | map(select(.name == "codemode") | .c)) as $scripts
	| def count(f): map(select(f)) | length;
	{
		days: ($days | tonumber),
		calls: ($calls | length),
		bash: ($bash | length),
		codemode: ($scripts | length),
		codemode_with_bash: ($scripts | count(test("tools\\.bash\\("))),
		read: ($calls | count(.name == "read")),
		edit: ($calls | count(.name == "edit")),
		codemode_with_edit: ($scripts | count(test("tools\\.edit\\("))),
		bash_python_writes: ($bash | count(test("python") and test("write_text\\(|\\.write\\("))),
		bash_sed_i: ($bash | count(test("\\bsed\\s+(-\\S+\\s+)*-[a-zA-Z]*i"))),
		bash_sed_n: ($bash | count(test("\\bsed -n"))),
		bash_sd: ($bash | count(test("(^|[;&|\\n]\\s*)sd\\s"))),
		bash_sleep: ($bash | count(test("(^|[;&|\\n(]\\s*)sleep\\s+\\d"))),
		bash_grep_find: ($bash | count(test("(^|[;&|\\n]\\s*)(grep|find)\\s")))
	}'
