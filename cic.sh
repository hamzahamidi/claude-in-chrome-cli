#!/bin/sh
# cic - call Claude in Chrome MCP tools from the shell, without an MCP client.
#
# Claude Code ships a stdio MCP server, `claude --claude-in-chrome-mcp`, that
# bridges to the Claude in Chrome extension and drives your real, logged-in
# browser. This speaks the MCP handshake over stdio, calls one tool, prints the
# result, and exits.
#
# Requires: the Claude Code CLI (`claude`), python3, and the Claude in Chrome
# extension connected to a running Chrome browser.

set -u

usage() {
  cat <<'EOF'
cic - call Claude in Chrome MCP tools from the shell.

Usage:
  cic.sh --list                                  list available tools
  cic.sh <tool_name> '<json-args>' [wait_secs]   call a tool (default wait: 8s)

Examples:
  cic.sh --list
  cic.sh navigate '{"url":"https://example.com"}'
  cic.sh get_page_text '{}' 5
  cic.sh computer '{"action":"screenshot"}'
  cic.sh javascript_tool '{"code":"document.title"}'

wait_secs is how long to wait for the browser to answer before the connection
closes. Slow pages or heavy actions need a larger value.
EOF
}

# Emit the JSON-RPC handshake plus one request (id 2), then wait for the reply.
# $1 = method, $2 = params JSON, $3 = wait seconds.
emit_rpc() {
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cic","version":"1.0.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '{"jsonrpc":"2.0","id":2,"method":"%s","params":%s}\n' "$1" "$2"
  sleep "$3"
}

case "${1:-}" in
  ""|-h|--help)
    usage
    ;;
  -l|--list|list)
    emit_rpc "tools/list" '{}' "${2:-6}" | claude --claude-in-chrome-mcp 2>/dev/null | python3 -c '
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get("id") != 2:
        continue
    if "error" in d:
        print("ERROR:", json.dumps(d["error"]))
        break
    for t in d.get("result", {}).get("tools", []):
        desc = (t.get("description") or "").splitlines()
        print("-", t["name"], "::", (desc[0][:80] if desc else ""))
'
    ;;
  *)
    name="$1"
    # Quotes are required: ${2:-{}} parses as ${2:-{} followed by a literal }.
    args=${2:-"{}"}
    wait="${3:-8}"
    emit_rpc "tools/call" "{\"name\":\"$name\",\"arguments\":$args}" "$wait" \
      | claude --claude-in-chrome-mcp 2>/dev/null | python3 -c '
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get("id") != 2:
        continue
    if "error" in d:
        print("ERROR:", json.dumps(d["error"]))
        break
    for c in d.get("result", {}).get("content", []):
        print(c.get("text") if c.get("type") == "text" else "[" + c.get("type", "?") + "]")
    if d.get("result", {}).get("isError"):
        print("(isError=true)")
'
    ;;
esac
