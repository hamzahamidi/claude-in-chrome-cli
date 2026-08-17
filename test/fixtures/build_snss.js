'use strict';
// Builds synthetic SNSS session files for tests, encoding the same command
// layout documented in tabs_mcp.js (chromium/components/sessions/core/
// session_service_commands.cc). These are constructed byte-for-byte from
// that documented format, not captured from a real Chrome profile: this
// environment has no Chrome install on macOS, Windows and Linux to capture
// from. They exercise the same commands and edge cases a real session file
// would contain.

const CMD_SET_TAB_WINDOW = 0;
const CMD_UPDATE_TAB_NAVIGATION = 6;
const CMD_SET_SELECTED_NAVIGATION_INDEX = 7;
const CMD_TAB_CLOSED = 16;
const CMD_WINDOW_CLOSED = 17;

function aligned(n) {
  return n + ((4 - (n % 4)) % 4);
}

function encodeRecord(cmd, payload) {
  const size = payload.length + 1;
  const buf = Buffer.alloc(2 + size);
  buf.writeUInt16LE(size, 0);
  buf[2] = cmd;
  payload.copy(buf, 3);
  return buf;
}

function setTabWindow(windowId, tabId) {
  const p = Buffer.alloc(8);
  p.writeInt32LE(windowId, 0);
  p.writeInt32LE(tabId, 4);
  return encodeRecord(CMD_SET_TAB_WINDOW, p);
}

function tabClosed(tabId) {
  const p = Buffer.alloc(4);
  p.writeInt32LE(tabId, 0);
  return encodeRecord(CMD_TAB_CLOSED, p);
}

function windowClosed(windowId) {
  const p = Buffer.alloc(4);
  p.writeInt32LE(windowId, 0);
  return encodeRecord(CMD_WINDOW_CLOSED, p);
}

function updateTabNavigation(tabId, navIndex, url, title) {
  const urlBuf = Buffer.from(url, 'utf8');
  const titleBuf = Buffer.from(title, 'utf16le');
  const urlAligned = aligned(urlBuf.length);
  const payload = Buffer.alloc(16 + urlAligned + 4 + titleBuf.length);
  payload.writeInt32LE(0, 0); // pickle size, unused by the parser
  payload.writeInt32LE(tabId, 4);
  payload.writeInt32LE(navIndex, 8);
  payload.writeInt32LE(urlBuf.length, 12);
  urlBuf.copy(payload, 16);
  payload.writeInt32LE(title.length, 16 + urlAligned);
  titleBuf.copy(payload, 16 + urlAligned + 4);
  return encodeRecord(CMD_UPDATE_TAB_NAVIGATION, payload);
}

// chromium's IDAndIndexPayload: tab id, then the navigation index the tab
// is now showing. Written on back/forward and on session restore; it is
// what a tab that has visited more than one url is actually displaying.
function setSelectedNavigationIndex(tabId, index) {
  const p = Buffer.alloc(8);
  p.writeInt32LE(tabId, 0);
  p.writeInt32LE(index, 4);
  return encodeRecord(CMD_SET_SELECTED_NAVIGATION_INDEX, p);
}

// A raw record for edge cases the helpers above cannot express, e.g. a
// truncated or otherwise malformed payload that the parser must ignore
// rather than throw on.
function rawRecord(cmd, payload) {
  return encodeRecord(cmd, payload);
}

function buildSession(records) {
  const header = Buffer.concat([Buffer.from('SNSS', 'latin1'), Buffer.from([1, 0, 0, 0])]);
  return Buffer.concat([header, ...records]);
}

module.exports = {
  setTabWindow,
  tabClosed,
  windowClosed,
  updateTabNavigation,
  setSelectedNavigationIndex,
  rawRecord,
  buildSession,
  aligned,
};
