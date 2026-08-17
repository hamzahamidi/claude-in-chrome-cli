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

const { setTabWindow, tabClosed, windowClosed, updateTabNavigation, rawRecord, buildSession } =
  require('./fixtures/build_snss.js');
const { parseSession, render, redactUrl } = require('../tabs_mcp.js');

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

check('parses a tab with a url and title', () => {
  withSessionFile(
    [setTabWindow(1, 101), updateTabNavigation(101, 0, 'https://example.com/a', 'Example A')],
    (file) => {
      const tabs = parseSession(file);
      assert.deepStrictEqual(tabs, [{ tab_id: 101, window_id: 1, url: 'https://example.com/a', title: 'Example A' }]);
    }
  );
});

check('orders tabs by window then tab id', () => {
  withSessionFile(
    [
      setTabWindow(2, 201),
      updateTabNavigation(201, 0, 'https://b.example/', 'B'),
      setTabWindow(1, 102),
      updateTabNavigation(102, 0, 'https://a2.example/', 'A2'),
      setTabWindow(1, 101),
      updateTabNavigation(101, 0, 'https://a1.example/', 'A1'),
    ],
    (file) => {
      const ids = parseSession(file).map((t) => [t.window_id, t.tab_id]);
      assert.deepStrictEqual(ids, [
        [1, 101],
        [1, 102],
        [2, 201],
      ]);
    }
  );
});

check('a closed tab is excluded', () => {
  withSessionFile(
    [
      setTabWindow(1, 101),
      updateTabNavigation(101, 0, 'https://kept.example/', 'Kept'),
      setTabWindow(1, 102),
      updateTabNavigation(102, 0, 'https://closed.example/', 'Closed'),
      tabClosed(102),
    ],
    (file) => {
      const tabs = parseSession(file);
      assert.deepStrictEqual(tabs.map((t) => t.tab_id), [101]);
    }
  );
});

check('a closed window excludes every one of its tabs', () => {
  withSessionFile(
    [
      setTabWindow(1, 101),
      updateTabNavigation(101, 0, 'https://kept.example/', 'Kept'),
      setTabWindow(2, 201),
      updateTabNavigation(201, 0, 'https://gone.example/', 'Gone'),
      windowClosed(2),
    ],
    (file) => {
      const tabs = parseSession(file);
      assert.deepStrictEqual(tabs.map((t) => t.tab_id), [101]);
    }
  );
});

check('a navigation record for an unregistered tab produces no tab', () => {
  withSessionFile([updateTabNavigation(999, 0, 'https://orphan.example/', 'Orphan')], (file) => {
    assert.deepStrictEqual(parseSession(file), []);
  });
});

check('a tab with no navigation record falls back to empty url and title', () => {
  withSessionFile([setTabWindow(1, 101)], (file) => {
    assert.deepStrictEqual(parseSession(file), [{ tab_id: 101, window_id: 1, url: '', title: '' }]);
  });
});

check('a non-BMP-free unicode title round-trips', () => {
  withSessionFile(
    [setTabWindow(1, 101), updateTabNavigation(101, 0, 'https://example.com/', 'Café ünïcode 日本語')],
    (file) => {
      assert.strictEqual(parseSession(file)[0].title, 'Café ünïcode 日本語');
    }
  );
});

check('a credentialed url with a query and fragment round-trips through parseSession', () => {
  withSessionFile(
    [setTabWindow(1, 101), updateTabNavigation(101, 0, 'https://user:pass@example.com/a?x=1#frag', 'T')],
    (file) => {
      assert.strictEqual(parseSession(file)[0].url, 'https://user:pass@example.com/a?x=1#frag');
    }
  );
});

check('a truncated navigation payload is skipped, not thrown', () => {
  withSessionFile(
    [
      setTabWindow(1, 101),
      rawRecord(6, Buffer.alloc(10)), // shorter than the 16-byte minimum
    ],
    (file) => {
      assert.deepStrictEqual(parseSession(file), [{ tab_id: 101, window_id: 1, url: '', title: '' }]);
    }
  );
});

check('a url_len larger than the payload is rejected', () => {
  const bad = Buffer.alloc(20);
  bad.writeInt32LE(101, 4);
  bad.writeInt32LE(9999, 12); // claims 9999 bytes of url in a 20-byte payload
  withSessionFile([setTabWindow(1, 101), rawRecord(6, bad)], (file) => {
    assert.deepStrictEqual(parseSession(file), [{ tab_id: 101, window_id: 1, url: '', title: '' }]);
  });
});

check('a record whose declared size overruns the file stops parsing, not throws', () => {
  withSessionFile(
    [
      setTabWindow(1, 101),
      updateTabNavigation(101, 0, 'https://kept.example/', 'Kept'),
    ],
    (file) => {
      const truncated = fs.readFileSync(file).subarray(0, -1);
      fs.writeFileSync(file, truncated);
      // The last record's declared size now exceeds what remains; parseSession
      // must not throw, even though the malformed tail record is dropped.
      assert.doesNotThrow(() => parseSession(file));
    }
  );
});

check('non-SNSS magic bytes yield no tabs', () => {
  withSessionFile([], (file) => {
    fs.writeFileSync(file, Buffer.from('NOPE' + '\0'.repeat(8)));
    assert.deepStrictEqual(parseSession(file), []);
  });
});

check('render redacts credentials, query and fragment by default', () => {
  const groups = [
    {
      profile: 'Default',
      session_file: 'Session_1',
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
      tabs: [{ tab_id: 101, window_id: 1, url: 'https://example.com/a', title: 'T' }],
    },
  ];
  const text = render(groups, { includeUrls: false });
  assert.ok(!text.includes('[w1]'), text);
  assert.ok(text.includes('hosts: example.com (1)'), text);
});

check('redactUrl falls back to (unparseable) on an invalid url', () => {
  assert.strictEqual(redactUrl('not a url'), '(unparseable)');
});

check('render reports no session file found for an empty group list', () => {
  assert.ok(render([]).includes('No Chrome session file found'));
});

check('render reports no open tabs when every group is empty', () => {
  assert.ok(render([{ profile: 'Default', session_file: 'Session_1', tabs: [] }]).includes('no profile has an open tab'));
});

if (fails) {
  console.log(`${fails} check(s) failed.`);
  process.exit(1);
}
console.log('All checks passed.');
