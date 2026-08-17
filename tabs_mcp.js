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
const CMD_TAB_CLOSED = 16;
const CMD_WINDOW_CLOSED = 17;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf16Decoder = new TextDecoder('utf-16le', { fatal: true });

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function userDataDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return ['Library/Application Support/Google/Chrome', 'Library/Application Support/Chromium']
      .map((r) => path.join(home, r))
      .filter(isDir);
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const p = path.join(local, 'Google', 'Chrome', 'User Data');
    return isDir(p) ? [p] : [];
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

function newestSessionFile(userDataDir, profile) {
  const dir = path.join(userDataDir, profile, 'Sessions');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const files = names.filter((n) => n.startsWith('Session_')).map((n) => path.join(dir, n));
  if (!files.length) return null;
  return files.reduce((newest, f) =>
    fs.statSync(f).mtimeMs > fs.statSync(newest).mtimeMs ? f : newest
  );
}

// SNSS is a magic + version header, then uint16-length-prefixed commands.
function* records(buf) {
  if (buf.length < 4 || buf.toString('latin1', 0, 4) !== 'SNSS') return;
  let off = 8;
  while (off + 2 <= buf.length) {
    const size = buf.readUInt16LE(off);
    off += 2;
    if (size === 0 || off + size > buf.length) return;
    yield [buf[off], buf.subarray(off + 1, off + size)];
    off += size;
  }
}

function aligned(n) {
  return n + ((4 - (n % 4)) % 4);
}

// Pickle layout: size, tab id, nav index, then url (utf-8) and title (utf-16).
function navigation(payload) {
  const tab = payload.readInt32LE(4);
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
  return { tab, url, title };
}

function parseSession(filePath) {
  const blob = fs.readFileSync(filePath);
  const tabToWindow = new Map();
  const closedTabs = new Set();
  const closedWindows = new Set();
  const nav = new Map();

  for (const [cmd, payload] of records(blob)) {
    if (cmd === CMD_SET_TAB_WINDOW && payload.length >= 8) {
      tabToWindow.set(payload.readInt32LE(4), payload.readInt32LE(0));
    } else if (cmd === CMD_TAB_CLOSED && payload.length >= 4) {
      closedTabs.add(payload.readInt32LE(0));
    } else if (cmd === CMD_WINDOW_CLOSED && payload.length >= 4) {
      closedWindows.add(payload.readInt32LE(0));
    } else if (cmd === CMD_UPDATE_TAB_NAVIGATION && payload.length >= 16) {
      const entry = navigation(payload);
      if (entry) nav.set(entry.tab, { url: entry.url, title: entry.title });
    }
  }

  const tabs = [];
  const entries = [...tabToWindow.entries()].sort(
    (a, b) => a[1] - b[1] || a[0] - b[0]
  );
  for (const [tab, window] of entries) {
    if (closedTabs.has(tab) || closedWindows.has(window)) continue;
    const n = nav.get(tab) || { url: '', title: '' };
    tabs.push({ tab_id: tab, window_id: window, url: n.url, title: n.title });
  }
  return tabs;
}

function collect(profileFilter) {
  const results = [];
  for (const udd of userDataDirs()) {
    for (const profile of profileDirs(udd)) {
      if (profileFilter && profile !== profileFilter) continue;
      const file = newestSessionFile(udd, profile);
      if (!file) continue;
      let tabs;
      try {
        tabs = parseSession(file);
      } catch {
        continue;
      }
      results.push({ user_data_dir: udd, profile, session_file: path.basename(file), tabs });
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

// Origin and path only: no credentials, query string or fragment. A raw URL
// can carry a token or session id that the bridge's own redaction would have
// caught, and this server has no equivalent redaction over page content.
function redactUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return '(unparseable)';
  }
}

function render(groups, { includeUrls = true, fullUrls = false } = {}) {
  if (!groups.length) {
    return 'No Chrome session file found. Looked for <user data dir>/<profile>/Sessions/Session_*.';
  }
  const withTabs = groups.filter((g) => g.tabs.length);
  if (!withTabs.length) {
    return 'Chrome session files were found, but no profile has an open tab.';
  }

  const out = [];
  const total = withTabs.reduce((n, g) => n + g.tabs.length, 0);
  out.push(`${total} open tab(s) across ${withTabs.length} profile(s), read from disk.`);
  out.push('This is a snapshot Chrome writes periodically, so it can lag by a little.');
  for (const g of withTabs) {
    const windows = new Set(g.tabs.map((t) => t.window_id));
    out.push('');
    out.push(`## profile ${g.profile} (${g.tabs.length} tabs, ${windows.size} window(s), ${g.session_file})`);
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
      'it for any read-only question about what is open. It cannot drive a page. ' +
      'URLs are redacted by default to origin and path only, with credentials, ' +
      'query strings and fragments stripped, since a raw URL can carry a token ' +
      "or session id that the bridge's own redaction would have caught. Pass " +
      'full_urls to get the raw URL instead.',
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

module.exports = { collect, parseSession, render, redactUrl, aligned, SERVER_VERSION };
