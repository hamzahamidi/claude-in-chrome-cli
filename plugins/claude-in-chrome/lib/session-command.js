// `cic session --jsonl` and `cic shell`: many calls over one live connection.
//
// One BridgeSession stays open; the caller owns sequencing and any dynamic value
// it wants to thread through, such as a tabId returned by an earlier call. This
// file owns the connection and the record format, and deliberately owns nothing
// else: there are no variables, captures, aliases, implicit current tab or
// control flow here, because those belong to whatever is driving it.
'use strict';

const readline = require('readline');

const { BridgeSession, BridgeError } = require('./bridge-session.js');
const { adoptTab, contextOf, tabsIn } = require('./tab-adoption.js');

// Same numbers and names as the one-shot contract, because a caller that
// already parses `cic call --json` should not need a second vocabulary.
const EXIT = { OK: 0, TOOL_ERROR: 1, UNKNOWN: 2, TRANSPORT: 3, USAGE: 64 };
const KIND = {
  [EXIT.TOOL_ERROR]: 'tool_error',
  [EXIT.UNKNOWN]: 'unknown_outcome',
  [EXIT.TRANSPORT]: 'transport',
  [EXIT.USAGE]: 'usage',
};

/** The text parts of a tool result, which is where a tool puts its complaint. */
const textOf = (result) => (result.content || [])
  .filter((part) => part && part.type === 'text')
  .map((part) => part.text)
  .join('\n');

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Turns one input record into the request to send, or an explanation of why it
 * cannot be sent. A bad record is that record's problem: it gets a usage reply
 * and the session carries on, because one caller typo should not tear down a
 * connection that other queued calls are relying on.
 */
function planRecord(record) {
  if (!isPlainObject(record)) { return { error: 'each line must be a JSON object.' }; }
  if (record.id === undefined || record.id === null) { return { error: 'each record needs an id.' }; }
  if (typeof record.tool !== 'string' || record.tool === '') {
    return { error: 'each record needs a tool name.' };
  }
  const args = record.arguments === undefined ? {} : record.arguments;
  if (!isPlainObject(args)) { return { error: 'arguments must be a JSON object.' }; }
  if (record.timeout !== undefined) {
    if (typeof record.timeout !== 'number' || !Number.isFinite(record.timeout) || record.timeout <= 0) {
      return { error: 'timeout must be a positive number of seconds.' };
    }
  }
  return { id: record.id, tool: record.tool, args, timeout: record.timeout };
}

/** One line out per call, in the frozen envelope plus the id it answers. */
function successRecord(id, result) {
  return JSON.stringify({ id, exit: EXIT.OK, result });
}

function failureRecord(id, exitCode, message) {
  return JSON.stringify({
    id, error: true, kind: KIND[exitCode], exit: exitCode, message,
  });
}

/**
 * Writes one line and resolves when the stream has actually taken it.
 *
 * An unchecked write() returns false once the consumer stops keeping up and
 * buffers the rest in memory. With stdout unread, forty one-megabyte replies
 * were all accepted and the process reached 142 MB: the reads were paced by the
 * bridge, but nothing paced the writes. Awaiting this before resuming stdin is
 * what makes the whole loop bounded rather than only half of it.
 */
function writeLine(output, text) {
  return new Promise((resolve) => {
    let settled = false;
    // Both listeners come off on the way out. `once` only detaches a listener
    // when its event actually fires, so the error listener from every successful
    // write stayed attached: fifteen records was enough for Node to warn about a
    // probable leak, in precisely the long-running mode this function exists
    // for. Same shape as the per-request listeners 0.5.0 removed from
    // BridgeSession, missed here because that suite watches the child's stdout
    // and this one is the session's own output stream.
    const done = () => {
      if (settled) { return; }
      settled = true;
      output.removeListener('error', done);
      output.removeListener('drain', done);
      resolve();
    };
    // A consumer that goes away is not our failure; stop waiting for it.
    output.once('error', done);
    if (output.write(text)) { done(); return; }
    output.once('drain', done);
  });
}

function classify(failure) {
  if (failure instanceof BridgeError) { return failure.dispatched ? EXIT.UNKNOWN : EXIT.TRANSPORT; }
  return EXIT.TRANSPORT;
}

/**
 * Runs the streaming session. Returns the process exit code, which describes
 * only the session: startup, clean shutdown, or a fatal session failure. Every
 * per-call outcome is reported in its own record, because a persistent process
 * has one exit status and many calls.
 */
async function runSession({ timeoutSeconds, input, output, jsonl }) {
  const session = new BridgeSession({ timeoutSeconds });
  try {
    await session.open();
  } catch (failure) {
    await writeLine(output, failureRecord(null, classify(failure), failure.message) + '\n');
    await session.close();
    return classify(failure);
  }

  const lines = readline.createInterface({ input, terminal: false });
  let exitCode = EXIT.OK;
  let queue = Promise.resolve();
  let fatal = false;

  // Serial by construction: each line's work is chained onto the last, and
  // stdin is paused while a call is in flight so a firehose of input cannot
  // outrun the bridge and grow an unbounded backlog in memory.
  const handle = (line) => {
    queue = queue.then(async () => {
      if (fatal) { return; }
      const trimmed = line.trim();
      if (!trimmed) { return; }

      let record;
      try { record = JSON.parse(trimmed); } catch (failure) {
        await writeLine(output, failureRecord(null, EXIT.USAGE, `line is not valid JSON: ${failure.message}`) + '\n');
        return;
      }

      const plan = planRecord(record);
      if (plan.error) {
        await writeLine(output, failureRecord(isPlainObject(record) ? record.id ?? null : null, EXIT.USAGE, plan.error) + '\n');
        return;
      }

      try {
        const reply = await session.call('tools/call',
          { name: plan.tool, arguments: plan.args },
          { timeoutSeconds: plan.timeout });

        if (reply.error) {
          await writeLine(output, failureRecord(plan.id, EXIT.TOOL_ERROR, reply.error.message) + '\n');
          return;
        }
        if (reply.result.isError) {
          await writeLine(output, failureRecord(plan.id, EXIT.TOOL_ERROR,
            textOf(reply.result) || 'the tool reported an error') + '\n');
          return;
        }
        await writeLine(output, successRecord(plan.id, reply.result) + '\n');
      } catch (failure) {
        const code = classify(failure);
        await writeLine(output, failureRecord(plan.id, code, failure.message) + '\n');
        // An unknown outcome ends the session. The request was sent and nobody
        // knows whether the browser acted on it, so continuing would let a
        // later call race an earlier one whose effect is undetermined. The
        // caller gets the record, then a fresh session or nothing.
        if (code === EXIT.UNKNOWN) {
          fatal = true;
          exitCode = EXIT.UNKNOWN;
          stopReading();
        }
      }
    }).catch((failure) => {
      // A crash handling one record is that record's problem, reported and
      // survived, rather than a silent hole in every record queued behind it.
      output.write(failureRecord(null, EXIT.TRANSPORT, `failed handling a record: ${failure && failure.message}`) + '\n');
      /* not awaited: this is the last-resort path and must never itself hang */
    });
    return queue;
  };

  // Closing readline is not enough to end the process. stdin was paused by hand
  // and stays referenced while it is open, so a fatal session sat there until the
  // writer at the other end happened to close: the record was emitted and then
  // nothing happened for as long as the caller kept the pipe. Releasing stdin is
  // what actually lets the process leave.
  function stopReading() {
    lines.close();
    try { input.pause?.(); } catch { /* already gone */ }
    try { input.unref?.(); } catch { /* not refcounted */ }
    try { input.destroy?.(); } catch { /* already destroyed */ }
  }

  await new Promise((resolve) => {
    lines.on('line', (line) => {
      input.pause?.();
      handle(line).then(() => { if (!fatal) { input.resume?.(); } });
    });
    lines.on('close', () => { queue.then(resolve, resolve); });
  });
  await queue.catch(() => {});
  stopReading();
  await session.close();
  return exitCode;
}

/** origin and path only, so a prompt never echoes a query string or a token. */
function shownUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}

/**
 * `.adopt`: use a tab the user already has open.
 *
 * Only the rendering and the cancelling live here; the protocol is in
 * lib/tab-adoption.js. Two deliberate absences. There is no second
 * confirmation, because adoption touches no page and the next line is written by
 * a human who has just read which tab was adopted, so the confirmation is
 * structural rather than a prompt. And the adopted id is printed rather than
 * remembered, because nothing is remembered between lines in this shell and one
 * implicit current tab would be the end of that.
 */
async function runAdopt(session, rl, output, anchors) {
  output.write('\nMove the Chrome tab you want Claude to use into the Claude tab group.\n');
  output.write('That gives Claude access to read and interact with that live page.\n');
  output.write('Right-click the tab, then Add tab to group.\n\n');

  // Cancellation is a flag, not an interruption. A poll already in flight is
  // read-only and is allowed to settle, so cancelling never invents an outcome
  // nobody can classify.
  //
  // Ctrl-C arrives two different ways and both must work. On a terminal,
  // readline intercepts the keypress and emits 'SIGINT' on the INTERFACE; no
  // process signal ever fires, which a pty demonstrates and a piped test cannot.
  // Without a terminal there is no keypress and a real SIGINT reaches the
  // process. The first version registered only the process handler, so Ctrl-C
  // cancelled in tests and did nothing for a human.
  let cancelled = false;
  const onInterrupt = () => { if (!cancelled) { cancelled = true; output.write('\ncancelling…\n'); } };
  // End of input is its own cancellation: nobody is left to move a tab in.
  const onEndOfInput = () => { cancelled = true; };
  process.on('SIGINT', onInterrupt);
  rl.on('SIGINT', onInterrupt);
  rl.on('close', onEndOfInput);

  try {
    const result = await adoptTab(session, {
      // The window is the human's, not the transport's. A per-call --timeout of
      // 30 seconds is no time at all to find a context menu, and the premise
      // checks that shaped this feature allowed minutes. Adoption therefore
      // waits until the user acts, cancels, or closes input.
      timeoutSeconds: Infinity,
      // Pacing only, read by tests so a poll loop does not make every suite run
      // multiples of 1.5 seconds long. Behaviour is identical at any pace.
      pollMs: Number(process.env.CIC_ADOPT_POLL_MS) || undefined,
      cancelled: () => cancelled,
      notify: (event) => {
        if (event.kind === 'waiting') { output.write('Waiting for a tab…  Ctrl-C to cancel\n'); }
        else if (event.kind === 'too-many') {
          output.write(`${event.count} tabs were added. Move the ones you do not want back out of the group.\n`);
        } else if (event.kind === 'internal-tab') {
          output.write('That is a blank tab rather than a page. Still waiting.\n');
        } else if (event.kind === 'not-drivable') {
          output.write('That tab cannot be driven yet, possibly still loading. Still waiting.\n');
        } else if (event.kind === 'anchor-replaced') {
          output.write('The group had emptied, so it is being held open again.\n');
        }
      },
    });

    if (result.anchorCreated && result.anchor !== null) { anchors.created = result.anchor; }

    if (result.outcome === 'adopted') {
      output.write(`\n✓ ${result.tab.title || '(untitled)'}\n`);
      output.write(`  ${shownUrl(result.tab.url)}\n`);
      output.write(`\nAdopted as tab ${result.tab.tabId}. Pass that id to the tools you call next.\n\n`);
      return;
    }
    if (result.outcome === 'cancelled') { output.write('Cancelled. No page was touched.\n\n'); return; }
    output.write('No tab was moved in, so nothing was adopted. No page was touched.\n\n');
  } catch (failure) {
    output.write(`cic: ${failure.message}\n\n`);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    rl.removeListener('SIGINT', onInterrupt);
    rl.removeListener('close', onEndOfInput);
  }
}

/**
 * The human REPL over the same machinery. Deliberately dumb: a line is a tool
 * name and optional JSON arguments, nothing is remembered between lines, and
 * there is no interpolation. Anything cleverer belongs in the program calling
 * the JSONL interface.
 *
 * `.adopt` is the one exception, and it is session setup rather than a language
 * feature: it prints an id and remembers nothing, so the line grammar stays as
 * dumb as it was.
 */
async function runShell({ timeoutSeconds, input, output }) {
  const session = new BridgeSession({ timeoutSeconds });
  try {
    await session.open();
  } catch (failure) {
    output.write(`cic: ${failure.message}\n`);
    await session.close();
    return classify(failure);
  }

  const rl = readline.createInterface({ input, output, prompt: 'cic> ' });
  output.write("Connected. One line is: <tool> [json-args]. .adopt to use a tab you already have open. Ctrl-D or .exit to leave.\n");

  // The anchor .adopt opened, if any. Whether it is safe to close at exit is
  // decided by looking at the live group then, not by bookkeeping: a tab
  // adopted and later moved back out would otherwise pin an anchor that no
  // longer protects anything.
  const anchors = { created: null };
  let exitCode = EXIT.OK;
  let queue = Promise.resolve();
  // Readline emits every piped line and then fires close at end of input, all
  // before the first call has finished. Prompting a closed interface throws
  // ERR_USE_AFTER_CLOSE, and that rejection used to poison the queue, silently
  // skipping every line after the first. Piped input is the normal case in a
  // test, so this has to hold there and not only under a terminal.
  let closed = false;
  // Distinct from `closed`: readline has already emitted every piped line by the
  // time the first one runs, so a line queued behind `.exit` would still execute
  // without this. Stopping means stopping, including work already queued.
  let stopped = false;
  const prompt = () => { if (!closed) { rl.prompt(); } };
  rl.on('close', () => { closed = true; });
  prompt();

  rl.on('line', (raw) => {
    // Each line is chained on, and each catches its own failure: one bad line
    // must not cancel the ones already queued behind it.
    queue = queue.then(async () => {
      if (stopped) { return; }
      const line = raw.trim();
      if (!line) { prompt(); return; }
      if (line === '.exit' || line === '.quit') { stopped = true; closed = true; rl.close(); return; }
      if (line === '.adopt') {
        await runAdopt(session, rl, output, anchors);
        prompt();
        return;
      }

      const space = line.indexOf(' ');
      const tool = space === -1 ? line : line.slice(0, space);
      const rest = space === -1 ? '{}' : line.slice(space + 1).trim() || '{}';

      let args;
      try { args = JSON.parse(rest); } catch (failure) {
        output.write(`cic: arguments are not valid JSON: ${failure.message}\n`);
        prompt();
        return;
      }
      if (!isPlainObject(args)) {
        output.write('cic: arguments must be a JSON object.\n');
        prompt();
        return;
      }

      try {
        const reply = await session.call('tools/call', { name: tool, arguments: args },
          { timeoutSeconds });
        if (reply.error) {
          output.write(`cic: ${reply.error.message}\n`);
        } else {
          const text = textOf(reply.result);
          output.write((text || '(no text content)') + '\n');
          if (reply.result.isError) { output.write('cic: the tool reported an error\n'); }
        }
      } catch (failure) {
        const code = classify(failure);
        output.write(`cic: ${failure.message}\n`);
        // Same rule as the JSONL path, for the same reason: after an unknown
        // outcome the session cannot be trusted to order anything else.
        if (code === EXIT.UNKNOWN) {
          output.write('cic: the outcome is unknown, so this session is over. Start a new one.\n');
          exitCode = EXIT.UNKNOWN;
          stopped = true;
          closed = true;
          rl.close();
          return;
        }
      }
      prompt();
    }).catch((failure) => {
      // Never let one line's crash stop the rest from running.
      output.write(`cic: ${failure && failure.message}\n`);
    });
    return queue;
  });

  await new Promise((resolve) => { rl.on('close', () => queue.then(resolve, resolve)); });
  await tidyAnchor(session, output, anchors);
  await session.close();
  return exitCode;
}

/**
 * Closes an anchor this shell opened, but only when doing so is safe.
 *
 * Closing a group's first tab makes the bridge lose the whole group, and every
 * other tab in it becomes invisible and unclosable through the bridge. Safety
 * is judged from the live group at exit rather than from bookkeeping: a tab
 * adopted and later moved back out no longer needs protecting, and a tab the
 * user created by hand mid-session does. When another tab remains, the anchor
 * stays open and the reason is said out loud: one stray blank tab is cheaper
 * than silently detaching a live tab, and this is the one place the tool
 * knowingly leaves something behind. A group that cannot be read is left
 * alone, because closing what cannot be verified is the wrong default.
 */
async function tidyAnchor(session, output, anchors) {
  if (anchors.created === null) { return; }
  let others = null;
  try {
    const reply = await session.call('tools/call', { name: 'tabs_context_mcp', arguments: {} });
    others = tabsIn(contextOf(reply)).filter((tab) => tab.tabId !== anchors.created);
  } catch { /* unreadable; fall through to the fail-closed message */ }
  if (others === null) {
    output.write(`cic: the blank tab ${anchors.created} may still be open.\n`);
    return;
  }
  if (others.length > 0) {
    output.write(`cic: leaving the blank tab ${anchors.created} open on purpose. `
      + 'Closing it would make the bridge lose the group, and the tabs still in it. '
      + 'Close it yourself once you are done with the group.\n');
    return;
  }
  try {
    const reply = await session.call('tools/call',
      { name: 'tabs_close_mcp', arguments: { tabId: anchors.created } });
    if (reply.error || (reply.result && reply.result.isError)) {
      output.write(`cic: the blank tab ${anchors.created} may still be open.\n`);
    }
  } catch {
    output.write(`cic: the blank tab ${anchors.created} may still be open.\n`);
  }
}

module.exports = { runSession, runShell, planRecord, EXIT, KIND };
