# claude-in-chrome-cli (`cic`)

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-da7756)](https://www.claudepluginhub.com/plugins/hamzahamidi-claude-in-chrome-plugins-claude-in-chrome)
[![Listed on ClaudePluginHub](https://www.claudepluginhub.com/badge/hamzahamidi-claude-in-chrome-plugins-claude-in-chrome)](https://www.claudepluginhub.com/plugins/hamzahamidi-claude-in-chrome-plugins-claude-in-chrome)
[![npm](https://img.shields.io/npm/v/claude-in-chrome-cli)](https://www.npmjs.com/package/claude-in-chrome-cli)
[![Release](https://img.shields.io/github/v/release/hamzahamidi/claude-in-chrome-cli)](https://github.com/hamzahamidi/claude-in-chrome-cli/releases)
[![codecov](https://codecov.io/github/hamzahamidi/claude-in-chrome-cli/graph/badge.svg)](https://codecov.io/github/hamzahamidi/claude-in-chrome-cli)
[![License: MIT](https://img.shields.io/github/license/hamzahamidi/claude-in-chrome-cli)](LICENSE)

Use the **Claude in Chrome** extension tools natively in Claude Code, or call them from your shell with `cic`. Both connect through the same MCP server.

![cic tabs listing open tabs read from Chrome's session files on disk: 29 tabs across 3 profiles, where the extension's bridge can see 4](docs/cic-tabs-demo.png)

## Why

Claude Code ships a stdio MCP server, `claude --claude-in-chrome-mcp`, that bridges to the Claude in Chrome extension. Through it you can drive your **real, logged-in** Chrome: navigate, read the page, click, type, run JavaScript, read the console and network.

Normally you reach those tools from inside a Claude session. Sometimes you just want one from a script or a terminal: a quick navigation, a page-text dump, a one-off step in a shell pipeline. `cic` does that. It speaks the MCP handshake over stdio, calls one tool, prints the result, and exits with a code that means something.

The plugin is a second front door. Install it to make `navigate`, `read_page`, `find`, `computer`, `get_page_text`, and the rest of the extension tools available natively in new Claude Code sessions.

It also adds one tool the extension cannot provide. The bridge only ever sees tabs inside its own tab group, so "what have I got open?" is unanswerable through it. `list_open_tabs` answers it by reading Chrome and Chromium session data from disk, with no debugging port, no extension and no tab group. It lists every tab it can recover from each readable profile and reports encrypted, unsupported or unreadable profiles instead of treating them as empty. Measured on one machine: the bridge could see 4 tabs, `list_open_tabs` saw 29, of which 25 were outside the group. It reads URLs and titles, not page content, and it cannot drive a page.

Where this is going, release by release: see the [roadmap](ROADMAP.md).

## Requirements

- The **Claude Code CLI** (`claude`) on your PATH.
- The **Claude in Chrome** extension installed and connected to a running Chrome for the browser-driving tools. `list_open_tabs` does not need it.
- **Node.js 22 or later**. Nothing else: no runtime dependencies, no `python3`.

## Install

### As a Claude Code plugin

```text
/plugin marketplace add hamzahamidi/claude-in-chrome-cli
/plugin install claude-in-chrome@claude-in-chrome-cli
```

New Claude Code sessions get all the extension tools natively, plus a skill ([`using-claude-in-chrome`](plugins/claude-in-chrome/skills/using-claude-in-chrome/SKILL.md)) that teaches the agent when your real session is the one that matters, which browser tool to reach for when it is not, and how to avoid the common traps. The plugin also bundles the CLI, reachable as `node ${CLAUDE_PLUGIN_ROOT}/bin/cic.js`.

### As a command line tool

```sh
npm install -g claude-in-chrome-cli
```

That puts `cic` on your PATH.

## Usage

```sh
cic list                          # list available tools
cic call <tool> [json-args]       # call a tool, arguments default to {}
cic with-tab <url> <tool> [args]  # make a tab, navigate, call one tool, close it
cic tabs                          # every open tab, read from disk without the bridge
```

| Option | What it does |
| --- | --- |
| `--timeout <secs>` | Ceiling on how long to wait for the reply. Default 30. |
| `--retries <n>` | Retry only failures that never reached the browser (exit 3). Default 0. |
| `--json` | Print the raw result object, or one error object, on one line |
| `--output <path>` | Write the image in the result to a file. `call` and `with-tab`. |
| `--keep-tab` | Leave the tab open instead of closing it. `with-tab`. |
| `--profile <name>` | Only this browser profile. `tabs`. |
| `--full-urls` | Raw URLs instead of redacted origin and path. `tabs`. |
| `-h`, `--help` | Usage |
| `-v`, `--version` | Print the version |

Each command takes only the options it can act on. `cic tabs --timeout 5` exits 64 rather than accepting a flag that could not mean anything, since nothing there can time out.

`--timeout` is a ceiling, not a wait: `cic` returns the moment the reply lands, so a fast call costs what the browser costs and nothing more.

Exit codes are a contract, frozen from 0.4.0 onward:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | The tool reported an error (a JSON-RPC error, or `isError: true`) |
| `2` | Outcome unknown: the request was sent and no usable reply came back |
| `3` | Failed before the request was sent, so the browser cannot have acted |
| `64` | Usage error, invalid arguments JSON, or a `--output` file that could not be produced |

Only exit 3 is safe to retry automatically, which is the only thing `--retries` will retry. Exit 2 means the click, submit or script may already have run, so repeating it would be a second action rather than a second look at the first.

### One connection, many calls

A one-shot `cic call` pays for a process and a handshake every time, and its tab group starts empty. `cic session --jsonl` holds one connection open and answers one JSON object per line, so a `tabId` from an earlier call is still valid in a later one.

```sh
printf '%s\n' \
  '{"id":1,"tool":"tabs_create_mcp"}' \
  '{"id":2,"tool":"navigate","arguments":{"url":"https://example.com","tabId":123}}' \
  '{"id":3,"tool":"get_page_text","arguments":{"tabId":123}}' \
  | cic session --jsonl
```

| In | Out |
| --- | --- |
| `{"id":<any>,"tool":"<name>","arguments":{...},"timeout":<secs>}` | `{"id":<same>,"exit":0,"result":{...}}` |
| | `{"id":<same>,"error":true,"kind":"...","exit":<code>,"message":"..."}` |

The failure record is the same envelope `cic call --json` already emits, with the id added, so a caller that parses one parses both. `id` is yours: `cic` echoes it back and never invents one. `arguments` defaults to `{}` and `timeout` to the session's.

Calls run one at a time, in the order given, and stdin is paused while one is in flight, so a fast producer cannot build an unbounded backlog. You own sequencing and any value you thread between calls; `cic` owns the connection and nothing else. There are no variables, captures or control flow here on purpose: your program already has those.

Because a persistent process has one exit status and many calls, each record carries its own outcome and the **process** exit code describes only the session: `0` it shut down cleanly, `2` a call whose outcome was unknown ended it, `3` it never started.

A malformed line is that line's problem: it gets a `usage` record and the session continues. A tool error is that call's problem, likewise. **An unknown outcome ends the session**, deliberately: the request was sent, nobody knows whether the browser acted, and letting a later call race it would be the one thing the exit codes exist to prevent. Start a fresh session.

For driving it by hand, `cic shell` is the same connection with a prompt. One line is a tool name and optional JSON arguments, nothing is remembered between lines, and `.exit` or Ctrl-D leaves.

### Using a tab you already have open

Everything above drives a tab the bridge made. `.adopt`, in `cic shell`, uses one of yours instead:

```text
cic> .adopt

Move the Chrome tab you want Claude to use into the Claude tab group.
That gives Claude access to read and interact with that live page.
Right-click the tab, then Add tab to group.

Waiting for a tab…  Ctrl-C to cancel

✓ GitHub — PR #24
  github.com/hamzahamidi/claude-in-chrome-cli/pull/24

Adopted as tab 500. Pass that id to the tools you call next.
```

The bridge has no tool that moves a tab, so you move it, and that move is the consent. `.adopt` only makes it safe to detect: it holds a group open, waits, and identifies your tab as one new live id confirmed on two consecutive polls, then checks the bridge can actually drive it. Titles and URLs are shown to you and never used to decide which tab was meant, and the URL is shown as origin and path only.

It prints the id rather than remembering it, because this shell has no implicit current tab and one adopted tab is not worth being the exception. Move two tabs in and it says so and waits for you to take the extras out; Ctrl-C cancels the adoption and leaves the shell running.

**A blank tab may be left behind on purpose.** If the group did not exist, `.adopt` opens one tab to hold it open, and that tab owns the group: closing it makes the bridge lose the whole group and your adopted tab with it. So when you leave, that tab stays and the shell says why. Close it yourself once you are done.

![A cic shell session making four calls over one connection: the tabId printed by the first reply is threaded into the three that follow. Each reply's tab context is elided.](docs/cic-demo-session.webp)

That is a real session, recorded through a pty. The tab context every reply carries is elided from the recording, and [`docs/make-demo.js`](docs/make-demo.js) regenerates the image.

### One tab, cleaned up after

`cic with-tab` makes a tab, navigates it, calls one tool against it and closes it, which is the shape most one-off scripts were writing by hand.

```sh
cic with-tab https://example.com get_page_text
cic with-tab https://example.com computer '{"action":"screenshot"}' --output shot.png
```

It fills in `tabId` and nothing else, so passing your own is a usage error rather than a silently ignored argument. `--keep-tab` leaves the tab for inspection.

**After an unknown outcome the tab is deliberately left open**, and its id is printed. The request reached the browser and no usable reply came back, so closing the tab could discard a half-finished action and destroy the only evidence of it. An ordinary tool error is different: the browser answered, so the tab is closed as usual. A cleanup that fails is always reported and never swallowed, whether the work succeeded or not: after a success it is a warning beside the result, and after a failure it is appended to that failure, since a tab that may still be open is exactly what you need to know while reading why the work failed.

The helper behind it lives in `lib/tab-lifecycle.js` rather than on `BridgeSession`. That class is the generic protocol layer and knows nothing about what any tool is called; this is the file where `tabs_create_mcp`, `navigate` and `tabs_close_mcp` are allowed to be named.

### Getting an image out

`--output <path>` writes the image in a result to a file, on `cic call` and `cic with-tab` alike. It looks for image content and knows nothing about which tool produced it, so `cic call` still owns no schema and this works for anything that returns a picture.

```sh
cic call computer '{"action":"screenshot","tabId":123}' --output shot.png
```

It refuses, and writes nothing at all, when the result carries no image, carries more than one, or carries bytes that are not a whole image. Four things are checked: the base64 is complete, the leading bytes match a format it knows, a declared type does not contradict those bytes, and the data reaches the end of its own format. That last one is the point. A truncated PNG still begins with the PNG signature, and base64 cut at a length divisible by four is still valid base64, so a header check alone accepts a fragment: each format is therefore asked where it ends, by walking PNG chunks to `IEND`, requiring the JPEG end-of-image marker, the GIF trailer, or a WebP whose declared RIFF size matches what arrived.

The write goes to a temporary file in the destination's directory and is renamed into place, so an existing file survives every one of those refusals. A path that exists therefore holds a whole image, because half a screenshot on disk looks like an answer.

Those refusals exit 64. The browser did what it was asked and the file is what could not be produced, which is neither a tool error nor anything safe to retry, and the exit-code contract has been frozen since 0.4.0 rather than growing a sixth code. One thing worth knowing: the bridge returns JPEG today whatever you call the file, so `--output shot.png` reports on stderr that the name suggests a different format from the bytes it wrote.

### What is open, without the bridge

`cic tabs` is `list_open_tabs` as a command. It reads Chrome and Chromium session files straight from disk, so it needs no bridge, no handshake, no extension and no tab group, and it sees tabs the bridge cannot.

```sh
cic tabs
cic tabs --json --profile Default
```

URLs are redacted to origin and path by default, in `--json` as well as in the text, since choosing machine-readable output is not a request to turn the safe default off. `--full-urls` opts out. A `--profile` that matches nothing is a usage error naming the profiles that do exist, rather than an answer that looks like an empty browser.

### Moving from `cic.sh`

The shell script is gone as of 0.4.0. It exited 0 on tool errors, so pipelines carried on after a failure, and its `sleep`-based wait was a floor as well as a ceiling. Both are fixed in the Node client rather than patched in shell. The old script stays fetchable from the `v0.2.x` and `v0.3.x` tags.

| Then | Now |
| --- | --- |
| `./cic.sh --list` | `cic list` |
| `./cic.sh navigate '{"url":"..."}'` | `cic call navigate '{"url":"..."}'` |
| `./cic.sh get_page_text '{}' 5` | `cic call get_page_text '{}' --timeout 5` |
| `${CLAUDE_PLUGIN_ROOT}/cic.sh` | `node ${CLAUDE_PLUGIN_ROOT}/bin/cic.js` |
| Third positional argument was the wait | `--timeout`, and it is a ceiling |
| Errors printed, exit 0 | Errors exit 1, 2 or 3, per the table above |

## Examples

```sh
# See what tools the extension exposes
cic list

# Make a tab of your own. It prints "Created new tab. Tab ID: 2099038679"
cic call tabs_create_mcp '{}'

# Then pass that id to every tool that acts on a page
cic call navigate '{"url":"https://example.com","tabId":2099038679}'
cic call get_page_text '{"tabId":2099038679}'
cic call computer '{"action":"screenshot","tabId":2099038679}'
cic call javascript_tool '{"action":"javascript_exec","text":"document.title","tabId":2099038679}'

# Close it when you are done
cic call tabs_close_mcp '{"tabId":2099038679}'
```

Because the exit codes mean something, a sequence can stop when a step fails:

```sh
set -e
TAB=$(cic call tabs_create_mcp '{}' | grep -o '[0-9]\{6,\}')
cic call navigate "{\"url\":\"https://example.com\",\"tabId\":$TAB}"
cic call get_page_text "{\"tabId\":$TAB}"
cic call tabs_close_mcp "{\"tabId\":$TAB}"
```

`tabId` is required here. Each `cic` call is its own MCP session, so the session starts with an empty tab group and a tool that acts on a page answers `No tab available` without one. `list` and `tabs_context_mcp` are the exceptions, since neither touches a page.

Never pass the id of a tab you are working in. `tabs_context_mcp` lists every tab the extension can see, including yours.

## Tools

The exact set depends on your extension version. Run `cic list` for the live list. Common ones:

| Tool | What it does |
| --- | --- |
| `navigate` | Go to a URL, or back/forward |
| `read_page` | Accessibility tree of the page |
| `find` | Find elements by natural language |
| `form_input` | Set values in form fields |
| `computer` | Mouse, keyboard, and screenshots |
| `javascript_tool` | Run JavaScript in the page |
| `get_page_text` | Extract readable text |
| `browser_batch` | Run several tool calls in one round trip |
| `read_console_messages` | Read console logs |
| `read_network_requests` | Read network requests |
| `tabs_context_mcp` / `tabs_create_mcp` / `tabs_close_mcp` | Manage the MCP tab group |
| `list_connected_browsers` / `select_browser` / `switch_browser` | Pick which Chrome to drive |

Argument shapes come from the extension, not from `cic`. The `cic list` output includes each tool's description, which documents its arguments.

One tool does not come from the extension. The plugin ships [`tabs_mcp.js`](plugins/claude-in-chrome/tabs_mcp.js) as a second MCP server, `chrome-tabs`:

| Tool | What it does |
| --- | --- |
| `list_open_tabs` | Tabs recoverable from readable session data across every window and recognized profile |

It takes an optional `profile` to narrow to one Chrome profile, and `include_urls: false` to get counts and hosts without the per-tab list. URLs are redacted by default to origin and path, since a raw URL read straight off disk can carry credentials, a token, a session id or a sensitive query string; pass `full_urls: true` only when the raw URL is actually needed.

The server scans every recognized `Default` and `Profile *` directory for Chrome and Chromium, not just the profile the bridge happens to be using. Profiles whose session storage is encrypted or in an unsupported format are reported, but their tabs cannot be listed. If the newest initial snapshot never completed, the reader falls back to an older trustworthy file; if a completed snapshot only lost later incremental updates, it returns the recovered tabs with an incomplete warning. This is a best-effort reader of Chromium's undocumented SNSS format: it cannot identify the focused tab, and uncommon history-pruning events can leave a tab's reported page stale.

`list_open_tabs` is read only, needs nothing running, and is the answer whenever the question is "what is open" rather than "drive this page". It is not available through `cic`, which talks to the extension bridge instead.

## How it works

An MCP stdio server reads newline-delimited JSON-RPC on stdin and writes responses on stdout. `cic` spawns `claude --claude-in-chrome-mcp` and negotiates in order, as the specification requires:

1. `initialize`, then **wait** for the response and check the agreed protocol version.
2. `notifications/initialized`.
3. `tools/call` (or `tools/list`) with your tool name and arguments, as request id `2`.

It then reads the child's stdout line by line and returns the moment the reply with id `2` lands, so `--timeout` is only a ceiling. The child's stderr passes straight through, which is how a missing binary, a disconnected extension and an auth failure stay distinguishable instead of collapsing into one "no reply" message.

Each call is its own stdio session, so nothing persists in the CLI between calls. The **browser** state does persist: navigate in one call, read the page in the next.

## Notes and limits

- It drives your real, logged-in browser. Treat it like handing a script your keyboard.
- No streaming: you get the whole result at once, as soon as it arrives. Raise `--timeout` for slow actions.
- One tool per invocation. For sequences, run several calls or use `browser_batch`.
- **The tab group is the boundary.** `tabs_context_mcp` lists the tabs in the extension's group and nothing else. No tool pulls another one in: there is no move, no "all windows" flag, and `select_browser` picks a browser rather than a tab. Which window a tab sits in makes no difference. To act on a page you already have open, re-open its URL in a group tab, or add your tab to the group from Chrome's own tab context menu. To merely *list* what you have open, call `list_open_tabs`: it uses the separate `chrome-tabs` server and needs no port, group or extension connection, subject to the readable-profile limitations above.
- **No DevTools protocol.** Navigation, reading and interaction only, so no performance traces, and `navigate` cannot load a `chrome://` URL (it prefixes the scheme).

For CDP work, reach for [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) as it comes. It launches its own Chrome on a profile it keeps between runs (`~/.cache/chrome-devtools-mcp/chrome-profile`), so signing in there once gives you a real session on every later run, with no port open and nothing to enable. Two such servers cannot launch at once: the second answers `The browser is already running for …/chrome-profile`, and `--isolated` is the way out, at the cost of that profile's cookies.

One thing alone needs remote debugging, and that is the tabs you already have open in your daily Chrome. Enable it at `chrome://inspect/#remote-debugging` (Chrome 144 and later) and attach with `--autoConnect`. Not `--browser-url`, whose discovery endpoints answer 404 in that mode, and not `--wsEndpoint`, which pins you to a single browser session. It attaches to your default profile, so any local process reaching the port drives a fully authenticated browser, and the setting persists until you turn it off.

## License

MIT. See [LICENSE](LICENSE).
