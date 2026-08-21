#!/usr/bin/env node
// The adoption state machine, driven offline against a scripted bridge.
//
// Every case here is about how the group changes across polls, which is why the
// stub takes a script rather than a single canned reply. Three of these exist
// because a live bridge disproved an assumption before any of this was written:
// a blank tab satisfies the detector, the anchor owns the group, and an anchor
// that vanishes is recoverable rather than fatal.
'use strict';

const path = require('path');

const { BridgeSession } = require('../plugins/claude-in-chrome/lib/bridge-session.js');
const { adoptTab, AdoptionError, looksInternal } = require('../plugins/claude-in-chrome/lib/tab-adoption.js');

const STUB = path.join(__dirname, 'stub_server.js');

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) { failures++; }
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}

const REAL = (id, title = 'A page') => ({ tabId: id, title, url: `https://example.com/${id}` });
const BLANK = (id) => ({ tabId: id, title: 'New tab', url: 'chrome://newtab/' });

/**
 * Runs adoption against a scripted group. `script` is one entry per
 * tabs_context_mcp call; the last entry repeats.
 */
async function run(script, { undrivable = [], timeoutSeconds = 4, cancelAfter = null } = {}) {
  process.env.CIC_STUB_MODE = 'adopt';
  process.env.CIC_STUB_ADOPT = JSON.stringify(script);
  process.env.CIC_STUB_ADOPT_UNDRIVABLE = JSON.stringify(undrivable);
  const session = new BridgeSession({
    binary: process.execPath, binaryArguments: [STUB], timeoutSeconds: 5,
  });
  await session.open();
  const events = [];
  let polls = 0;
  try {
    const result = await adoptTab(session, {
      timeoutSeconds,
      pollMs: 20,
      notify: (event) => events.push(event),
      cancelled: () => {
        polls++;
        return cancelAfter !== null && polls > cancelAfter;
      },
    });
    return { result, events, kinds: events.map((e) => e.kind) };
  } finally {
    await session.close();
  }
}

async function main() {
  // ---- the happy path -----------------------------------------------------
  {
    // Anchor alone, then the user's tab turns up and stays.
    const { result, kinds } = await run([
      [], [BLANK(901)], [BLANK(901)], [BLANK(901), REAL(500)], [BLANK(901), REAL(500)],
    ]);
    check('a tab moved in is adopted', result.outcome, 'adopted');
    check('and it is the new tab, not the anchor', result.tab.tabId, 500);
    check('the anchor is reported', result.anchor, 901);
    check('and it is marked as one this created', result.anchorCreated, true);
    check('the caller is told a group had to be opened', kinds.includes('anchor-created'), true);
    check('and told when waiting starts', kinds.includes('waiting'), true);
    check('and told what was adopted', kinds.includes('adopted'), true);
  }

  // One reading is not enough: a set difference can be caught mid-move, so a
  // candidate seen once and gone again must never be adopted.
  {
    const { result } = await run([
      [], [BLANK(901)], [BLANK(901), REAL(500)], [BLANK(901)], [BLANK(901), REAL(600)], [BLANK(901), REAL(600)],
    ]);
    check('a candidate that flickers away is not adopted', result.tab.tabId, 600);
  }

  // ---- a group that already has tabs is not disturbed ---------------------
  {
    const { result, kinds } = await run([
      [REAL(700)], [REAL(700)], [REAL(700), REAL(800)], [REAL(700), REAL(800)],
    ]);
    check('an existing group is used as it stands', result.anchorCreated, false);
    check('nothing is created for it', kinds.includes('anchor-created'), false);
    check('the caller is told it already existed', kinds.includes('group-exists'), true);
    check('and the tab moved in is still the one adopted', result.tab.tabId, 800);
  }

  // ---- detection is not adoption ------------------------------------------

  // The false positive a live bridge produced: a blank tab appears, is a
  // perfectly stable singleton addition, and is not an adoption at all.
  {
    const { result, kinds } = await run([
      [], [BLANK(901)], [BLANK(901), BLANK(902)], [BLANK(901), BLANK(902)],
      [BLANK(901), BLANK(902), REAL(500)],
    ], { timeoutSeconds: 2 });
    check('a blank tab is never adopted', result.outcome, 'timeout');
    check('and the caller is told why it is being skipped', kinds.includes('internal-tab'), true);
  }

  // The scheme filter is a nicety; capability is the proof. A candidate that
  // looks ordinary but cannot be driven is not adopted either.
  {
    const { result, kinds } = await run(
      [[], [BLANK(901)], [BLANK(901), REAL(500)], [BLANK(901), REAL(500)]],
      { undrivable: [500], timeoutSeconds: 2 });
    check('a tab that cannot be driven is not adopted', result.outcome, 'timeout');
    check('and the caller is told it could not be driven', kinds.includes('not-drivable'), true);
  }

  // And once it becomes drivable, it is adopted, since a page can be mid-load.
  {
    const { result } = await run(
      [[], [BLANK(901)], [BLANK(901), REAL(500)], [BLANK(901), REAL(500)]],
      { undrivable: [], timeoutSeconds: 4 });
    check('a drivable tab is adopted', result.tab.tabId, 500);
  }

  // ---- more than one addition is recoverable, not fatal -------------------
  {
    const { result, events } = await run([
      [], [BLANK(901)],
      [BLANK(901), REAL(500), REAL(600)], [BLANK(901), REAL(500), REAL(600)],
      [BLANK(901), REAL(600)], [BLANK(901), REAL(600)],
    ]);
    const tooMany = events.filter((e) => e.kind === 'too-many');
    check('two additions are reported', tooMany.length > 0, true);
    check('with the count, so the message can be specific', tooMany[0] && tooMany[0].count, 2);
    check('and adoption still completes once one remains', result.outcome, 'adopted');
    check('adopting the one that was left', result.tab.tabId, 600);
    check('and it is announced only once while unchanged', tooMany.length, 1);
  }

  // ---- an anchor that disappears is replaced, not fatal -------------------
  //
  // The first probe against a live bridge aborted here, which was too strict:
  // the baseline is a set of ids and a closed id cannot come back as an
  // addition, so the difference stays correct.
  {
    const { result, kinds } = await run([
      [], [BLANK(901)], [], [BLANK(901), REAL(500)], [BLANK(901), REAL(500)],
    ]);
    check('an emptied group is reopened rather than abandoned', kinds.includes('anchor-replaced'), true);
    check('and adoption still completes', result.outcome, 'adopted');
    check('with the moved tab, not the replacement anchor', result.tab.tabId, 500);
  }

  // ---- nothing happens ----------------------------------------------------
  {
    const { result } = await run([[], [BLANK(901)]], { timeoutSeconds: 1 });
    check('an empty window times out rather than choosing', result.outcome, 'timeout');
    check('and still reports its anchor, which the caller has to clean up', result.anchor, 901);
  }

  // ---- cancellation -------------------------------------------------------
  //
  // Cancelling is checked between polls rather than interrupting one in flight,
  // so it never creates an outcome nobody can classify.
  {
    const { result } = await run([[], [BLANK(901)]], { timeoutSeconds: 5, cancelAfter: 2 });
    check('cancelling ends adoption', result.outcome, 'cancelled');
    check('and reports the anchor it opened', result.anchor, 901);
  }

  // ---- no group can be opened at all --------------------------------------
  {
    process.env.CIC_STUB_MODE = 'is-error';
    const session = new BridgeSession({
      binary: process.execPath, binaryArguments: [STUB], timeoutSeconds: 3,
    });
    await session.open();
    let error = null;
    try { await adoptTab(session, { timeoutSeconds: 1, pollMs: 20 }); }
    catch (failure) { error = failure; }
    check('a bridge that will not open a group raises AdoptionError',
      error instanceof AdoptionError, true);
    check('with a kind the caller can branch on', error && error.kind, 'no-group');
    await session.close();
  }

  // A group that empties and then cannot be reopened is the one genuinely
  // unrecoverable shape: there is nowhere left to move a tab into.
  {
    process.env.CIC_STUB_MODE = 'adopt';
    process.env.CIC_STUB_ADOPT = JSON.stringify([[REAL(700)], []]);
    process.env.CIC_STUB_ADOPT_UNDRIVABLE = '[]';
    // createIfEmpty is answered from the script's last entry, which stays empty,
    // so the reopen genuinely fails rather than being faked into working.
    process.env.CIC_STUB_ADOPT_NO_CREATE = '1';
    const session = new BridgeSession({
      binary: process.execPath, binaryArguments: [STUB], timeoutSeconds: 5,
    });
    await session.open();
    let error = null;
    try { await adoptTab(session, { timeoutSeconds: 3, pollMs: 20 }); }
    catch (failure) { error = failure; }
    check('a group that cannot be reopened raises AdoptionError', error instanceof AdoptionError, true);
    check('and says the group went away',
      error && /went away and could not be reopened/.test(error.message), true);
    await session.close();
    delete process.env.CIC_STUB_ADOPT_NO_CREATE;
  }

  // The defaults have to work, because a caller that passes neither notify nor
  // cancelled is the ordinary case and must not crash on an absent callback.
  {
    process.env.CIC_STUB_MODE = 'adopt';
    process.env.CIC_STUB_ADOPT = JSON.stringify([[], [BLANK(901)]]);
    process.env.CIC_STUB_ADOPT_UNDRIVABLE = '[]';
    const session = new BridgeSession({
      binary: process.execPath, binaryArguments: [STUB], timeoutSeconds: 5,
    });
    await session.open();
    const result = await adoptTab(session, { timeoutSeconds: 1, pollMs: 20 });
    check('adoption runs with no notify and no cancelled given', result.outcome, 'timeout');
    await session.close();
  }

  // ---- the scheme filter itself -------------------------------------------
  check('chrome:// is internal', looksInternal({ url: 'chrome://newtab/' }), true);
  check('about: is internal', looksInternal({ url: 'about:blank' }), true);
  check('view-source: is internal', looksInternal({ url: 'view-source:https://example.com' }), true);
  check('an extension page is internal', looksInternal({ url: 'chrome-extension://abc/page.html' }), true);
  check('https is not', looksInternal({ url: 'https://example.com/' }), false);
  check('a tab with no url is not assumed internal', looksInternal({}), false);

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((failure) => {
  console.log('FAIL  the suite itself threw:', failure && failure.stack);
  process.exit(1);
});
