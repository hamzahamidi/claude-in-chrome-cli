#!/usr/bin/env node
// Regression test for the SNSS parser and the render layer's default URL
// redaction, using synthetic fixtures built from the documented command
// format. Runs offline; needs no Chrome install. This is what stands in for
// parity with tabs_mcp.py now that the Python reference has been dropped.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  setTabWindow,
  tabClosed,
  windowClosed,
  updateTabNavigation,
  setSelectedNavigationIndex,
  rawRecord,
  buildSession,
} = require('./fixtures/build_snss.js');
const {
  parseSession,
  readRecords,
  render,
  redactUrl,
  userDataDirs,
  sessionFilesNewestFirst,
  profileDirs,
  hasEncryptedSessionData,
  ENCRYPTED_SESSIONS_DIR,
} = require('../tabs_mcp.js');

let fails = 0;

function check(label, fn) {
  try {
    fn();
    console.log('PASS  ' + label);
  } catch (err) {
    fails += 1;
    console.log('FAIL  ' + label + '  ' + err.message);
  }
}

function withSessionFile(records, fn) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snss-')), 'Session_1');
  fs.writeFileSync(file, buildSession(records));
  try {
    return fn(file);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

function tabsOf(records) {
  return withSessionFile(records, (file) => parseSession(file).tabs);
}

check('parses a tab with a url and title', () => {
  const tabs = tabsOf([setTabWindow(1, 101), updateTabNavigation(101, 0, 'https://example.com/a', 'Example A')]);
  assert.deepStrictEqual(tabs, [{ tab_id: 101, window_id: 1, url: 'https://example.com/a', title: 'Example A' }]);
});

check('orders tabs by window then tab id', () => {
  const ids = tabsOf([
    setTabWindow(2, 201),
    updateTabNavigation(201, 0, 'https://b.example/', 'B'),
    setTabWindow(1, 102),
    updateTabNavigation(102, 0, 'https://a2.example/', 'A2'),
    setTabWindow(1, 101),
    updateTabNavigation(101, 0, 'https://a1.example/', 'A1'),
  ]).map((t) => [t.window_id, t.tab_id]);
  assert.deepStrictEqual(ids, [
    [1, 101],
    [1, 102],
    [2, 201],
  ]);
});

check('a closed tab is excluded', () => {
  const tabs = tabsOf([
    setTabWindow(1, 101),
    updateTabNavigation(101, 0, 'https://kept.example/', 'Kept'),
    setTabWindow(1, 102),
    updateTabNavigation(102, 0, 'https://closed.example/', 'Closed'),
    tabClosed(102),
  ]);
  assert.deepStrictEqual(tabs.map((t) => t.tab_id), [101]);
});

check('a closed window excludes every one of its tabs', () => {
  const tabs = tabsOf([
    setTabWindow(1, 101),
    updateTabNavigation(101, 0, 'https://kept.example/', 'Kept'),
    setTabWindow(2, 201),
    updateTabNavigation(201, 0, 'https://gone.example/', 'Gone'),
    windowClosed(2),
  ]);
  assert.deepStrictEqual(tabs.map((t) => t.tab_id), [101]);
});

check('a navigation record for an unregistered tab produces no tab', () => {
  assert.deepStrictEqual(tabsOf([updateTabNavigation(999, 0, 'https://orphan.example/', 'Orphan')]), []);
});

check('a tab with no navigation record falls back to empty url and title', () => {
  assert.deepStrictEqual(tabsOf([setTabWindow(1, 101)]), [{ tab_id: 101, window_id: 1, url: '', title: '' }]);
});

check('a non-BMP-free unicode title round-trips', () => {
  const tabs = tabsOf([setTabWindow(1, 101), updateTabNavigation(101, 0, 'https://example.com/', 'Café ünïcode 日本語')]);
  assert.strictEqual(tabs[0].title, 'Café ünïcode 日本語');
});

check('a credentialed url with a query and fragment round-trips through parseSession', () => {
  const tabs = tabsOf([setTabWindow(1, 101), updateTabNavigation(101, 0, 'https://user:pass@example.com/a?x=1#frag', 'T')]);
  assert.strictEqual(tabs[0].url, 'https://user:pass@example.com/a?x=1#frag');
});

check('a truncated navigation payload is skipped, not thrown', () => {
  const tabs = tabsOf([setTabWindow(1, 101), rawRecord(6, Buffer.alloc(10))]); // shorter than the 16-byte minimum
  assert.deepStrictEqual(tabs, [{ tab_id: 101, window_id: 1, url: '', title: '' }]);
});

check('a url_len larger than the payload is rejected', () => {
  const bad = Buffer.alloc(20);
  bad.writeInt32LE(101, 4);
  bad.writeInt32LE(9999, 12); // claims 9999 bytes of url in a 20-byte payload
  assert.deepStrictEqual(tabsOf([setTabWindow(1, 101), rawRecord(6, bad)]), [
    { tab_id: 101, window_id: 1, url: '', title: '' },
  ]);
});

check('a tab with two navigations shows the selected one, not the last written', () => {
  // A -> B, then the user goes back to A: B is written after A, but index 0
  // (A) is what SetSelectedNavigationIndex says the tab is showing.
  const tabs = tabsOf([
    setTabWindow(1, 101),
    updateTabNavigation(101, 0, 'https://a.example/', 'A'),
    updateTabNavigation(101, 1, 'https://b.example/', 'B'),
    setSelectedNavigationIndex(101, 0),
  ]);
  assert.deepStrictEqual(tabs, [{ tab_id: 101, window_id: 1, url: 'https://a.example/', title: 'A' }]);
});

check('a tab with no selection command falls back to the highest navigation index', () => {
  const tabs = tabsOf([
    setTabWindow(1, 101),
    updateTabNavigation(101, 0, 'https://a.example/', 'A'),
    updateTabNavigation(101, 1, 'https://b.example/', 'B'),
  ]);
  assert.deepStrictEqual(tabs, [{ tab_id: 101, window_id: 1, url: 'https://b.example/', title: 'B' }]);
});

check('a selection command pointing at a missing index falls back to the highest index', () => {
  const tabs = tabsOf([
    setTabWindow(1, 101),
    updateTabNavigation(101, 0, 'https://a.example/', 'A'),
    updateTabNavigation(101, 1, 'https://b.example/', 'B'),
    setSelectedNavigationIndex(101, 5), // index 5 was never written
  ]);
  assert.deepStrictEqual(tabs, [{ tab_id: 101, window_id: 1, url: 'https://b.example/', title: 'B' }]);
});

check('a record whose declared size overruns the file is reported as truncated, not thrown', () => {
  withSessionFile([setTabWindow(1, 101), updateTabNavigation(101, 0, 'https://kept.example/', 'Kept')], (file) => {
    fs.writeFileSync(file, fs.readFileSync(file).subarray(0, -1));
    let result;
    assert.doesNotThrow(() => {
      result = parseSession(file);
    });
    assert.strictEqual(result.validMagic, true);
    assert.strictEqual(result.truncated, true);
  });
});

check('a clean file with zero records is a valid empty session, not truncated', () => {
  withSessionFile([], (file) => {
    const result = parseSession(file);
    assert.strictEqual(result.validMagic, true);
    assert.strictEqual(result.truncated, false);
    assert.deepStrictEqual(result.tabs, []);
  });
});

check('non-SNSS magic bytes are reported as an unrecognized format, not truncated', () => {
  withSessionFile([], (file) => {
    fs.writeFileSync(file, Buffer.from('NOPE' + '\0'.repeat(8)));
    const result = parseSession(file);
    assert.strictEqual(result.validMagic, false);
    assert.strictEqual(result.truncated, false);
    assert.deepStrictEqual(result.tabs, []);
  });
});

check('an obsolete version number is unreadable, not silently trusted', () => {
  withSessionFile([], (file) => {
    fs.writeFileSync(file, buildSession([], 1)); // version 1 predates the current format
    const result = parseSession(file);
    assert.strictEqual(result.validMagic, false);
  });
});

check('the encrypted version (5) is unreadable, not silently trusted', () => {
  withSessionFile([], (file) => {
    fs.writeFileSync(file, buildSession([], 5));
    const result = parseSession(file);
    assert.strictEqual(result.validMagic, false);
  });
});

check('an unrecognized version number fails closed rather than being guessed at', () => {
  withSessionFile([], (file) => {
    fs.writeFileSync(file, buildSession([], 99));
    const result = parseSession(file);
    assert.strictEqual(result.validMagic, false);
  });
});

check('a file cut off between records (no room for even a length prefix) is truncated, not clean', () => {
  const buf = readRecords(Buffer.concat([Buffer.from('SNSS', 'latin1'), Buffer.from([3, 0, 0, 0]), Buffer.from([0xab])]));
  assert.strictEqual(buf.validMagic, true);
  assert.strictEqual(buf.truncated, true);
});

check('a file that ends exactly on a record boundary is clean, not truncated', () => {
  withSessionFile([setTabWindow(1, 101)], (file) => {
    const result = parseSession(file);
    assert.strictEqual(result.truncated, false);
  });
});

check('a byte-complete file is valid when it carries the completion marker (the default)', () => {
  withSessionFile([setTabWindow(1, 101), updateTabNavigation(101, 0, 'https://example.com/', 'T')], (file) => {
    const result = parseSession(file);
    assert.strictEqual(result.validMagic, true);
  });
});

check('a byte-complete file without the completion marker is not trusted', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snss-')), 'Session_1');
  fs.writeFileSync(
    file,
    buildSession([setTabWindow(1, 101), updateTabNavigation(101, 0, 'https://example.com/', 'T')], 3, false)
  );
  try {
    const result = parseSession(file);
    assert.strictEqual(result.validMagic, false);
    assert.strictEqual(result.truncated, false);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

check('render redacts credentials, query and fragment by default', () => {
  const groups = [
    {
      profile: 'Default',
      session_file: 'Session_1',
      status: 'ok',
      tabs: [{ tab_id: 101, window_id: 1, url: 'https://user:pass@example.com/a?x=1#frag', title: 'T' }],
    },
  ];
  const text = render(groups);
  assert.ok(text.includes('https://example.com/a'), text);
  assert.ok(!text.includes('user:pass'), text);
  assert.ok(!text.includes('x=1'), text);
  assert.ok(!text.includes('frag'), text);
});

check('render returns the raw url when full_urls is set', () => {
  const groups = [
    {
      profile: 'Default',
      session_file: 'Session_1',
      status: 'ok',
      tabs: [{ tab_id: 101, window_id: 1, url: 'https://user:pass@example.com/a?x=1#frag', title: 'T' }],
    },
  ];
  const text = render(groups, { fullUrls: true });
  assert.ok(text.includes('https://user:pass@example.com/a?x=1#frag'), text);
});

check('render with include_urls false omits the per-tab lines', () => {
  const groups = [
    {
      profile: 'Default',
      session_file: 'Session_1',
      status: 'ok',
      tabs: [{ tab_id: 101, window_id: 1, url: 'https://example.com/a', title: 'T' }],
    },
  ];
  const text = render(groups, { includeUrls: false });
  assert.ok(!text.includes('[w1]'), text);
  assert.ok(text.includes('hosts: example.com (1)'), text);
});

check('render distinguishes an unreadable profile from an empty one', () => {
  const text = render([{ profile: 'Default', session_file: null, status: 'unreadable', tabs: [] }]);
  assert.ok(text.includes('could not be read'), text);
  assert.ok(!text.includes('no profile has an open tab'), text);
});

check('render flags an incomplete profile inline while still showing its recovered tabs', () => {
  const groups = [
    {
      profile: 'Default',
      session_file: 'Session_1',
      status: 'incomplete',
      tabs: [{ tab_id: 101, window_id: 1, url: 'https://example.com/a', title: 'T' }],
    },
  ];
  const text = render(groups);
  assert.ok(text.includes('example.com/a'), text);
  assert.ok(/truncated|partly unreadable/.test(text), text);
});

check('redactUrl keeps origin and path for http(s)', () => {
  assert.strictEqual(redactUrl('https://user:pass@example.com/a?x=1#frag'), 'https://example.com/a');
});

check('redactUrl handles a chrome: internal page', () => {
  assert.strictEqual(redactUrl('chrome://settings/privacy'), 'chrome://settings/privacy');
});

check('redactUrl handles about:blank without corrupting it', () => {
  assert.strictEqual(redactUrl('about:blank'), 'about:blank');
});

check('redactUrl keeps a file:// path intact', () => {
  assert.strictEqual(redactUrl('file:///tmp/report.html'), 'file:///tmp/report.html');
});

check('redactUrl keeps the host of a UNC file:// path', () => {
  assert.strictEqual(redactUrl('file://server/share/report.html?x=1#f'), 'file://server/share/report.html');
});

check('redactUrl handles a chrome-extension: page', () => {
  assert.strictEqual(redactUrl('chrome-extension://abcdefghijklmnop/index.html'), 'chrome-extension://abcdefghijklmnop/index.html');
});

check('redactUrl strips the payload of a data: url but keeps the media type', () => {
  const shown = redactUrl('data:text/plain;base64,SGVsbG8gc2VjcmV0IQ==');
  assert.strictEqual(shown, 'data:text/plain;base64,[redacted]');
  assert.ok(!shown.includes('SGVsbG8'), shown);
});

check('redactUrl shows only the scheme for blob:, which wraps a full url with credentials', () => {
  const shown = redactUrl('blob:https://user:pass@example.com/id?x=1');
  assert.strictEqual(shown, 'blob:');
  assert.ok(!shown.includes('user:pass'), shown);
  assert.ok(!shown.includes('example.com'), shown);
});

check('redactUrl shows only the scheme for filesystem:, same wrapper problem as blob:', () => {
  const shown = redactUrl('filesystem:https://user:pass@example.com/temporary/x?y=1');
  assert.strictEqual(shown, 'filesystem:');
});

check('redactUrl shows only the scheme for view-source:, same wrapper problem as blob:', () => {
  const shown = redactUrl('view-source:https://user:pass@example.com/a?b=1');
  assert.strictEqual(shown, 'view-source:');
});

check('redactUrl falls back to (unparseable) on an invalid url', () => {
  assert.strictEqual(redactUrl('not a url'), '(unparseable)');
});

check('render reports no session file found for an empty group list', () => {
  assert.ok(render([]).includes('No Chrome session file found'));
});

check('render reports no open tabs when every group is empty but readable', () => {
  assert.ok(render([{ profile: 'Default', session_file: 'Session_1', status: 'ok', tabs: [] }]).includes('no profile has an open tab'));
});

check('userDataDirs finds Chrome and Chromium on Windows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win32-'));
  fs.mkdirSync(path.join(root, 'Google', 'Chrome', 'User Data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Chromium', 'User Data'), { recursive: true });
  try {
    const dirs = userDataDirs('win32', { LOCALAPPDATA: root }, root);
    assert.deepStrictEqual(
      dirs.sort(),
      [path.join(root, 'Chromium', 'User Data'), path.join(root, 'Google', 'Chrome', 'User Data')].sort()
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('userDataDirs on Windows falls back to home when LOCALAPPDATA is unset', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win32-nolocal-'));
  const expected = path.join(root, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  fs.mkdirSync(expected, { recursive: true });
  try {
    const dirs = userDataDirs('win32', {}, root);
    assert.deepStrictEqual(dirs, [expected]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('userDataDirs finds Chrome and Chromium on Linux', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-'));
  fs.mkdirSync(path.join(root, '.config', 'google-chrome'), { recursive: true });
  fs.mkdirSync(path.join(root, '.config', 'chromium'), { recursive: true });
  try {
    const dirs = userDataDirs('linux', {}, root);
    assert.deepStrictEqual(
      dirs.sort(),
      [path.join(root, '.config', 'chromium'), path.join(root, '.config', 'google-chrome')].sort()
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('userDataDirs finds Chrome and Chromium on macOS', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-'));
  fs.mkdirSync(path.join(root, 'Library', 'Application Support', 'Google', 'Chrome'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Library', 'Application Support', 'Chromium'), { recursive: true });
  try {
    const dirs = userDataDirs('darwin', {}, root);
    assert.strictEqual(dirs.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('userDataDirs returns nothing for a platform with no installed browser', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
  try {
    assert.deepStrictEqual(userDataDirs('linux', {}, root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('sessionFilesNewestFirst survives a file disappearing between listing and stat', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'race-'));
  const dir = path.join(root, 'Default', 'Sessions');
  fs.mkdirSync(dir, { recursive: true });
  const kept = path.join(dir, 'Session_kept');
  const vanished = path.join(dir, 'Session_vanished');
  fs.writeFileSync(kept, 'x');
  fs.writeFileSync(vanished, 'x');
  const realStatSync = fs.statSync;
  fs.statSync = (p, ...rest) => {
    if (p === vanished) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return realStatSync(p, ...rest);
  };
  try {
    assert.doesNotThrow(() => {
      const files = sessionFilesNewestFirst(root, 'Default');
      assert.deepStrictEqual(files, [kept]);
    });
  } finally {
    fs.statSync = realStatSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('profileDirs recognizes a profile that only has encrypted session storage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'encrypted-only-'));
  fs.mkdirSync(path.join(root, 'Default', ENCRYPTED_SESSIONS_DIR), { recursive: true });
  try {
    assert.deepStrictEqual(profileDirs(root), ['Default']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('hasEncryptedSessionData is true only when a Session_* file is actually present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'encrypted-check-'));
  const dir = path.join(root, 'Default', ENCRYPTED_SESSIONS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  try {
    assert.strictEqual(hasEncryptedSessionData(root, 'Default'), false);
    fs.writeFileSync(path.join(dir, 'Session_1'), 'opaque');
    assert.strictEqual(hasEncryptedSessionData(root, 'Default'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('render reports an encrypted-only profile distinctly from unreadable or empty', () => {
  const text = render([{ profile: 'Default', session_file: null, status: 'encrypted', tabs: [] }]);
  assert.ok(text.includes('encrypted session storage'), text);
  assert.ok(!text.includes('could not be read'), text);
  assert.ok(!text.includes('no profile has an open tab'), text);
});

check('render omits an encrypted profile from the tab count when other profiles have tabs', () => {
  const groups = [
    { profile: 'Default', session_file: 'Session_1', status: 'ok', tabs: [{ tab_id: 1, window_id: 1, url: 'https://example.com/', title: 'T' }] },
    { profile: 'Profile 1', session_file: null, status: 'encrypted', tabs: [] },
  ];
  const text = render(groups);
  assert.ok(text.includes('1 open tab(s) across 1 profile(s)'), text);
  assert.ok(text.includes("encrypted session storage"), text);
  assert.ok(text.includes('Profile 1'), text);
});

if (fails) {
  console.log(`${fails} check(s) failed.`);
  process.exit(1);
}
console.log('All checks passed.');
