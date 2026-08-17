# Changelog

## 0.3.0 (unreleased)

Adds `list_open_tabs`, a second MCP server, `chrome-tabs`, that reads Chrome's session file from disk. The extension bridge only ever sees tabs inside its own tab group; this answers "what is open" without a debugging port, an extension or a group, across every window and every profile on the machine.

Ships in Node rather than the Python it was originally written in (see #4), so the plugin's second MCP server needs no interpreter beyond what `claude` already requires on the platforms that matter. URLs are redacted to origin and path by default, since a raw URL read straight off disk can carry a token or a session id that the extension bridge's own redaction would have caught; pass `full_urls: true` to opt into the raw URL.

Adds a GitHub Actions workflow running the test suite on every push, and a check that `tabs_mcp.js`'s version constant matches `plugin.json`.

## 0.2.3 (2026-08-17)

Corrects three claims in the `using-claude-in-chrome` skill: the bridge only ever sees its own tab group and nothing adopts a tab from outside it; `chrome-devtools` is not sessionless, since its default profile keeps cookies across runs; and `DevToolsActivePort` existing is not proof remote debugging is on, since the file outlives the setting. Documentation only.

## 0.2.2 (2026-08-16)

Fixes the README's `cic.sh` examples, which could not work as written: every example that acts on a page needs a `tabId`, since each `cic.sh` call is its own MCP session and starts with an empty tab group. The `javascript_tool` example was also wrong twice over, missing the required `action` field and putting code in the wrong key. Also serves the terminal demo image as a 2x PNG.

## 0.2.1 (2026-08-15)

Fixes a bug where `${2:-{}}` in the tool-arguments case parsed as `${2:-{}` followed by a literal `}`, sending malformed JSON to the bridge whenever the caller relied on the default. Also fixes the `--list` path silently exiting when the bridge sent no reply, matching the tool-call path. Adds the first test, `test/test_request_json.sh`.

## 0.2.0 (2026-08-13)

Initial release. Ships `cic.sh`, a shell bridge that speaks the MCP handshake over stdio to `claude --claude-in-chrome-mcp`, as a Claude Code plugin, with the `using-claude-in-chrome` skill teaching an agent when the user's real logged-in session is the one that matters and how to reach it from a shell.
