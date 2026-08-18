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
    output.write(failureRecord(null, classify(failure), failure.message) + '\n');
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
        output.write(failureRecord(null, EXIT.USAGE, `line is not valid JSON: ${failure.message}`) + '\n');
        return;
      }

      const plan = planRecord(record);
      if (plan.error) {
        output.write(failureRecord(isPlainObject(record) ? record.id ?? null : null, EXIT.USAGE, plan.error) + '\n');
        return;
      }

      try {
        const reply = await session.call('tools/call',
          { name: plan.tool, arguments: plan.args },
          { timeoutSeconds: plan.timeout });

        if (reply.error) {
          output.write(failureRecord(plan.id, EXIT.TOOL_ERROR, reply.error.message) + '\n');
          return;
        }
        if (reply.result.isError) {
          output.write(failureRecord(plan.id, EXIT.TOOL_ERROR,
            textOf(reply.result) || 'the tool reported an error') + '\n');
          return;
        }
        output.write(successRecord(plan.id, reply.result) + '\n');
      } catch (failure) {
        const code = classify(failure);
        output.write(failureRecord(plan.id, code, failure.message) + '\n');
        // An unknown outcome ends the session. The request was sent and nobody
        // knows whether the browser acted on it, so continuing would let a
        // later call race an earlier one whose effect is undetermined. The
        // caller gets the record, then a fresh session or nothing.
        if (code === EXIT.UNKNOWN) {
          fatal = true;
          exitCode = EXIT.UNKNOWN;
          lines.close();
        }
      }
    }).catch((failure) => {
      // A crash handling one record is that record's problem, reported and
      // survived, rather than a silent hole in every record queued behind it.
      output.write(failureRecord(null, EXIT.TRANSPORT, `failed handling a record: ${failure && failure.message}`) + '\n');
    });
    return queue;
  };

  await new Promise((resolve) => {
    lines.on('line', (line) => {
      input.pause?.();
      handle(line).then(() => { if (!fatal) { input.resume?.(); } });
    });
    lines.on('close', () => { queue.then(resolve, resolve); });
  });
  await queue.catch(() => {});
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
