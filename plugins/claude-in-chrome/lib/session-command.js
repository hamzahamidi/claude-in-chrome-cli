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

/**
 * The human REPL over the same machinery. Deliberately dumb: a line is a tool
 * name and optional JSON arguments, nothing is remembered between lines, and
 * there is no interpolation. Anything cleverer belongs in the program calling
 * the JSONL interface.
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
  output.write("Connected. One line is: <tool> [json-args]. Ctrl-D or .exit to leave.\n");

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
  await session.close();
  return exitCode;
}

module.exports = { runSession, runShell, planRecord, EXIT, KIND };
