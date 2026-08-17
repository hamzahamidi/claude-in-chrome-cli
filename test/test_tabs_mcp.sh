#!/bin/sh
# Drives tabs_mcp.py over stdio the way an MCP client does: initialize, the
# initialized notification, tools/list, then tools/call. Asserts the replies
# are well-formed JSON-RPC and that the tool answers. Runs offline.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SERVER="$HERE/../tabs_mcp.py"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_open_tabs","arguments":{"include_urls":false}}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"nope","arguments":{}}}'
} | python3 "$SERVER" >"$TMP/out.jsonl" 2>"$TMP/err.txt"

python3 - "$TMP/out.jsonl" <<'PY'
import json, sys

lines = [l for l in open(sys.argv[1]) if l.strip()]
fails = 0

def check(label, ok, detail=""):
    global fails
    if ok:
        print("PASS  " + label)
    else:
        print("FAIL  " + label + ("  " + detail if detail else ""))
        fails += 1

check("one reply per request, notification ignored", len(lines) == 4,
      f"got {len(lines)}")

msgs = []
for l in lines:
    try:
        msgs.append(json.loads(l))
    except Exception as e:
        check("well-formed JSON", False, str(e))
        sys.exit(1)
check("every reply is well-formed JSON", True)

by_id = {m.get("id"): m for m in msgs}

init = by_id.get(1, {}).get("result", {})
check("initialize advertises tools", init.get("capabilities", {}).get("tools") == {})
check("initialize names the server", init.get("serverInfo", {}).get("name") == "chrome-tabs")

tools = by_id.get(2, {}).get("result", {}).get("tools", [])
check("tools/list returns list_open_tabs",
      [t["name"] for t in tools] == ["list_open_tabs"])
check("the tool declares an input schema",
      isinstance(tools[0].get("inputSchema", {}).get("properties"), dict) if tools else False)

call = by_id.get(3, {}).get("result", {})
text = "".join(c.get("text", "") for c in call.get("content", []))
check("tools/call returns text content", bool(text))
check("the answer reports a tab count or says why not",
      ("open tab(s)" in text) or ("No Chrome session file" in text)
      or ("no profile has an open tab" in text), text[:80])

check("an unknown tool is a JSON-RPC error, not a crash",
      "error" in by_id.get(4, {}))

sys.exit(1 if fails else 0)
PY
status=$?

if [ -s "$TMP/err.txt" ]; then
  echo "stderr from the server:"
  sed 's/^/  /' "$TMP/err.txt"
fi

if [ "$status" -eq 0 ]; then
  echo "All checks passed."
else
  echo "Some checks failed."
fi
exit "$status"
