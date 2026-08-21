#!/usr/bin/env node
// Tests lib/tab-lifecycle.js against the stub.
//
// The cleanup rule is the contract, and most of it cannot be observed from
// outside the process: whether the close actually happened is only visible in
// what the stub was asked for. That is what the capture file is read for here.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { BridgeSession, BridgeError } = require('../plugins/claude-in-chrome/lib/bridge-session.js');
const { withTab, TabLifecycleError } = require('../plugins/claude-in-chrome/lib/tab-lifecycle.js');

const STUB = path.join(__dirname, 'stub_server.js');

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) { failures++; }
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}

function session(mode, { timeoutSeconds = 2, env = {} } = {}) {
  process.env.CIC_STUB_MODE = mode;
  Object.assign(process.env, env);
  return new BridgeSession({ binary: process.execPath, binaryArguments: [STUB], timeoutSeconds });
}

/** Which tools were actually called, in order, as recorded by the stub. */
const toolsCalledIn = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((message) => message.method === 'tools/call')
  .map((message) => message.params.name);

let captureCount = 0;
const nextCapture = () => path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), `cic-cap-${captureCount++}-`)), 'calls.jsonl');

const body = (s) => (tabId) => s.call('tools/call', { name: 'get_page_text', arguments: { tabId } });

async function main() {
  // ---- the happy path -----------------------------------------------------
  {
    const capture = nextCapture();
    const s = session('tabs-ok', { env: { CIC_STUB_CAPTURE: capture } });
    await s.open();
    const held = await withTab(s, { url: 'https://example.com' }, body(s));
    check('withTab reports the tab it made', held.tabId, 4242);
    check('and hands that id to the body', held.outcome.result.content[0].text, 'body ran against tab 4242');
    // Two reads at the front and one before the close, all load-bearing: the
    // first learns whether a group exists (tabs_create_mcp refuses without one),
    // the second opens it, and the last is the cleanup guard looking before it
    // closes a group's first tab.
    check('the whole lifecycle runs in order',
      toolsCalledIn(capture).join(' '),
      'tabs_context_mcp tabs_context_mcp navigate get_page_text tabs_context_mcp tabs_close_mcp');
    check('and a clean run carries no cleanup warning', held.tabWarning, undefined);
    await s.close();
  }

  {
    const capture = nextCapture();
    const s = session('tabs-ok', { env: { CIC_STUB_CAPTURE: capture } });
    await s.open();
    await withTab(s, { url: 'https://example.com', keepTab: true }, body(s));
    check('keepTab leaves the tab alone', toolsCalledIn(capture).includes('tabs_close_mcp'), false);
    await s.close();
  }

  {
    const capture = nextCapture();
    const s = session('tabs-ok', { env: { CIC_STUB_CAPTURE: capture } });
    await s.open();
    await withTab(s, {}, body(s));
    check('no url means no navigation', toolsCalledIn(capture).includes('navigate'), false);
    check('but the tab is still made and closed',
      toolsCalledIn(capture).join(' '),
      'tabs_context_mcp tabs_context_mcp get_page_text tabs_context_mcp tabs_close_mcp');
    await s.close();
  }

  // ---- the browser answering no, in both of its two shapes ----------------
  //
  // A reply is a JSON-RPC error or a result that may carry isError. Reading
  // `.result` without checking `.error` first threw a TypeError, which the CLI
  // then classified as exit 3: the class that promises the browser cannot have
  // acted and the only one --retries repeats. For a failed navigate a tab
  // already existed, so that promise was false.
  {
    const s = session('tabs-create-error', { env: { CIC_STUB_GROUP_EXISTS: '1' } });
    await s.open();
    let error = null;
    try { await withTab(s, {}, body(s)); } catch (failure) { error = failure; }
    check('a create the tool refused is a TabLifecycleError', error instanceof TabLifecycleError, true);
    check('and names what the tool said', error && error.message, 'could not create a tab: no tab available');
    await s.close();
  }

  {
    const s = session('tabs-create-rpc-error', { env: { CIC_STUB_GROUP_EXISTS: '1' } });
    await s.open();
    let error = null;
    try { await withTab(s, {}, body(s)); } catch (failure) { error = failure; }
    check('a create that answered with a JSON-RPC error is also a TabLifecycleError',
      error instanceof TabLifecycleError, true);
    check('and carries the bridge message rather than a TypeError',
      error && error.message, 'could not create a tab: create blew up');
    await s.close();
  }

  {
    const capture = nextCapture();
    const s = session('tabs-navigate-rpc-error', { env: { CIC_STUB_CAPTURE: capture } });
    await s.open();
    let error = null;
    try { await withTab(s, { url: 'https://blocked.example' }, body(s)); } catch (failure) { error = failure; }
    check('a navigate that answered with a JSON-RPC error is a TabLifecycleError',
      error instanceof TabLifecycleError, true);
    check('and carries the bridge message',
      error && error.message, 'could not navigate to https://blocked.example: navigate blew up');
    check('and the tab it had already made is still closed',
      toolsCalledIn(capture).includes('tabs_close_mcp'), true);
    await s.close();
  }

  {
    const capture = nextCapture();
    const s = session('tabs-navigate-error', { env: { CIC_STUB_CAPTURE: capture } });
    await s.open();
    let error = null;
    try { await withTab(s, { url: 'https://blocked.example' }, body(s)); } catch (failure) { error = failure; }
    check('a navigate the tool refused is a TabLifecycleError', error instanceof TabLifecycleError, true);
    check('and its tab is closed, because the browser answered',
      toolsCalledIn(capture).includes('tabs_close_mcp'), true);
    await s.close();
  }

  // An ordinary tool error inside the body is an answer, not a failure of the
  // lifecycle, so it comes back as a result and the tab is tidied up.
  {
    const capture = nextCapture();
    const s = session('tabs-body-error', { env: { CIC_STUB_CAPTURE: capture } });
    await s.open();
    const held = await withTab(s, {}, body(s));
    check('a body that reports isError is still an answer', held.outcome.result.isError, true);
    check('and its tab is closed, because the browser finished',
      toolsCalledIn(capture).includes('tabs_close_mcp'), true);
    await s.close();
  }

  // ---- fail-closed --------------------------------------------------------
  //
  // The request reached the browser and no reply came, so the tab must survive:
  // closing it could discard whatever it was doing.
  {
    const capture = nextCapture();
    const s = session('tabs-body-unknown', { timeoutSeconds: 1, env: { CIC_STUB_CAPTURE: capture } });
    await s.open();
    let error = null;
    try {
      await withTab(s, {}, (tabId) => s.call('tools/call', { name: 'computer', arguments: { tabId } }));
    } catch (failure) { error = failure; }
    check('an unknown outcome propagates', error instanceof BridgeError, true);
    check('and is marked dispatched', error && error.dispatched, true);
    check('the tab is NOT closed after an unknown outcome',
      toolsCalledIn(capture).includes('tabs_close_mcp'), false);
    check('and the error says which tab was left', error && error.tabId, 4242);
    check('and says that leaving it was deliberate', error && error.tabLeftOpen, true);
    await s.close();
  }

  // The id only ever arrives inside a sentence, so a wording change upstream has
  // to fail loudly rather than address every later call to nothing. Dispatched
  // on purpose: a tab really was created, so retrying makes a second orphan.
  {
    const s = session('tabs-no-id', { env: { CIC_STUB_GROUP_EXISTS: '1' } });
    await s.open();
    let error = null;
    try { await withTab(s, {}, body(s)); } catch (failure) { error = failure; }
    check('a create reply with no id in it is refused', error instanceof BridgeError, true);
    check('and is dispatched, so it is never retried into a second orphan tab',
      error && error.dispatched, true);
    check('and says why that matters',
      error && /cannot be addressed or found again/.test(error.message), true);
    await s.close();
  }

  // ---- a cleanup that fails must not be swallowed -------------------------
  //
  // After success it is a warning beside the result.
  {
    const s = session('tabs-close-error');
    await s.open();
    const held = await withTab(s, {}, body(s));
    check('a close that fails does not undo a successful body',
      held.outcome.result.content[0].text, 'body ran against tab 4242');
    check('and it is reported as a warning', /tab 4242 may still be open/.test(held.tabWarning || ''), true);
    await s.close();
  }

  {
    const s = session('tabs-close-rpc-error');
    await s.open();
    const held = await withTab(s, {}, body(s));
    check('a close answering with a JSON-RPC error is a warning too, not a crash',
      /tab 4242 may still be open: close blew up/.test(held.tabWarning || ''), true);
    await s.close();
  }

  // And after a failure it rides along on that failure. Reporting only why the
  // work failed, while its tab is still sitting there, hides the one thing this
  // module exists to get right.
  {
    const s = session('tabs-navigate-and-close-error');
    await s.open();
    let error = null;
    try { await withTab(s, { url: 'https://blocked.example' }, body(s)); } catch (failure) { error = failure; }
    check('a failure whose cleanup also failed still reports the navigation',
      error && /could not navigate/.test(error.message), true);
    check('and carries the cleanup warning rather than dropping it',
      error && /tab 4242 may still be open/.test(error.tabWarning || ''), true);
    check('and names the tab that may still be open', error && error.tabId, 4242);
    await s.close();
  }

  // ---- a group that does not exist yet ------------------------------------
  //
  // The bridge refuses tabs_create_mcp until a group exists. Shipped 0.7.0
  // called it first and so failed for anyone starting from an empty group, which
  // is the ordinary case; every live check passed because a group happened to
  // exist, and the stub answered create unconditionally. Both are fixed, and
  // this is the assertion that would have caught it.
  {
    const capture = nextCapture();
    const s = session('tabs-ok', { env: { CIC_STUB_CAPTURE: capture, CIC_STUB_GROUP_EXISTS: '0' } });
    await s.open();
    const held = await withTab(s, { url: 'https://example.com' }, body(s));
    check('withTab works when no tab group exists yet', held.outcome.result.isError, undefined);
    check('opening the group rather than demanding one already exists',
      toolsCalledIn(capture)[0], 'tabs_context_mcp');
    check('and it never calls tabs_create_mcp, which would have been refused',
      toolsCalledIn(capture).includes('tabs_create_mcp'), false);
    await s.close();
  }

  // A group that cannot be opened at all is a tool error, not a crash.
  {
    const s = session('tabs-no-group-ever');
    await s.open();
    let error = null;
    try { await withTab(s, {}, body(s)); } catch (failure) { error = failure; }
    check('a group that will not open is a TabLifecycleError',
      error instanceof TabLifecycleError, true);
    check('and says what it could not do',
      error && /could not open a tab group/.test(error.message), true);
    await s.close();
  }

  // ---- cleanup must not orphan the tabs it leaves behind ------------------
  //
  // Closing a group's first tab makes the bridge lose the group, and every other
  // tab in it becomes invisible and unclosable from any session. Those groups
  // are what accumulate as identical pills in the tab strip, so withTab's own
  // cleanup refuses to make one and says so instead.
  {
    const capture = nextCapture();
    const s = session('tabs-close-would-orphan', { env: { CIC_STUB_CAPTURE: capture } });
    await s.open();
    const held = await withTab(s, {}, body(s));
    check('a cleanup that would orphan other tabs does not happen',
      toolsCalledIn(capture).includes('tabs_close_mcp'), false);
    check('and it is reported rather than done silently',
      /first tab in its group/.test(held.tabWarning || ''), true);
    check('naming how many tabs it would have taken with it',
      /1 other tab\(s\)/.test(held.tabWarning || ''), true);
    check('while the work itself still succeeded',
      held.outcome.result.content[0].text, 'body ran against tab 4242');
    await s.close();
  }

  // An unreadable group fails closed: our own tab is left open rather than
  // closed blind. Leaking a blank tab of ours is much cheaper than detaching
  // someone's live page.
  {
    const capture = nextCapture();
    const s = session('tabs-context-unreadable', { env: { CIC_STUB_CAPTURE: capture } });
    await s.open();
    const held = await withTab(s, {}, body(s));
    check('an unreadable group means the tab is not closed',
      toolsCalledIn(capture).includes('tabs_close_mcp'), false);
    check('and the reason says closing blind was the risk',
      /could not be read first/.test(held.tabWarning || ''), true);
    await s.close();
  }

  // Both halves of the guard can fail by throwing rather than answering, and a
  // throw on the way out must not replace the outcome already being reported.
  {
    const s = session('tabs-guard-read-hangs', { timeoutSeconds: 1 });
    await s.open();
    const held = await withTab(s, {}, body(s));
    check('a guard read that never answers leaves the tab open',
      /could not be read first/.test(held.tabWarning || ''), true);
    check('and the work still succeeded', held.outcome.result.content[0].text,
      'body ran against tab 4242');
    await s.close();
  }

  {
    const s = session('tabs-close-hangs', { timeoutSeconds: 1 });
    await s.open();
    const held = await withTab(s, {}, body(s));
    check('a close that never answers is a warning, not a thrown failure',
      /may still be open/.test(held.tabWarning || ''), true);
    check('and the work still succeeded', held.outcome.result.content[0].text,
      'body ran against tab 4242');
    await s.close();
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((failure) => {
  console.log('FAIL  the suite itself threw:', failure && failure.stack);
  process.exit(1);
});
