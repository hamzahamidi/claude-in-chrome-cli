#!/bin/sh
# Verifies cic.sh emits well-formed JSON-RPC. Runs offline: a stub `claude` on
# PATH captures stdin instead of talking to the extension.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
CIC="$HERE/../cic.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat >"$TMP/claude" <<'EOF'
#!/bin/sh
cat >"$CIC_TEST_CAPTURE"
EOF
chmod +x "$TMP/claude"

CIC_TEST_CAPTURE="$TMP/captured.jsonl"
export CIC_TEST_CAPTURE
PATH="$TMP:$PATH"
export PATH

fails=0

check() {
  label="$1"
  shift
  : >"$CIC_TEST_CAPTURE"
  "$CIC" "$@" >/dev/null 2>&1
  if python3 - "$CIC_TEST_CAPTURE" <<'PY'
import json, sys
ok = True
lines = [l for l in open(sys.argv[1]) if l.strip()]
if len(lines) != 3:
    print("  expected 3 JSON-RPC lines, got", len(lines))
    ok = False
for l in lines:
    try:
        json.loads(l)
    except Exception as e:
        print("  malformed line:", l.strip()[:120])
        print("  parse error:", e)
        ok = False
sys.exit(0 if ok else 1)
PY
  then
    echo "PASS  $label"
  else
    echo "FAIL  $label"
    fails=$((fails + 1))
  fi
}

check "no arguments"            tabs_context_mcp
check "empty object argument"   tabs_context_mcp '{}'
check "object with a string"    navigate '{"url":"https://example.com"}'
check "nested object"           computer '{"action":"screenshot","opts":{"full":true}}'
check "explicit wait"           get_page_text '{}' 3
check "tools/list"              --list

if [ "$fails" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$fails check(s) failed."
  exit 1
fi
