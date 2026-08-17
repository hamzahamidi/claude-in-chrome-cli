# claude-in-chrome-cli (`cic`)

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-da7756)](https://www.claudepluginhub.com/plugins/hamzahamidi-claude-in-chrome)
[![Listed on ClaudePluginHub](https://www.claudepluginhub.com/badge/hamzahamidi-claude-in-chrome)](https://www.claudepluginhub.com/plugins/hamzahamidi-claude-in-chrome)
[![Release](https://img.shields.io/github/v/release/hamzahamidi/claude-in-chrome-cli)](https://github.com/hamzahamidi/claude-in-chrome-cli/releases)
[![License: MIT](https://img.shields.io/github/license/hamzahamidi/claude-in-chrome-cli)](LICENSE)

Use the **Claude in Chrome** extension tools natively in Claude Code, or call them from your shell with `cic.sh`. Both connect through the same MCP server.

![cic.sh listing the tools the Claude in Chrome extension exposes](docs/cic-demo.png)

## Why

Claude Code ships a stdio MCP server, `claude --claude-in-chrome-mcp`, that bridges to the Claude in Chrome extension. Through it you can drive your **real, logged-in** Chrome: navigate, read the page, click, type, run JavaScript, read the console and network.

Normally you reach those tools from inside a Claude session. Sometimes you just want one from a script or a terminal: a quick navigation, a page-text dump, a one-off step in a shell pipeline. `cic.sh` does that. It speaks the MCP handshake over stdio, calls one tool, prints the result, and exits.

The plugin is a second front door. Install it to make `navigate`, `read_page`, `find`, `computer`, `get_page_text`, and the rest of the extension tools available natively in new Claude Code sessions.

Where this is going, release by release: see the [roadmap](ROADMAP.md).

## Requirements

- The **Claude Code CLI** (`claude`) on your PATH.
- The **Claude in Chrome** extension installed and connected to a running Chrome.
- `python3` (parses the JSON-RPC reply; `cic.sh` only).

## Install

### As a Claude Code plugin

```text
/plugin marketplace add hamzahamidi/claude-in-chrome-cli
/plugin install claude-in-chrome@claude-in-chrome-cli
```

New Claude Code sessions get all the extension tools natively, plus a skill ([`using-claude-in-chrome`](skills/using-claude-in-chrome/SKILL.md)) that teaches the agent when your real session is the one that matters, which browser tool to reach for when it is not, and how to avoid the common traps.

### As a shell script

```sh
curl -O https://raw.githubusercontent.com/hamzahamidi/claude-in-chrome-cli/main/cic.sh
chmod +x cic.sh
```

## Usage

```sh
./cic.sh --list                                  # list available tools
./cic.sh <tool_name> '<json-args>' [wait_secs]   # call a tool (default wait: 8s)
```

`wait_secs` is how long to wait for the browser to answer before the connection closes. Slow pages or heavy actions need a larger value.

## Examples

```sh
# See what tools the extension exposes
./cic.sh --list

# Make a tab of your own. It prints "Created new tab. Tab ID: 2099038679"
./cic.sh tabs_create_mcp '{}'

# Then pass that id to every tool that acts on a page
./cic.sh navigate '{"url":"https://example.com","tabId":2099038679}'
./cic.sh get_page_text '{"tabId":2099038679}' 5
./cic.sh computer '{"action":"screenshot","tabId":2099038679}'
./cic.sh javascript_tool '{"action":"javascript_exec","text":"document.title","tabId":2099038679}'

# Close it when you are done
./cic.sh tabs_close_mcp '{"tabId":2099038679}'
```

`tabId` is required here. Each `cic.sh` call is its own MCP session, so the session starts with an empty tab group and a tool that acts on a page answers `No tab available` without one. `--list` and `tabs_context_mcp` are the exceptions, since neither touches a page.

Never pass the id of a tab you are working in. `tabs_context_mcp` lists every tab the extension can see, including yours.

## Tools

The exact set depends on your extension version. Run `./cic.sh --list` for the live list. Common ones:

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

Argument shapes come from the extension, not from this script. The `--list` output includes each tool's description, which documents its arguments.

## How it works

An MCP stdio server reads newline-delimited JSON-RPC on stdin and writes responses on stdout. `cic.sh` sends three messages, then sleeps to let the reply arrive:

1. `initialize` (the MCP handshake).
2. `notifications/initialized`.
3. `tools/call` (or `tools/list`) with your tool name and arguments, as request id `2`.

It pipes them into `claude --claude-in-chrome-mcp` and reads stdout back. A short `python3` filter picks the reply with id `2` and prints its text content.

Each call is its own stdio session, so nothing persists in the CLI between calls. The **browser** state does persist: navigate in one call, read the page in the next.

## Notes and limits

- It drives your real, logged-in browser. Treat it like handing a script your keyboard.
- No streaming: you get the result after `wait_secs`. Raise it for slow actions.
- One tool per invocation. For sequences, run several calls or use `browser_batch`.
- **The tab group is the boundary.** `tabs_context_mcp` lists the tabs in the extension's group and nothing else. No tool pulls another one in: there is no move, no "all windows" flag, and `select_browser` picks a browser rather than a tab. Which window a tab sits in makes no difference. To act on a page you already have open, re-open its URL in a group tab, or add your tab to the group from Chrome's own tab context menu. To merely *list* what you have open, skip the bridge entirely and parse Chrome's session file (`<profile>/Sessions/Session_*`, newest by mtime, SNSS format): no port, no group, no setup.
- **No DevTools protocol.** Navigation, reading and interaction only, so no performance traces, and `navigate` cannot load a `chrome://` URL (it prefixes the scheme).

For CDP work, reach for [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) as it comes. It launches its own Chrome on a profile it keeps between runs (`~/.cache/chrome-devtools-mcp/chrome-profile`), so signing in there once gives you a real session on every later run, with no port open and nothing to enable. Two such servers cannot launch at once: the second answers `The browser is already running for …/chrome-profile`, and `--isolated` is the way out, at the cost of that profile's cookies.

One thing alone needs remote debugging, and that is the tabs you already have open in your daily Chrome. Enable it at `chrome://inspect/#remote-debugging` (Chrome 144 and later) and attach with `--autoConnect`. Not `--browser-url`, whose discovery endpoints answer 404 in that mode, and not `--wsEndpoint`, which pins you to a single browser session. It attaches to your default profile, so any local process reaching the port drives a fully authenticated browser, and the setting persists until you turn it off.

## License

MIT. See [LICENSE](LICENSE).
