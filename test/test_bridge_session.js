#!/usr/bin/env node
// Tests BridgeSession directly, rather than through the command line.
//
// Two properties here cannot be observed from outside the process: when the
// dispatched flag flips, and whether a reused session accumulates listeners.
// Both matter because v0.6.0 holds one session open across many calls, so this
// file is where that reuse gets proven.
'use strict';

const assert = require('assert');
const path = require('path');

const { BridgeSession, BridgeError } = require('../plugins/claude-in-chrome/lib/bridge-session.js');

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

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((failure) => {
  console.log('FAIL  the suite itself threw:', failure && failure.message);
  process.exit(1);
});
