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
    check('the whole lifecycle runs in order',
      toolsCalledIn(capture).join(' '), 'tabs_create_mcp navigate get_page_text tabs_close_mcp');
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
      toolsCalledIn(capture).join(' '), 'tabs_create_mcp get_page_text tabs_close_mcp');
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
    const s = session('tabs-create-error');
    await s.open();
    let error = null;
    try { await withTab(s, {}, body(s)); } catch (failure) { error = failure; }
    check('a create the tool refused is a TabLifecycleError', error instanceof TabLifecycleError, true);
    check('and names what the tool said', error && error.message, 'could not create a tab: no tab available');
    await s.close();
  }

  {
    const s = session('tabs-create-rpc-error');
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
    const s = session('tabs-no-id');
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

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((failure) => {
  console.log('FAIL  the suite itself threw:', failure && failure.stack);
  process.exit(1);
});
