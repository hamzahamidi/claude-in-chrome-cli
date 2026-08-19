#!/usr/bin/env node
// Tests BridgeSession directly, rather than through the command line.
//
// Two properties here cannot be observed from outside the process: when the
// dispatched flag flips, and whether a reused session accumulates listeners.
// Both matter because v0.6.0 holds one session open across many calls, so this
// file is where that reuse gets proven.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  BridgeSession, BridgeError, TabLifecycleError,
} = require('../plugins/claude-in-chrome/lib/bridge-session.js');

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
  return new BridgeSession({
    binary: process.execPath,
    binaryArguments: [STUB],
    timeoutSeconds,
  });
}

async function main() {
  // ---- the dispatched flag must lead the write, not follow it --------------

  // If it followed, a child that received the request and then died or replied
  // badly before the write callback ran would be reported as never dispatched,
  // and --retries would repeat an action that had already happened. Checking it
  // synchronously after call() is what pins the ordering: there is no await
  // between entering call() and the flag being set.
  {
    const s = session('never-reply', { timeoutSeconds: 1 });
    await s.open();
    check('nothing is dispatched by the handshake alone', s.dispatched, false);
    const pending = s.call('tools/call', { name: 'navigate', arguments: {} });
    check('the request counts as dispatched before its write resolves', s.dispatched, true);
    await pending.catch(() => {});
    await s.close();
  }

  // A child that dies the instant it sees the request must be post-dispatch,
  // which is what makes it exit 2 rather than a retryable exit 3.
  {
    const s = session('exit-early');
    await s.open();
    let error = null;
    try { await s.call('tools/call', { name: 'navigate', arguments: {} }); }
    catch (failure) { error = failure; }
    check('a child dying on receipt is a BridgeError', error instanceof BridgeError, true);
    check('and it is marked dispatched, so it is never retried', error && error.dispatched, true);
    await s.close();
  }

  // A handshake failure is the opposite: nothing was sent, so it stays
  // retryable.
  {
    const s = session('no-initialize-reply', { timeoutSeconds: 1 });
    let error = null;
    try { await s.open(); } catch (failure) { error = failure; }
    check('a handshake timeout is not dispatched', error && error.dispatched, false);
    await s.close();
  }

  // ---- a reused session must not accumulate listeners ---------------------

  // Four listeners per request, never removed, is invisible in one-shot use and
  // fatal to the reuse this class exists for: twelve calls reached thirteen
  // data listeners and Node began warning about a probable leak.
  // The assertion is growth, not an absolute count. With one reader for the
  // session there is exactly one listener set attached at open() and it stays
  // for the session's life, so demanding zero would only be true of the old
  // per-request design. What must never change is that the count is independent
  // of how many calls have been made.
  {
    const s = session('ok');
    await s.open();
    const before = {
      data: s.child.stdout.listenerCount('data'),
      exit: s.child.listenerCount('exit'),
      error: s.child.listenerCount('error'),
    };
    const CALLS = 12;
    let allSucceeded = true;
    for (let i = 0; i < CALLS; i++) {
      const reply = await s.call('tools/call', { name: 'navigate', arguments: {} });
      if (!reply.result || !Array.isArray(reply.result.content)) { allSucceeded = false; }
    }
    check(`${CALLS} sequential calls on one session all answer`, allSucceeded, true);
    check('stdout data listeners do not grow with calls', s.child.stdout.listenerCount('data'), before.data);
    check('child exit listeners do not grow with calls', s.child.listenerCount('exit'), before.exit);
    check('child error listeners do not grow with calls', s.child.listenerCount('error'), before.error);
    check('and one reader serves the whole session', before.data, 1);
    // Every waiter is removed as it settles, so nothing is left holding ids.
    check('no waiters outlive their calls', s.waiters.size, 0);
    await s.close();
  }

  // Ids advance per request rather than being reused, which is what lets a
  // later release match replies to requests at all.
  {
    const s = session('ok');
    await s.open();
    await s.call('tools/list', {});
    await s.call('tools/list', {});
    check('request ids advance across calls', s.nextId, 4);
    await s.close();
  }

  // ---- close is idempotent and releases the child --------------------------
  {
    const s = session('ok');
    await s.open();
    await s.call('tools/list', {});
    await s.close();
    await s.close();
    check('a closed session reports itself closed', s.closed, true);
    check('and its child is gone', s.child.exitCode !== null || s.child.signalCode !== null, true);
  }

  // ---- withTab: the cleanup rule is the contract --------------------------

  // Which tools were actually called, in order, read back from the stub's
  // capture file. Whether the close happened cannot be observed any other way
  // from out here, and it is the whole point of the helper.
  const toolsCalledIn = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((message) => message.method === 'tools/call')
    .map((message) => message.params.name);

  let captureCount = 0;
  const nextCapture = () => path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), `cic-cap-${captureCount++}-`)), 'calls.jsonl');

  {
    const capture = nextCapture();
    const s = session('tabs-ok', { env: { CIC_STUB_CAPTURE: capture } });
    await s.open();
    const held = await s.withTab({ url: 'https://example.com' },
      (tabId) => s.call('tools/call', { name: 'get_page_text', arguments: { tabId } }));
    check('withTab reports the tab it made', held.tabId, 4242);
    check('and hands that id to the body',
      held.outcome.result.content[0].text, 'body ran against tab 4242');
    check('the whole lifecycle runs in order',
      toolsCalledIn(capture).join(' '), 'tabs_create_mcp navigate get_page_text tabs_close_mcp');
    await s.close();
  }

  {
    const capture = nextCapture();
    const s = session('tabs-ok', { env: { CIC_STUB_CAPTURE: capture } });
    await s.open();
    await s.withTab({ url: 'https://example.com', keepTab: true },
      (tabId) => s.call('tools/call', { name: 'get_page_text', arguments: { tabId } }));
    check('keepTab leaves the tab alone',
      toolsCalledIn(capture).includes('tabs_close_mcp'), false);
    await s.close();
  }

  {
    const capture = nextCapture();
    const s = session('tabs-ok', { env: { CIC_STUB_CAPTURE: capture } });
    await s.open();
    await s.withTab({}, (tabId) => s.call('tools/call', { name: 'get_page_text', arguments: { tabId } }));
    check('no url means no navigation', toolsCalledIn(capture).includes('navigate'), false);
    check('but the tab is still made and closed',
      toolsCalledIn(capture).join(' '), 'tabs_create_mcp get_page_text tabs_close_mcp');
    await s.close();
  }

  // An ordinary tool error means the browser answered, so the tab is in a known
  // state and gets tidied up.
  {
    const capture = nextCapture();
    const s = session('tabs-body-error', { env: { CIC_STUB_CAPTURE: capture } });
    await s.open();
    const held = await s.withTab({}, (tabId) => s.call('tools/call', { name: 'find', arguments: { tabId } }));
    check('a body that reports isError is still an answer', held.outcome.result.isError, true);
    check('and its tab is closed, because the browser finished',
      toolsCalledIn(capture).includes('tabs_close_mcp'), true);
    await s.close();
  }

  // The fail-closed case. The request reached the browser and no reply came, so
  // the tab must survive: closing it could discard whatever it was doing.
  {
    const capture = nextCapture();
    const s = session('tabs-body-unknown', { timeoutSeconds: 1, env: { CIC_STUB_CAPTURE: capture } });
    await s.open();
    let error = null;
    try {
      await s.withTab({}, (tabId) => s.call('tools/call', { name: 'computer', arguments: { tabId } }));
    } catch (failure) { error = failure; }
    check('an unknown outcome propagates', error instanceof BridgeError, true);
    check('and is marked dispatched', error && error.dispatched, true);
    check('the tab is NOT closed after an unknown outcome',
      toolsCalledIn(capture).includes('tabs_close_mcp'), false);
    check('and the error says which tab was left', error && error.tabId, 4242);
    check('and says that leaving it was deliberate', error && error.tabLeftOpen, true);
    await s.close();
  }

  // A failure that never reached the browser leaves the tab in a known state,
  // so that one is still cleaned up.
  {
    const capture = nextCapture();
    const s = session('tabs-navigate-error', { env: { CIC_STUB_CAPTURE: capture } });
    await s.open();
    let error = null;
    try { await s.withTab({ url: 'https://blocked.example' }, () => { throw new Error('never reached'); }); }
    catch (failure) { error = failure; }
    check('a navigation the browser refused is a TabLifecycleError',
      error instanceof TabLifecycleError, true);
    check('and the tab it had already made is closed',
      toolsCalledIn(capture).includes('tabs_close_mcp'), true);
    await s.close();
  }

  {
    const s = session('tabs-create-error');
    await s.open();
    let error = null;
    try { await s.withTab({}, () => null); } catch (failure) { error = failure; }
    check('a tab the browser would not create is a TabLifecycleError',
      error instanceof TabLifecycleError, true);
    check('and names what the tool said',
      error && error.message, 'could not create a tab: no tab available');
    await s.close();
  }

  // The id only ever arrives inside a sentence, so a wording change upstream
  // has to fail loudly here rather than address every later call to nothing.
  //
  // It is dispatched on purpose. A tab really was created and the reply just did
  // not say which, so this is an unknown outcome rather than a failure that left
  // the browser untouched: the retryable class would make a second orphan tab
  // every time it tried.
  {
    const s = session('tabs-no-id');
    await s.open();
    let error = null;
    try { await s.withTab({}, () => null); } catch (failure) { error = failure; }
    check('a create reply with no id in it is refused', error instanceof BridgeError, true);
    check('and is dispatched, so it is never retried into a second orphan tab',
      error && error.dispatched, true);
    check('and says why that matters',
      error && /cannot be addressed or found again/.test(error.message), true);
    await s.close();
  }

  // Cleanup failing after the work succeeded is untidy, not wrong: the caller
  // got what they asked for, and the stray tab is reported rather than promoted
  // into a failure.
  {
    const s = session('tabs-close-error');
    await s.open();
    const held = await s.withTab({}, (tabId) => s.call('tools/call', { name: 'find', arguments: { tabId } }));
    check('a close that fails does not undo a successful body',
      held.outcome.result.content[0].text, 'body ran against tab 4242');
    check('and it is reported as a warning',
      /tab 4242 may still be open/.test(held.tabWarning || ''), true);
    await s.close();
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((failure) => {
  console.log('FAIL  the suite itself threw:', failure && failure.message);
  process.exit(1);
});
