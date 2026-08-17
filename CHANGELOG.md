# Changelog

## 0.3.0 (unreleased)

Adds `list_open_tabs`, a second MCP server, `chrome-tabs`, that reads Chrome's session file from disk. The extension bridge only ever sees tabs inside its own tab group; this answers "what is open" without a debugging port, an extension or a group, across every window and every profile on the machine.

Ships in Node rather than the Python it was originally written in (see #4), so the plugin's second MCP server needs no interpreter beyond what `claude` already requires on the platforms that matter. URLs are redacted to origin and path by default and scheme-aware, so `chrome:`, `file:`, `chrome-extension:` and `data:` pages redact correctly rather than corrupting into a literal `null` prefix; pass `full_urls: true` to opt into the raw URL.

Fixes a tab that has visited more than one URL reporting whichever was written to disk last rather than the one actually selected: Chrome records history entries and the currently selected one as separate commands, and only the second was read. Confirmed against a real profile before the fix: 2 of 31 multi-entry tabs in one session were misreported. A session file that is truncated, in a version this parser has not confirmed, or cut off between records with no room even for a length prefix, is now reported as unreadable rather than silently folded into "no open tabs"; discovery falls back to the next-newest session file when the newest one is unreadable or its listing changes mid-scan. Windows profile discovery now checks Chromium alongside Chrome, matching macOS and Linux. The skill no longer claims `list_open_tabs` can say which tab currently has focus; it reports which page each tab is on, not which one the user is looking at.

Redaction is now an allowlist rather than a blocklist: only schemes confirmed safe (`http:`, `https:`, `chrome:`, `chrome-extension:`, plus `file:`, `about:` and `data:` handled on their own terms) show host and path. A wrapper scheme such as `blob:`, `filesystem:` or `view-source:` puts another URL, credentials included, directly in its own pathname; those now show only their scheme rather than leaking what they wrap.

Known limitation, not implemented: Chrome's history-pruning commands (forward history dropped after a new navigation, entries pruned from either end) are not modeled, so the selected-navigation-index fix above can still be wrong for a tab whose history was pruned rather than just navigated back and forth. Every command id present across a real, actively-used session file on the machine this was built on was checked; the pruning commands were not among them, so this is documented rather than implemented.

Adds a GitHub Actions workflow running the test suite on every push, and a check that `tabs_mcp.js`'s version constant matches `plugin.json`.

## 0.2.3 (2026-08-17)

Corrects three claims in the `using-claude-in-chrome` skill: the bridge only ever sees its own tab group and nothing adopts a tab from outside it; `chrome-devtools` is not sessionless, since its default profile keeps cookies across runs; and `DevToolsActivePort` existing is not proof remote debugging is on, since the file outlives the setting. Documentation only.

## 0.2.2 (2026-08-16)

Fixes the README's `cic.sh` examples, which could not work as written: every example that acts on a page needs a `tabId`, since each `cic.sh` call is its own MCP session and starts with an empty tab group. The `javascript_tool` example was also wrong twice over, missing the required `action` field and putting code in the wrong key. Also serves the terminal demo image as a 2x PNG.

## 0.2.1 (2026-08-15)

Fixes a bug where `${2:-{}}` in the tool-arguments case parsed as `${2:-{}` followed by a literal `}`, sending malformed JSON to the bridge whenever the caller relied on the default. Also fixes the `--list` path silently exiting when the bridge sent no reply, matching the tool-call path. Adds the first test, `test/test_request_json.sh`.

## 0.2.0 (2026-08-13)

Initial release. Ships `cic.sh`, a shell bridge that speaks the MCP handshake over stdio to `claude --claude-in-chrome-mcp`, as a Claude Code plugin, with the `using-claude-in-chrome` skill teaching an agent when the user's real logged-in session is the one that matters and how to reach it from a shell.
