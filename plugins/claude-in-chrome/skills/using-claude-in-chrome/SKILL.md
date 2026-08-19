---
name: using-claude-in-chrome
description: Use before controlling Chrome for anything that needs the user's real login session (a tool behind SSO, a Slack UI action, any cookie-gated page) and whenever another browser tool lands on a login page, returns an empty or anonymous-looking page, or seems to have lost a session that worked a moment ago. Also use when scripting browser control from a shell, a cron job, or an agent that cannot hold an MCP connection. Also use when asked what is currently open in Chrome (how many tabs, is a page open anywhere, what url a tab is on), which `list_open_tabs` answers from the profile on disk without driving a browser.
---

# Using Claude in Chrome

## First: is the question "what is open?"

Then do not drive a browser at all. Call **`list_open_tabs`**, from the `chrome-tabs` server this plugin ships. It reads Chrome and Chromium session data from disk, so it sees every tab it can recover across readable profiles, with no debugging port, no extension and no tab group. Encrypted, unsupported or unreadable profiles are reported rather than silently counted as empty. Measured on one machine: the bridge could see 4 tabs, `list_open_tabs` saw 29, of which 25 were outside the group.

Pass `include_urls: false` for counts and hosts only, or `profile` to narrow to one Chrome profile. URLs are redacted to a safe origin and path by default; `full_urls: true` exposes the raw URL, which can contain credentials, query strings or session tokens, so use it only when the raw value is necessary.

It returns URLs and titles, not page content, and it cannot drive a page. It also does not track which tab or window currently has focus, only which page each tab is showing, and Chromium history-pruning events can leave that page stale: do not use it to answer "which tab is the user looking at right now". For either page content or drive, read on.

## Overview

Three different mechanisms all count as "browser control", and they are not interchangeable:

| Mechanism | Drives | Session |
| --- | --- | --- |
| Claude in Chrome extension bridge (this plugin) | The user's daily Chrome, but only the tabs inside the extension's tab group | Whatever SSO and cookies they already have in that browser |
| `chrome-devtools` MCP as it comes | Its own Chrome, launched on its own profile | A *separate* profile that persists between runs. Unauthenticated only until someone logs into it once. |
| `chrome-devtools` attached to the daily Chrome (`--autoConnect`) | That same daily Chrome over CDP: every tab, every window, no tab group | The user's own session, once they have enabled remote debugging |

The middle row is the one usually misread. `chrome-devtools` is not sessionless: its `--userDataDir` defaults to `~/.cache/chrome-devtools-mcp/chrome-profile` and it keeps cookies there across runs, so a login done once holds. What it is not is *the user's* profile, so a page needing their identity comes back anonymous until someone signs in on that profile. `--isolated` is the flag that makes it genuinely throwaway.

So a navigate reporting success while the page is actually unauthenticated is still the trap to watch for. Verify, do not assume.

## Reaching the bridge

- Inside a Claude Code session with this plugin installed and the Claude in Chrome extension connected, the `claude-in-chrome` MCP tools appear directly (`navigate`, `read_page`, `find`, `computer`, `get_page_text`, and the rest). Use them.
- From a shell, a script, a cron job, or an agent that cannot hold an MCP connection: use `node ${CLAUDE_PLUGIN_ROOT}/bin/cic.js`, or plain `cic` where the npm package is installed globally. It speaks the same MCP handshake over stdio to `claude --claude-in-chrome-mcp`.
  - `cic list` lists the available tools
  - `cic call <tool_name> '<json-args>'` calls one, with `--timeout <secs>` as a ceiling (default 30) and `--json` for the raw result object
  - **Check the exit code; do not read the text to decide whether it worked.** 0 succeeded, 1 the tool itself reported an error, 2 the request went out and no usable reply came back so the outcome is unknown, 3 it failed before the request was sent so the browser cannot have acted, 64 a usage or JSON error. Only 3 is safe to retry blindly: after a 2, a click or a script may already have run.
  - Each `cic call` is its own MCP session, so its tab group starts empty. Three ways out, cheapest first: `cic with-tab <url> <tool> '<args>'` makes a tab, navigates, runs one tool against it and closes it; `cic session --jsonl` holds one connection open for many calls, so a `tabId` from an earlier reply stays valid; or create a tab with `cic call tabs_create_mcp '{}'` and pass the id it prints to every later call. Without one of these the tool answers `No tab available`. Inside a Claude Code session the MCP tools keep one group, so this does not apply there.
  - A screenshot reaches a file with `--output <path>` on `cic call` or `cic with-tab`. It refuses rather than writing anything when the result carries no image, more than one, or bytes that are not one, so a path that exists always holds a whole image. The bridge returns JPEG today whatever the file is named, and the mismatch is reported on stderr.
  - `cic tabs` answers what is open, reading the profile from disk with no bridge, no handshake and no extension: the CLI counterpart of `list_open_tabs`. `--json` for machine-readable output, `--profile <name>` for one profile, `--full-urls` to opt out of redaction.
  - **After an unknown outcome, `cic with-tab` leaves its tab open on purpose** and prints the id. Closing a tab whose outcome is undetermined could discard a half-finished action, so go and look at it rather than assuming it is gone.
  - The shell version, `cic.sh`, was removed in 0.4.0. It exited 0 even on failure, so anything still calling it is reading success out of a broken pipeline.

Never enter the user's credentials to force a session. Ask them to complete SSO in that Chrome window instead.

## Mechanics

- **List tabs and create your own.** Call `tabs_context_mcp` first; the automated tab group can hold pages the user is working in. Never navigate a tab you did not create.
- **The tab group is the only axis. Windows are irrelevant.** `tabs_context_mcp` returns the group's tabs and nothing else, so a tab the user has open elsewhere is invisible whatever window it sits in, and nothing adopts it: there is no move tool, no "all windows" flag, and `select_browser` picks a browser rather than a tab. Asking the user to switch windows cannot work. To *read* what they have open, call `list_open_tabs` instead of driving anything. To *drive* one of those tabs, attach (below).
- **To reach a page the user already has open, re-open it.** `tabs_create_mcp` then `navigate` to the same URL gets the same profile and the same cookies at no cost to the user. Anything you would reload anyway, a performance measurement for instance, never needs their original tab.
- **The bridge cannot open `chrome://` URLs.** `navigate` prefixes the scheme and lands on `https://chrome://…`. Ask the user to open those pages themselves.
- **Navigate, then verify in a separate call.** A navigate can report success while the tab stays on `chrome://newtab`. Check `location.hostname` before acting.
- **A slow page needs a bigger ceiling, not a longer wait.** `cic` returns the moment the bridge replies, so `--timeout` costs nothing when the page is quick; raise it to 60 for a slow navigation rather than accepting a truncated answer. Reading a page before it has settled still returns empty content, which reads like failure, so verify rather than assume (above).
- **The bridge redacts secret-shaped values.** Anything returned containing a query string, cookie, JWT shape or base64 comes back as `[BLOCKED: …]`. Return parsed fields and counts, never the URL you fetched, and build a literal `?` with `String.fromCharCode(63)` when a key would otherwise contain one.
- **Auto-refreshing and log-heavy pages freeze the renderer** at the 45 second CDP limit. Turn refresh off, or fetch from a static page on the same origin.
- Tab ids change after a Chrome restart.

## When `chrome-devtools` is the right choice instead

This plugin covers navigation, reading and interaction, not the DevTools protocol, so it has no tracing tool. Anything on CDP goes to `chrome-devtools`: performance traces, heap snapshots, Lighthouse, emulation.

That need not cost the user their session. `chrome-devtools` keeps its own profile between runs, so signing in there once buys a real session for every later run, with no port open and nothing to enable. Prefer that to asking for remote debugging. A page needing no identity at all needs neither.

⚠️ **Two `chrome-devtools` servers that both launch a browser fight over that profile.** The second one answers `The browser is already running for …/chrome-profile. Use --isolated to run multiple browser instances.` If more than one is registered, give the extras `--isolated`, which also throws their cookies away, or drop them.

## When to attach to the daily Chrome (`--autoConnect`)

One job needs this and nothing else does: **reaching the tabs the user already has open.** The bridge sees only its own group, and the launched profile is a different browser, so a survey of what is open, or a page whose state cannot be reproduced, has to attach.

For a page the user already has open, in order: re-open the URL in a group tab, which is free and needs no setup; attach, if re-opening loses state that matters or you need several of their tabs; ask them to add the tab to the group from Chrome's own tab context menu only as a last resort. The group is a native Chrome tab group, so that menu acts on it. Do not ask them to drag a tab between windows.

Setup is once: the user enables remote debugging at `chrome://inspect/#remote-debugging` (Chrome 144 and later), then `chrome-devtools` connects with `--autoConnect`. Prefer that flag over the alternatives: the HTTP discovery endpoints answer 404 in this mode, so `--browser-url` fails, and pinning `--wsEndpoint` to the path in `DevToolsActivePort` ties you to one browser session. `--autoConnect` reads that file itself.

Do not treat that file as proof the setting is on. It outlives it: it has been seen still naming port 9222 with nothing listening. Check for a listener on the port instead.

Tell the user the trade before suggesting it. The port listens on loopback only, so the exposure is local processes rather than the network, but any of them can then drive a fully authenticated browser, and the toggle stays on until the user turns it off.

## Red flags: switch to this plugin's tools, or to an attached `chrome-devtools`

- Another browser tool lands on a login or SSO page for a host the user is normally logged into
- Output looks empty or anonymous for a page that should show account-specific content
- The task is a tool behind SSO, a Slack UI action, or anything else needing the user's real cookies
