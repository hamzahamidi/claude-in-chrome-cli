# Changelog

## 0.3.0 (unreleased)

Adds `list_open_tabs`, a second MCP server, `chrome-tabs`, that reads Chrome and Chromium session data from disk. The extension bridge only ever sees tabs inside its own tab group; this answers "what is open" without a debugging port, an extension or a group, across every window and every readable profile on the machine, while reporting profiles it cannot read instead of counting them as empty.

Ships in Node rather than the Python it was originally written in (see #4), so the plugin's second MCP server needs no interpreter beyond what `claude` already requires on the platforms that matter. URLs are redacted to origin and path by default and scheme-aware, so `chrome:`, `file:`, `chrome-extension:` and `data:` pages redact correctly rather than corrupting into a literal `null` prefix; pass `full_urls: true` to opt into the raw URL.

Fixes a tab that has visited more than one URL reporting whichever was written to disk last rather than the one actually selected: Chrome records history entries and the currently selected one as separate commands, and only the second was read. Confirmed against a real profile before the fix: 2 of 31 multi-entry tabs in one session were misreported. Session parsing now distinguishes unusable files from readable snapshots with a truncated incremental tail: files whose format or version cannot be trusted, or whose initial snapshot never completed, are rejected, while a completed snapshot that lost later updates is labeled incomplete; discovery falls back to the next-newest session file when the newest one is unusable or its listing changes mid-scan. Windows profile discovery now checks Chromium alongside Chrome, matching macOS and Linux. The skill no longer claims `list_open_tabs` can say which tab currently has focus; it reports which page each tab is on, not which one the user is looking at.

Redaction is now an allowlist rather than a blocklist: only schemes confirmed safe (`http:`, `https:`, `chrome:`, `chrome-extension:`, plus `file:`, `about:` and `data:` handled on their own terms) show host and path. A wrapper scheme such as `blob:`, `filesystem:` or `view-source:` puts another URL, credentials included, directly in its own pathname; those now show only their scheme rather than leaking what they wrap.

Known limitation, not implemented: Chrome's history-pruning commands (forward history dropped after a new navigation, entries pruned from either end) are not modeled, so the selected-navigation-index fix above can still be wrong for a tab whose history was pruned rather than just navigated back and forth. Every command id present across a real, actively-used session file on the machine this was built on was checked; the pruning commands were not among them, so this is documented rather than implemented.

Fixes two more gaps in what counted as a trustworthy file. A byte-complete, correctly-versioned file was still accepted even without Chrome's own completion marker, which Chrome itself requires before treating a snapshot as valid; confirmed the marker's presence on all three real profiles on this machine (exactly one each) before requiring it here too. A profile that has moved to Chrome's separate encrypted session storage (`Sessions_Encrypted`, a staged rollout) was previously invisible to profile discovery entirely, reported the same as a profile with no data at all; it now gets its own status, distinct from both "empty" and "unreadable", since it is a permanent, by-design gap rather than a corrupt or missing file. Also fixes a UNC `file://server/share/...` URL losing its server name during redaction.

Fixes the completion-marker requirement itself: it only applied to a byte-complete file, so a file that was both missing the marker and separately truncated skipped the check entirely and was still trusted, exactly the "never finished the initial write" case the marker exists to catch. Chromium writes the marker once, after its initial commands, so a truncated write cuts it off far more often than a byte-complete write manages to finish everything except the marker; truncation can no longer excuse the requirement. A truncated file whose marker was already written before the cutoff, meaning later incremental commands got cut off after a genuinely valid initial snapshot, is still correctly trusted as incomplete rather than rejected outright.

Adds a GitHub Actions workflow running the test suite on every push, and a check that `tabs_mcp.js`'s version constant matches `plugin.json`.

## 0.2.3 (2026-08-17)

Corrects three claims in the `using-claude-in-chrome` skill: the bridge only ever sees its own tab group and nothing adopts a tab from outside it; `chrome-devtools` is not sessionless, since its default profile keeps cookies across runs; and `DevToolsActivePort` existing is not proof remote debugging is on, since the file outlives the setting. Documentation only.

## 0.2.2 (2026-08-16)

Fixes the README's `cic.sh` examples, which could not work as written: every example that acts on a page needs a `tabId`, since each `cic.sh` call is its own MCP session and starts with an empty tab group. The `javascript_tool` example was also wrong twice over, missing the required `action` field and putting code in the wrong key. Also serves the terminal demo image as a 2x PNG.

## 0.2.1 (2026-08-15)

Fixes a bug where `${2:-{}}` in the tool-arguments case parsed as `${2:-{}` followed by a literal `}`, sending malformed JSON to the bridge whenever the caller relied on the default. Also fixes the `--list` path silently exiting when the bridge sent no reply, matching the tool-call path. Adds the first test, `test/test_request_json.sh`.

## 0.2.0 (2026-08-13)

Initial release. Ships `cic.sh`, a shell bridge that speaks the MCP handshake over stdio to `claude --claude-in-chrome-mcp`, as a Claude Code plugin, with the `using-claude-in-chrome` skill teaching an agent when the user's real logged-in session is the one that matters and how to reach it from a shell.
