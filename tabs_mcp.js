#!/usr/bin/env node
// Stdio MCP server exposing Chrome's open tabs, read from the profile on disk.
//
// The Claude in Chrome bridge can only see tabs inside its own tab group, and
// attaching a debugger needs the user to turn on remote debugging. Neither is
// required to answer "what is open": Chrome writes the live session to
// <profile>/Sessions/Session_* and that file parses without a port or a group.
//
// No third-party dependencies. Read only: this never drives a page. Requires
// Node 22 or later.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const SERVER_NAME = 'chrome-tabs';
const SERVER_VERSION = '0.3.0';
const PROTOCOL_VERSION = '2024-11-05';

// chromium/components/sessions/core/session_service_commands.cc
const CMD_SET_TAB_WINDOW = 0;
const CMD_UPDATE_TAB_NAVIGATION = 6;
const CMD_SET_SELECTED_NAVIGATION_INDEX = 7;
const CMD_TAB_CLOSED = 16;
const CMD_WINDOW_CLOSED = 17;

// chromium/components/sessions/core/session_backend.cc kFileCurrentVersion.
// 3 is the current cleartext format, confirmed against a real session file
// on this machine. Version 5 is encrypted and unreadable by this parser
// regardless; any version this parser has not confirmed is treated the same
// way, fail closed, rather than assumed compatible.
const SNSS_CURRENT_VERSION = 3;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf16Decoder = new TextDecoder('utf-16le', { fatal: true });

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// platform/env/home are injectable so path discovery can be tested for every
// OS from one machine, not only the one the tests happen to run on.
function userDataDirs(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') {
    return ['Library/Application Support/Google/Chrome', 'Library/Application Support/Chromium']
      .map((r) => path.join(home, r))
      .filter(isDir);
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join('Google', 'Chrome', 'User Data'), path.join('Chromium', 'User Data')]
      .map((r) => path.join(local, r))
      .filter(isDir);
  }
  return ['.config/google-chrome', '.config/chromium']
    .map((r) => path.join(home, r))
    .filter(isDir);
}

function profileDirs(userDataDir) {
  let names;
  try {
    names = fs.readdirSync(userDataDir).sort();
  } catch {
    return [];
  }
  return names.filter(
    (name) =>
      (name === 'Default' || name.startsWith('Profile ')) &&
      isDir(path.join(userDataDir, name, 'Sessions'))
  );
}

// Newest first: a truncated or unrecognized newest file falls back to the
// next one down rather than being reported as an empty browser.
function sessionFilesNewestFirst(userDataDir, profile) {
  const dir = path.join(userDataDir, profile, 'Sessions');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  // Stat once per file up front, outside the comparator: Chrome can remove
  // or replace a session file at any time, and an unguarded statSync inside
  // Array.sort throws mid-sort, which crashes before collect() ever gets a
  // chance to fall back to an older file.
  const stated = names
    .filter((n) => n.startsWith('Session_'))
    .map((n) => path.join(dir, n))
    .map((f) => {
      try {
        return { file: f, mtimeMs: fs.statSync(f).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stated.map((s) => s.file);
}

function aligned(n) {
  return n + ((4 - (n % 4)) % 4);
}

// SNSS is a magic + version header, then uint16-length-prefixed commands.
// validMagic false means this is not a file this parser can read at all,
// whether because the magic is wrong or the version is one it has not
// confirmed. truncated true means it started as a version it understands
// but a record's declared size ran past the end of the file, or the file
// ended with leftover bytes too short to even hold a length prefix: either
// way, a record was cut off mid-write. Records collected before that point
// are still returned.
function readRecords(buf) {
  const records = [];
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'SNSS') {
    return { records, validMagic: false, truncated: false };
  }
  if (buf.readUInt32LE(4) !== SNSS_CURRENT_VERSION) {
    return { records, validMagic: false, truncated: false };
  }
  let off = 8;
  while (off + 2 <= buf.length) {
    const size = buf.readUInt16LE(off);
    off += 2;
    if (size === 0 || off + size > buf.length) {
      return { records, validMagic: true, truncated: true };
    }
    records.push([buf[off], buf.subarray(off + 1, off + size)]);
    off += size;
  }
  return { records, validMagic: true, truncated: off < buf.length };
}

// Pickle layout: size, tab id, nav index, then url (utf-8) and title (utf-16).
// The nav index matters: a tab that went A -> B -> back to A has two entries,
// and CMD_SET_SELECTED_NAVIGATION_INDEX (not this record) says which one the
// tab is actually showing.
function navigation(payload) {
  const tab = payload.readInt32LE(4);
  const index = payload.readInt32LE(8);
  const urlLen = payload.readInt32LE(12);
  if (!(urlLen > 0 && urlLen < 8192) || 16 + urlLen > payload.length) return null;
  let url;
  try {
    url = utf8Decoder.decode(payload.subarray(16, 16 + urlLen));
  } catch {
    return null;
  }

  let title = '';
  const off = 16 + aligned(urlLen);
  if (off + 4 <= payload.length) {
    const chars = payload.readInt32LE(off);
    if (chars > 0 && chars < 4096 && off + 4 + chars * 2 <= payload.length) {
      try {
        title = utf16Decoder.decode(payload.subarray(off + 4, off + 4 + chars * 2));
      } catch {
        title = '';
      }
    }
  }
  return { tab, index, url, title };
}

// Returns { tabs, validMagic, truncated }. tabs is whatever could be
// recovered even when truncated is true: a partial answer beats none.
function parseSession(filePath) {
  const blob = fs.readFileSync(filePath);
  const { records, validMagic, truncated } = readRecords(blob);

  const tabToWindow = new Map();
  const closedTabs = new Set();
  const closedWindows = new Set();
  const navByTab = new Map(); // tab -> Map(index -> {url, title})
  const selectedIndex = new Map(); // tab -> currently selected nav index

  for (const [cmd, payload] of records) {
    if (cmd === CMD_SET_TAB_WINDOW && payload.length >= 8) {
      tabToWindow.set(payload.readInt32LE(4), payload.readInt32LE(0));
    } else if (cmd === CMD_TAB_CLOSED && payload.length >= 4) {
      closedTabs.add(payload.readInt32LE(0));
    } else if (cmd === CMD_WINDOW_CLOSED && payload.length >= 4) {
      closedWindows.add(payload.readInt32LE(0));
    } else if (cmd === CMD_SET_SELECTED_NAVIGATION_INDEX && payload.length >= 8) {
      selectedIndex.set(payload.readInt32LE(0), payload.readInt32LE(4));
    } else if (cmd === CMD_UPDATE_TAB_NAVIGATION && payload.length >= 16) {
      const entry = navigation(payload);
      if (entry) {
        if (!navByTab.has(entry.tab)) navByTab.set(entry.tab, new Map());
        navByTab.get(entry.tab).set(entry.index, { url: entry.url, title: entry.title });
      }
    }
  }

  const tabs = [];
  const entries = [...tabToWindow.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  for (const [tab, window] of entries) {
    if (closedTabs.has(tab) || closedWindows.has(window)) continue;
    const byIndex = navByTab.get(tab);
    let entry = { url: '', title: '' };
    if (byIndex && byIndex.size) {
      const wanted = selectedIndex.get(tab);
      const index = byIndex.has(wanted) ? wanted : Math.max(...byIndex.keys());
      entry = byIndex.get(index);
    }
    tabs.push({ tab_id: tab, window_id: window, url: entry.url, title: entry.title });
  }
  return { tabs, validMagic, truncated };
}

// Tries session files newest first. A file this parser does not recognize,
// or a truncated one that recovered nothing, is skipped in favor of an
// older one rather than reported as "no tabs".
function collect(profileFilter) {
  const results = [];
  for (const udd of userDataDirs()) {
    for (const profile of profileDirs(udd)) {
      if (profileFilter && profile !== profileFilter) continue;
      const files = sessionFilesNewestFirst(udd, profile);
      if (!files.length) continue;

      let chosen = null;
      let chosenFile = null;
      for (const file of files) {
        let result;
        try {
          result = parseSession(file);
        } catch {
          continue;
        }
        if (!result.validMagic) continue;
        if (result.truncated && result.tabs.length === 0) continue;
        chosen = result;
        chosenFile = file;
        break;
      }

      if (!chosen) {
        results.push({ user_data_dir: udd, profile, session_file: null, tabs: [], status: 'unreadable' });
        continue;
      }
      results.push({
        user_data_dir: udd,
        profile,
        session_file: path.basename(chosenFile),
        tabs: chosen.tabs,
        status: chosen.truncated ? 'incomplete' : 'ok',
      });
    }
  }
  return results;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname || '(none)';
  } catch {
    return '(unparseable)';
  }
}

// Schemes confirmed safe to show host and path for. Anything not on this
// list renders as the bare scheme: an allowlist, not a blocklist, because a
// wrapper scheme like blob:, filesystem: or view-source: puts another URL,
// credentials and all, directly in its own pathname. Enumerating wrapper
// schemes one at a time never terminates; this bounds the problem instead.
const HOST_SAFE_SCHEMES = new Set(['http:', 'https:', 'chrome:', 'chrome-extension:']);

// Credentials, query strings and fragments are always stripped, since a raw
// URL can carry a token or session id that the extension bridge's own
// redaction would have caught.
function redactUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '(unparseable)';
  }
  if (u.protocol === 'data:') {
    // The payload after the comma is arbitrary embedded content, not a page
    // address; only the media type before it is safe to show.
    return `data:${u.pathname.split(',')[0]},[redacted]`;
  }
  if (u.protocol === 'file:') {
    return `file://${u.pathname}`;
  }
  if (u.protocol === 'about:') {
    return `about:${u.pathname}`;
  }
  if (HOST_SAFE_SCHEMES.has(u.protocol) && u.host) {
    return `${u.protocol}//${u.host}${u.pathname}`;
  }
  return u.protocol;
}

function render(groups, { includeUrls = true, fullUrls = false } = {}) {
  if (!groups.length) {
    return 'No Chrome session file found. Looked for <user data dir>/<profile>/Sessions/Session_*.';
  }

  const unreadable = groups.filter((g) => g.status === 'unreadable');
  const withTabs = groups.filter((g) => g.tabs.length);

  if (!withTabs.length) {
    const lines = [];
    if (unreadable.length < groups.length) {
      lines.push('Chrome session files were found, but no profile has an open tab.');
    }
    if (unreadable.length) {
      lines.push(
        `${unreadable.length} profile(s) could not be read (${unreadable.map((g) => g.profile).join(', ')}): ` +
          'every session file for them was unrecognized or too damaged to parse. This can mean a Chrome ' +
          'version this parser has not seen, or a file caught mid-write; it is not the same as having no tabs.'
      );
    }
    return lines.join('\n');
  }

  const out = [];
  const total = withTabs.reduce((n, g) => n + g.tabs.length, 0);
  out.push(`${total} open tab(s) across ${withTabs.length} profile(s), read from disk.`);
  out.push('This is a snapshot Chrome writes periodically, so it can lag by a little.');
  if (unreadable.length) {
    out.push(
      `${unreadable.length} other profile(s) could not be read and are omitted: ` +
        unreadable.map((g) => g.profile).join(', ') +
        '.'
    );
  }
  for (const g of withTabs) {
    const windows = new Set(g.tabs.map((t) => t.window_id));
    out.push('');
    out.push(`## profile ${g.profile} (${g.tabs.length} tabs, ${windows.size} window(s), ${g.session_file})`);
    if (g.status === 'incomplete') {
      out.push('note: this profile\'s session file was truncated or partly unreadable; the list below may be incomplete.');
    }
    const hosts = new Map();
    for (const t of g.tabs) {
      const host = hostnameOf(t.url);
      hosts.set(host, (hosts.get(host) || 0) + 1);
    }
    const top = [...hosts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, 15);
    out.push('hosts: ' + top.map(([h, c]) => `${h} (${c})`).join(', '));
    if (includeUrls) {
      for (const t of g.tabs) {
        const label = (t.title || '(no title)').slice(0, 70);
        const shown = (fullUrls ? t.url : redactUrl(t.url)).slice(0, 160);
        out.push(`  [w${t.window_id}] ${label} :: ${shown}`);
      }
    }
  }
  return out.join('\n');
}

const TOOLS = [
  {
    name: 'list_open_tabs',
    description:
      'List every tab open in Chrome, across every window and every profile on ' +
      'this machine, by reading the browser session file from disk. Needs no ' +
      'remote debugging port, no extension and no tab group, so it sees tabs the ' +
      "Claude in Chrome bridge cannot, and it is not limited to one profile. Use " +
      'it for any read-only question about what is open. It cannot drive a page, ' +
      'and it does not track which tab or window currently has focus, only which ' +
      'page each tab is on: for a tab whose history was pruned (not just navigated ' +
      'back and forth), the reported page can be stale. URLs are redacted by ' +
      'default to origin and path for known-safe schemes only, with credentials, ' +
      'query strings and fragments always stripped; an unrecognized or wrapper ' +
      "scheme (blob:, filesystem:, view-source:) shows only its scheme, since its " +
      'path can itself be another URL with credentials embedded. Pass full_urls ' +
      'to get the raw URL instead. This is a best-effort reader of an undocumented ' +
      'Chromium format: a session file in a version this parser has not confirmed, ' +
      'or one cut off mid-write, is reported as unreadable rather than as empty.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description: "Limit to one Chrome profile directory, e.g. 'Default'.",
        },
        include_urls: {
          type: 'boolean',
          default: true,
          description: 'Include a per-tab title and URL line. False returns only counts and hosts.',
        },
        full_urls: {
          type: 'boolean',
          default: false,
          description:
            'Return the raw URL instead of the redacted origin and path. Off by ' +
            'default because a raw URL can carry credentials, a query string or a ' +
            'session token.',
        },
      },
    },
  },
];

function handle(request) {
  const method = request.method;
  if (method === 'initialize') {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
  }
  if (method === 'tools/list') {
    return { tools: TOOLS };
  }
  if (method === 'tools/call') {
    const params = request.params || {};
    if (params.name !== 'list_open_tabs') {
      throw new Error(`unknown tool: ${params.name}`);
    }
    const args = params.arguments || {};
    const text = render(collect(args.profile), {
      includeUrls: args.include_urls !== false,
      fullUrls: args.full_urls === true,
    });
    return { content: [{ type: 'text', text }] };
  }
  throw new Error(`unknown method: ${method}`);
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (!('id' in request)) return; // a notification, nothing to answer
    let response;
    try {
      response = { jsonrpc: '2.0', id: request.id, result: handle(request) };
    } catch (exc) {
      response = { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: exc.message } };
    }
    process.stdout.write(JSON.stringify(response) + '\n');
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  collect,
  parseSession,
  readRecords,
  render,
  redactUrl,
  aligned,
  userDataDirs,
  sessionFilesNewestFirst,
  SERVER_VERSION,
  SNSS_CURRENT_VERSION,
};
