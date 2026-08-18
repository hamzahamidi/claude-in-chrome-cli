#!/bin/sh
# Drives tabs_mcp.js over stdio the way an MCP client does: initialize, the
# initialized notification, tools/list, then tools/call. Asserts the replies
# are well-formed JSON-RPC, that the tool answers, and that URLs are redacted
# by default. Runs offline, against a synthetic profile, no real Chrome
# needed. Node only: this is the server this test drives.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SERVER="$HERE/../plugins/claude-in-chrome/tabs_mcp.js"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Lay down a synthetic profile under a fake HOME, matching this platform's
# layout in tabs_mcp.js, so tools/call has real (synthetic) data to answer
# with rather than only exercising the "nothing found" fallback.
FAKE_HOME="$TMP/home"
case "$(uname -s)" in
  Darwin) PROFILE_DIR="$FAKE_HOME/Library/Application Support/Google/Chrome/Default/Sessions" ;;
  *)      PROFILE_DIR="$FAKE_HOME/.config/google-chrome/Default/Sessions" ;;
esac
mkdir -p "$PROFILE_DIR"
node -e '
const { setTabWindow, updateTabNavigation, buildSession } = require(process.argv[1]);
const fs = require("fs");
fs.writeFileSync(process.argv[2], buildSession([
  setTabWindow(1, 101),
  updateTabNavigation(101, 0, "https://user:pass@example.com/a?x=1#frag", "Example"),
]));
' "$HERE/fixtures/build_snss.js" "$PROFILE_DIR/Session_1"

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_open_tabs","arguments":{"include_urls":false}}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"nope","arguments":{}}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_open_tabs","arguments":{}}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"list_open_tabs","arguments":{"full_urls":true}}}'
} | HOME="$FAKE_HOME" node "$SERVER" >"$TMP/out.jsonl" 2>"$TMP/err.txt"

node - "$TMP/out.jsonl" <<'JS'
const fs = require('fs');

const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter((l) => l.trim());
let fails = 0;

function check(label, ok, detail) {
  if (ok) {
    console.log('PASS  ' + label);
  } else {
    console.log('FAIL  ' + label + (detail ? '  ' + detail : ''));
    fails += 1;
  }
}

check('one reply per request, notification ignored', lines.length === 6, `got ${lines.length}`);

let msgs;
try {
  msgs = lines.map((l) => JSON.parse(l));
} catch (e) {
  check('every reply is well-formed JSON', false, e.message);
  process.exit(1);
}
check('every reply is well-formed JSON', true);

const byId = new Map(msgs.map((m) => [m.id, m]));

const init = (byId.get(1) || {}).result || {};
check('initialize advertises tools', JSON.stringify(init.capabilities?.tools) === '{}');
check('initialize names the server', init.serverInfo?.name === 'chrome-tabs');

const tools = ((byId.get(2) || {}).result || {}).tools || [];
check('tools/list returns list_open_tabs', JSON.stringify(tools.map((t) => t.name)) === '["list_open_tabs"]');
check(
  'the tool declares an input schema',
  tools[0] ? typeof tools[0].inputSchema?.properties === 'object' : false
);

const countsOnly = ((byId.get(3) || {}).result || {}).content || [];
const countsText = countsOnly.map((c) => c.text || '').join('');
check('tools/call returns text content', Boolean(countsText));
check('include_urls false omits the per-tab line', !countsText.includes('[w1]'), countsText.slice(0, 120));

check('an unknown tool is a JSON-RPC error, not a crash', 'error' in (byId.get(4) || {}));

const defaultText = (((byId.get(5) || {}).result || {}).content || []).map((c) => c.text || '').join('');
check('the default answer reports the synthetic tab', defaultText.includes('open tab(s)'), defaultText.slice(0, 120));
check('the default answer redacts credentials and the query string', !defaultText.includes('user:pass') && !defaultText.includes('x=1'), defaultText);
check('the default answer keeps the origin and path', defaultText.includes('https://example.com/a'), defaultText);

const fullText = (((byId.get(6) || {}).result || {}).content || []).map((c) => c.text || '').join('');
check('full_urls returns the raw url, credentials included', fullText.includes('https://user:pass@example.com/a?x=1#frag'), fullText);

process.exit(fails ? 1 : 0);
JS
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
