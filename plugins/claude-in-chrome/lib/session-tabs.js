// Reader for Chrome's on-disk session files (SNSS), and the redaction and
// rendering that go with it.
//
// Separate from the MCP server because there are now two consumers: the
// chrome-tabs server exposes it as a tool, and `cic tabs` answers the same
// question directly, since a read that only touches the filesystem has no
// reason to spawn a bridge. Nothing here drives a page or opens a socket.
//
// No third-party dependencies. Read only. Requires Node 22 or later.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// chromium/components/sessions/core/session_service_commands.cc
const CMD_SET_TAB_WINDOW = 0;
const CMD_UPDATE_TAB_NAVIGATION = 6;
const CMD_SET_SELECTED_NAVIGATION_INDEX = 7;
const CMD_TAB_CLOSED = 16;
const CMD_WINDOW_CLOSED = 17;
// chromium/components/sessions/core/command_storage_backend.cc
// kInitialStateMarkerCommandId. Written exactly once, when the initial
// snapshot finishes being written. Its absence means Chromium itself would
// not treat the file as a valid, complete snapshot; this parser follows the
// same rule rather than trusting a byte-complete file that never earned it.
const CMD_INITIAL_STATE_MARKER = 255;

// chromium/components/sessions/core/command_storage_backend.cc
// kFileVersionWithMarker. 3 is the current cleartext format, confirmed
// against a real session file on this machine. kFileVersionEncryptedWithOSCrypt
// (5) is encrypted and unreadable by this parser regardless; any version
// this parser has not confirmed is treated the same way, fail closed,
// rather than assumed compatible.
const SNSS_CURRENT_VERSION = 3;

// chromium/components/sessions/core/session_constants.cc. Chrome's staged
// encryption rollout (added Chrome 148, crbug.com/479420496) can write a
// profile's session data here instead of, or alongside, CLEARTEXT_SESSIONS_DIR.
// This parser cannot decrypt that format; a profile using only this
// directory is reported as such, not silently skipped as if it had no
// session data at all.
const CLEARTEXT_SESSIONS_DIR = 'Sessions';
const ENCRYPTED_SESSIONS_DIR = 'Sessions_Encrypted';

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

// A profile counts as one this tool knows about if it has either session
// directory: cleartext, encrypted, or both. Requiring only CLEARTEXT_SESSIONS_DIR
// silently dropped a profile that has moved to encrypted-only storage,
// rather than reporting it as unreadable.
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
      (isDir(path.join(userDataDir, name, CLEARTEXT_SESSIONS_DIR)) ||
        isDir(path.join(userDataDir, name, ENCRYPTED_SESSIONS_DIR)))
  );
}

function hasEncryptedSessionData(userDataDir, profile) {
  const dir = path.join(userDataDir, profile, ENCRYPTED_SESSIONS_DIR);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((n) => n.startsWith('Session_'));
}

// Newest first: a truncated or unrecognized newest file falls back to the
// next one down rather than being reported as an empty browser.
function sessionFilesNewestFirst(userDataDir, profile) {
  const dir = path.join(userDataDir, profile, CLEARTEXT_SESSIONS_DIR);
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
// validMagic false means this is not a file this parser trusts, whether
// because the magic is wrong, the version is one it has not confirmed, or
// CMD_INITIAL_STATE_MARKER never appears among the records recovered.
// Chromium writes that marker once, after its initial commands, and will
// not use a file that lacks it, complete or not: a truncated write cuts
// off before the marker is appended far more often than a byte-complete
// write manages to finish every record but skip the marker, so truncation
// must not excuse the requirement, only the reverse would be a coincidence.
// truncated true means a record's declared size ran past the end of the
// file, or the file ended with leftover bytes too short to even hold a
// length prefix: either way, a record was cut off mid-write. When the
// marker was already written before that cutoff, whatever is truncated is
// later, incremental data appended after a genuinely valid initial
// snapshot, and the records recovered before the cutoff are still returned.
function readRecords(buf) {
  const records = [];
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'SNSS') {
    return { records, validMagic: false, truncated: false };
  }
  if (buf.readUInt32LE(4) !== SNSS_CURRENT_VERSION) {
    return { records, validMagic: false, truncated: false };
  }
  let off = 8;
  let truncated = false;
  while (off + 2 <= buf.length) {
    const size = buf.readUInt16LE(off);
    off += 2;
    if (size === 0 || off + size > buf.length) {
      truncated = true;
      break;
    }
    records.push([buf[off], buf.subarray(off + 1, off + size)]);
    off += size;
  }
  if (!truncated && off < buf.length) {
    truncated = true; // dangling bytes, too short for even a length prefix
  }
  if (!records.some(([cmd]) => cmd === CMD_INITIAL_STATE_MARKER)) {
    return { records, validMagic: false, truncated: false };
  }
  return { records, validMagic: true, truncated };
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
function applySessionRecord(cmd, payload, state) {
  if (cmd === CMD_SET_TAB_WINDOW && payload.length >= 8) {
    state.tabToWindow.set(payload.readInt32LE(4), payload.readInt32LE(0));
  } else if (cmd === CMD_TAB_CLOSED && payload.length >= 4) {
    state.closedTabs.add(payload.readInt32LE(0));
  } else if (cmd === CMD_WINDOW_CLOSED && payload.length >= 4) {
    state.closedWindows.add(payload.readInt32LE(0));
  } else if (cmd === CMD_SET_SELECTED_NAVIGATION_INDEX && payload.length >= 8) {
    state.selectedIndex.set(payload.readInt32LE(0), payload.readInt32LE(4));
  } else if (cmd === CMD_UPDATE_TAB_NAVIGATION && payload.length >= 16) {
    applyNavigation(payload, state.navByTab);
  }
}

function applyNavigation(payload, navByTab) {
  const entry = navigation(payload);
  if (!entry) return;
  if (!navByTab.has(entry.tab)) navByTab.set(entry.tab, new Map());
  navByTab.get(entry.tab).set(entry.index, { url: entry.url, title: entry.title });
}

function sessionTabsFromState({ tabToWindow, closedTabs, closedWindows, navByTab, selectedIndex }) {
  const entries = [...tabToWindow.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return entries.flatMap(([tab, window]) => {
    if (closedTabs.has(tab) || closedWindows.has(window)) return [];
    const byIndex = navByTab.get(tab);
    let entry = { url: '', title: '' };
    if (byIndex?.size) {
      const wanted = selectedIndex.get(tab);
      const index = byIndex.has(wanted) ? wanted : Math.max(...byIndex.keys());
      entry = byIndex.get(index);
    }
    return [{ tab_id: tab, window_id: window, url: entry.url, title: entry.title }];
  });
}

function parseSession(filePath) {
  const blob = fs.readFileSync(filePath);
  const { records, validMagic, truncated } = readRecords(blob);

  const state = {
    tabToWindow: new Map(), closedTabs: new Set(), closedWindows: new Set(),
    navByTab: new Map(), selectedIndex: new Map(),
  };
  for (const [cmd, payload] of records) applySessionRecord(cmd, payload, state);
  const tabs = sessionTabsFromState(state);
  return { tabs, validMagic, truncated };
}

// Tries session files newest first. A file this parser does not recognize,
// or a truncated one that recovered nothing, is skipped in favor of an
// older one rather than reported as "no tabs".
function resultForProfile(userDataDir, profile) {
  const files = sessionFilesNewestFirst(userDataDir, profile);
  const encrypted = hasEncryptedSessionData(userDataDir, profile);
  if (!files.length) return unreadableProfile(userDataDir, profile, encrypted);

  const selected = newestUsableSession(files);
  if (!selected) return unreadableProfile(userDataDir, profile, encrypted);
  return {
    user_data_dir: userDataDir,
    profile,
    session_file: path.basename(selected.file),
    tabs: selected.result.tabs,
    status: selected.result.truncated ? 'incomplete' : 'ok',
  };
}

function unreadableProfile(userDataDir, profile, encrypted) {
  return {
    user_data_dir: userDataDir,
    profile,
    session_file: null,
    tabs: [],
    status: encrypted ? 'encrypted' : 'unreadable',
  };
}

function newestUsableSession(files) {
  for (const file of files) {
    let result;
    try {
      result = parseSession(file);
    } catch {
      continue;
    }
    if (!result.validMagic || (result.truncated && result.tabs.length === 0)) continue;
    return { file, result };
  }
  return null;
}

function collect(profileFilter) {
  return userDataDirs().flatMap((userDataDir) => profileDirs(userDataDir)
    .filter((profile) => !profileFilter || profile === profileFilter)
    .map((profile) => resultForProfile(userDataDir, profile)));
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
    // u.host is empty for an ordinary local path and the machine name for a
    // UNC path (file://server/share/...); keep it either way.
    return `file://${u.host}${u.pathname}`;
  }
  if (u.protocol === 'about:') {
    return `about:${u.pathname}`;
  }
  if (HOST_SAFE_SCHEMES.has(u.protocol) && u.host) {
    return `${u.protocol}//${u.host}${u.pathname}`;
  }
  return u.protocol;
}

function renderNoTabs(unreadable, encrypted, groupCount) {
  const lines = [];
  if (unreadable.length + encrypted.length < groupCount) {
    lines.push('Chrome session files were found, but no profile has an open tab.');
  }
  if (unreadable.length) {
    lines.push(
      `${unreadable.length} profile(s) could not be read (${unreadable.map((g) => g.profile).join(', ')}): ` +
        'every session file for them was unrecognized or too damaged to parse. This can mean a Chrome ' +
        'version this parser has not seen, or a file caught mid-write; it is not the same as having no tabs.'
    );
  }
  if (encrypted.length) {
    lines.push(
      `${encrypted.length} profile(s) use Chrome's encrypted session storage (${encrypted.map((g) => g.profile).join(', ')}), ` +
        'which this tool cannot decrypt. This is a permanent limitation for those profiles, not a corrupt or missing file.'
    );
  }
  return lines.join('\n');
}

function renderProfile(group, { includeUrls, fullUrls }) {
  const windows = new Set(group.tabs.map((tab) => tab.window_id));
  const out = ['', `## profile ${group.profile} (${group.tabs.length} tabs, ${windows.size} window(s), ${group.session_file})`];
  if (group.status === 'incomplete') {
    out.push('note: this profile\'s session file was truncated or partly unreadable; the list below may be incomplete.');
  }
  const hosts = new Map();
  for (const tab of group.tabs) {
    const host = hostnameOf(tab.url);
    hosts.set(host, (hosts.get(host) || 0) + 1);
  }
  const top = [...hosts.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : Number(left[0] > right[0])))
    .slice(0, 15);
  out.push('hosts: ' + top.map(([host, count]) => `${host} (${count})`).join(', '));
  if (includeUrls) {
    for (const tab of group.tabs) {
      const label = (tab.title || '(no title)').slice(0, 70);
      const shown = (fullUrls ? tab.url : redactUrl(tab.url)).slice(0, 160);
      out.push(`  [w${tab.window_id}] ${label} :: ${shown}`);
    }
  }
  return out;
}

function renderWithTabs(withTabs, unreadable, encrypted, options) {
  const out = [];
  const total = withTabs.reduce((n, g) => n + g.tabs.length, 0);
  out.push(
    `${total} open tab(s) across ${withTabs.length} profile(s), read from disk.`,
    'This is a snapshot Chrome writes periodically, so it can lag by a little.'
  );
  if (unreadable.length) {
    out.push(
      `${unreadable.length} other profile(s) could not be read and are omitted: ` +
        unreadable.map((g) => g.profile).join(', ') +
        '.'
    );
  }
  if (encrypted.length) {
    out.push(
      `${encrypted.length} other profile(s) use Chrome's encrypted session storage and are omitted, ` +
        "not readable by this tool: " +
        encrypted.map((g) => g.profile).join(', ') +
        '.'
    );
  }
  for (const group of withTabs) out.push(...renderProfile(group, options));
  return out.join('\n');
}

function render(groups, { includeUrls = true, fullUrls = false } = {}) {
  if (!groups.length) {
    return (
      'No Chrome or Chromium session data found. Looked for ' +
      '<user data dir>/<profile>/{Sessions,Sessions_Encrypted}/Session_*.'
    );
  }

  const unreadable = groups.filter((g) => g.status === 'unreadable');
  const encrypted = groups.filter((g) => g.status === 'encrypted');
  const withTabs = groups.filter((g) => g.tabs.length);
  if (!withTabs.length) return renderNoTabs(unreadable, encrypted, groups.length);
  return renderWithTabs(withTabs, unreadable, encrypted, { includeUrls, fullUrls });
}
module.exports = {
  collect,
  parseSession,
  readRecords,
  render,
  redactUrl,
  aligned,
  userDataDirs,
  profileDirs,
  hasEncryptedSessionData,
  sessionFilesNewestFirst,
  SNSS_CURRENT_VERSION,
  CMD_INITIAL_STATE_MARKER,
  CLEARTEXT_SESSIONS_DIR,
  ENCRYPTED_SESSIONS_DIR,
};
