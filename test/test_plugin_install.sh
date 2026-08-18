#!/bin/sh
# Installs claude-in-chrome from this repo's own marketplace, using isolated
# HOME and CLAUDE_CONFIG_DIR values so it can never touch a real Claude Code
# configuration, and asserts the installed cache contains only the runtime
# files the plugin actually needs: nothing from test/, docs/, ROADMAP.md or
# the GitHub workflows gets copied in. Requires the `claude` CLI on PATH.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
FAKE_HOME=$(mktemp -d)
trap 'rm -rf "$FAKE_HOME"' EXIT
CLAUDE_CONFIG_DIR="$FAKE_HOME/.claude"
TEST_CWD="$FAKE_HOME/work"
MARKETPLACE_LOG="$FAKE_HOME/marketplace-add.log"
INSTALL_LOG="$FAKE_HOME/plugin-install.log"
export HOME CLAUDE_CONFIG_DIR
mkdir -p "$TEST_CWD"

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

if (cd "$TEST_CWD" && claude plugin marketplace add "$REPO") >"$MARKETPLACE_LOG" 2>&1; then
  check "marketplace adds from a local path" 0
else
  check "marketplace adds from a local path" 1
fi

if (cd "$TEST_CWD" && claude plugin install "$PLUGIN@$MARKETPLACE" -s local -y) >"$INSTALL_LOG" 2>&1; then
  check "plugin installs from the marketplace" 0
else
  check "plugin installs from the marketplace" 1
fi

CACHE_DIR="$CLAUDE_CONFIG_DIR/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION"
if [ -d "$CACHE_DIR" ]; then
  check "the installed cache is keyed by the version in plugin.json" 0
else
  check "the installed cache is keyed by the version in plugin.json" 1
fi

# The allowlisted runtime surface. Nothing from test/, docs/, ROADMAP.md, or
# .github/ should ever appear here: that is the entire point of this test.
EXPECTED="./.claude-plugin/plugin.json
./.mcp.json
./LICENSE
./bin/cic.js
./skills/using-claude-in-chrome/SKILL.md
./tabs_mcp.js"
ACTUAL="(cache directory missing)"
if [ -d "$CACHE_DIR" ] && ACTUAL=$(cd "$CACHE_DIR" && find . -type f | sort); then
  :
fi
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
RESPONSE=""
if [ -f "$CACHE_DIR/tabs_mcp.js" ] && RESPONSE=$(
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  } | CLAUDE_PLUGIN_ROOT="$CACHE_DIR" node "$CACHE_DIR/tabs_mcp.js"
); then
  if printf '%s\n' "$RESPONSE" | grep -q '"list_open_tabs"'; then
    check "chrome-tabs boots from its installed cache path and lists its tool" 0
  else
    check "chrome-tabs boots from its installed cache path and lists its tool" 1
  fi
else
  check "chrome-tabs boots from its installed cache path and lists its tool" 1
fi

# The extension bridge is still declared as claude --claude-in-chrome-mcp.
# A live handshake needs a connected extension, which no CI runner has, so
# this checks the installed manifest declares the right command instead.
if [ -f "$CACHE_DIR/.mcp.json" ] && node -e "
const cfg = require('$CACHE_DIR/.mcp.json');
const bridge = cfg.mcpServers['claude-in-chrome'];
process.exit(
  bridge && bridge.command === 'claude' && JSON.stringify(bridge.args) === '[\"--claude-in-chrome-mcp\"]'
    ? 0
    : 1
);
"; then
  check "the extension bridge is still registered as claude --claude-in-chrome-mcp" 0
else
  check "the extension bridge is still registered as claude --claude-in-chrome-mcp" 1
fi

# Installation path 1, the plugin: the bundled CLI runs from the installed
# cache. cic.sh was the plugin's shell entry point until 0.4.0 deleted it, so
# this asserts the replacement actually shipped and starts.
if [ -f "$CACHE_DIR/bin/cic.js" ] && [ "$(node "$CACHE_DIR/bin/cic.js" --version)" = "$VERSION" ]; then
  check "the plugin's bundled cic runs from the installed cache" 0
else
  check "the plugin's bundled cic runs from the installed cache" 1
fi

# Installation path 2, npm. `npm pack` builds exactly what `npm publish` would
# upload, and installing that tarball globally into a throwaway prefix is the
# only way to prove the `cic` command users actually type gets created and runs.
# Inspecting the tarball is not enough: it says nothing about the bin link.
PACK_DIR="$FAKE_HOME/pack"
NPM_PREFIX="$FAKE_HOME/npm-global"
NPM_LOG="$FAKE_HOME/npm-install.log"
mkdir -p "$PACK_DIR" "$NPM_PREFIX"
if (cd "$REPO" && npm pack --pack-destination "$PACK_DIR" >/dev/null 2>&1) &&
  TARBALL=$(find "$PACK_DIR" -name '*.tgz' | head -1) && [ -n "$TARBALL" ]; then
  check "npm pack builds a publishable tarball" 0
else
  check "npm pack builds a publishable tarball" 1
fi

if [ -n "${TARBALL:-}" ] &&
  npm install -g "$TARBALL" --prefix "$NPM_PREFIX" >"$NPM_LOG" 2>&1 &&
  [ -x "$NPM_PREFIX/bin/cic" ] &&
  [ "$(PATH="$NPM_PREFIX/bin:$PATH" cic --version)" = "$VERSION" ]; then
  check "npm install -g creates a cic command that runs" 0
else
  check "npm install -g creates a cic command that runs" 1
  [ -f "$NPM_LOG" ] && sed 's/^/  /' "$NPM_LOG"
fi

if [ "$fails" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$fails check(s) failed."
  echo "marketplace add log:"; sed 's/^/  /' "$MARKETPLACE_LOG"
  echo "plugin install log:"; sed 's/^/  /' "$INSTALL_LOG"
  exit 1
fi
