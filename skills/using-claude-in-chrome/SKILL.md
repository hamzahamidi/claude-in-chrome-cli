---
name: using-claude-in-chrome
description: Use before controlling Chrome for anything that needs the user's real login session (a tool behind SSO, a Slack UI action, any cookie-gated page) and whenever another browser tool lands on a login page, returns an empty or anonymous-looking page, or seems to have lost a session that worked a moment ago. Also use when scripting browser control from a shell, a cron job, or an agent that cannot hold an MCP connection.
---

# Using Claude in Chrome

## Overview

Two different mechanisms both count as "browser control", and they are not interchangeable:

| Mechanism | Drives | Session |
| --- | --- | --- |
| Sessionless browser tools (`chrome-devtools` MCP, Playwright MCP) | Their own Chrome instance via CDP | Can silently start a fresh profile or drop an existing one mid-task. A navigate can report success while the tab is actually unauthenticated. |
| Claude in Chrome extension bridge (this plugin) | The user's real, already-logged-in Chrome | Whatever SSO and cookies the user already has in that browser |

If the task needs the user's identity or an existing session, a sessionless browser tool is not a fallback, it is a trap: it can report a clean navigate while quietly running unauthenticated. Use this plugin's tools instead.

## Reaching the bridge

- Inside a Claude Code session with this plugin installed and the Claude in Chrome extension connected, the `claude-in-chrome` MCP tools appear directly (`navigate`, `read_page`, `find`, `computer`, `get_page_text`, and the rest). Use them.
- From a shell, a script, a cron job, or an agent that cannot hold an MCP connection: use `${CLAUDE_PLUGIN_ROOT}/cic.sh`. It speaks the same MCP handshake over stdio to `claude --claude-in-chrome-mcp`.
  - `cic.sh --list` lists the available tools
  - `cic.sh <tool_name> '<json-args>' [wait_secs]` calls one

Never enter the user's credentials to force a session. Ask them to complete SSO in that Chrome window instead.

## Mechanics

- **List tabs and create your own.** Call `tabs_context_mcp` first; the automated tab group can hold pages the user is working in. Never navigate a tab you did not create.
- **Navigate, then verify in a separate call.** A navigate can report success while the tab stays on `chrome://newtab`. Check `location.hostname` before acting.
- **Allow 35 to 40 seconds** after navigating a slow page. A shorter wait returns empty output with no error, which reads like failure.
- **The bridge redacts secret-shaped values.** Anything returned containing a query string, cookie, JWT shape or base64 comes back as `[BLOCKED: …]`. Return parsed fields and counts, never the URL you fetched, and build a literal `?` with `String.fromCharCode(63)` when a key would otherwise contain one.
- **Auto-refreshing and log-heavy pages freeze the renderer** at the 45 second CDP limit. Turn refresh off, or fetch from a static page on the same origin.
- Tab ids change after a Chrome restart.

## When a sessionless browser tool is the right choice

Testing a web app under development where no real login matters: fresh-page rendering, performance traces, accessibility audits, console or network inspection on a page that doesn't need the user's identity.

## Red flags: switch to this plugin's tools

- Another browser tool lands on a login or SSO page for a host the user is normally logged into
- Output looks empty or anonymous for a page that should show account-specific content
- The task is a tool behind SSO, a Slack UI action, or anything else needing the user's real cookies
