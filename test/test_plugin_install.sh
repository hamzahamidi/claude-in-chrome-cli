#!/bin/sh
# Installs claude-in-chrome from this repo's own marketplace, using an
# isolated HOME so it can never touch a real Claude Code configuration, and
# asserts the installed cache contains only the runtime files the plugin
# actually needs: nothing from test/, docs/, ROADMAP.md or the GitHub
# workflows gets copied in. Requires the `claude` CLI on PATH.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
FAKE_HOME=$(mktemp -d)
trap 'rm -rf "$FAKE_HOME"' EXIT

fails=0
check() {
  label="$1"
  status="$2"
  if [ "$status" -eq 0 ]; then
    echo "PASS  $label"
  else
    echo "FAIL  $label"
    fails=$((fails + 1))
  fi
}

MARKETPLACE=$(node -p "require('$REPO/.claude-plugin/marketplace.json').name")
PLUGIN=$(node -p "require('$REPO/.claude-plugin/marketplace.json').plugins[0].name")
VERSION=$(node -p "require('$REPO/plugins/claude-in-chrome/.claude-plugin/plugin.json').version")

HOME="$FAKE_HOME" claude plugin marketplace add "$REPO" >/tmp/plugin_install_test_marketplace.log 2>&1
check "marketplace adds from a local path" "$?"

HOME="$FAKE_HOME" claude plugin install "$PLUGIN@$MARKETPLACE" -s local -y >/tmp/plugin_install_test_install.log 2>&1
check "plugin installs from the marketplace" "$?"

CACHE_DIR="$FAKE_HOME/.claude/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION"
test -d "$CACHE_DIR"
check "the installed cache is keyed by the version in plugin.json" "$?"

# The allowlisted runtime surface. Nothing from test/, docs/, ROADMAP.md, or
# .github/ should ever appear here: that is the entire point of this test.
ACTUAL=$(cd "$CACHE_DIR" && find . -type f | sort)
EXPECTED="./.claude-plugin/plugin.json
./.mcp.json
./LICENSE
./cic.sh
./skills/using-claude-in-chrome/SKILL.md
./tabs_mcp.js"
if [ "$ACTUAL" = "$EXPECTED" ]; then
  check "the cache contains exactly the runtime allowlist" 0
else
  check "the cache contains exactly the runtime allowlist" 1
  echo "  --- expected ---"
  echo "$EXPECTED" | sed 's/^/  /'
  echo "  --- actual ---"
  echo "$ACTUAL" | sed 's/^/  /'
fi

# chrome-tabs boots from its installed cache path via ${CLAUDE_PLUGIN_ROOT}.
RESPONSE=$(
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  } | CLAUDE_PLUGIN_ROOT="$CACHE_DIR" node "$CACHE_DIR/tabs_mcp.js"
)
echo "$RESPONSE" | grep -q '"list_open_tabs"'
check "chrome-tabs boots from its installed cache path and lists its tool" "$?"

# The extension bridge is still declared as claude --claude-in-chrome-mcp.
# A live handshake needs a connected extension, which no CI runner has, so
# this checks the installed manifest declares the right command instead.
node -e "
const cfg = require('$CACHE_DIR/.mcp.json');
const bridge = cfg.mcpServers['claude-in-chrome'];
process.exit(
  bridge && bridge.command === 'claude' && JSON.stringify(bridge.args) === '[\"--claude-in-chrome-mcp\"]'
    ? 0
    : 1
);
"
check "the extension bridge is still registered as claude --claude-in-chrome-mcp" "$?"

if [ "$fails" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$fails check(s) failed."
  echo "marketplace add log:"; sed 's/^/  /' /tmp/plugin_install_test_marketplace.log
  echo "plugin install log:"; sed 's/^/  /' /tmp/plugin_install_test_install.log
  exit 1
fi
