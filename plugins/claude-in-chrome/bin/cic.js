#!/usr/bin/env node
// cic - call Claude in Chrome MCP tools from the shell, without an MCP client.
//
// Claude Code ships a stdio MCP server, `claude --claude-in-chrome-mcp`, that
// bridges to the Claude in Chrome extension and drives your real, logged-in
// browser. This asks BridgeSession to negotiate the handshake, calls one tool,
// prints the result, and exits.
//
// The protocol lives in ../lib/bridge-session.js. What is left here is the
// command line: arguments, output, retries and the exit-code contract.
'use strict';

const { BridgeSession, BridgeError } = require('../lib/bridge-session.js');
const { runSession, runShell } = require('../lib/session-command.js');

const VERSION = '0.6.0';
const DEFAULT_TIMEOUT_SECONDS = 30;
// Backoff between retries. Only exit-3 failures are retried, and those fail
// fast, so this stays short enough to be worth doing inside one command.
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 4000;

// The exit-code contract, frozen at 0.4.0. The boundary between UNKNOWN and
// TRANSPORT is whether the tools/call request reached the child's stdin: only
// TRANSPORT guarantees the browser cannot have acted, so only it is safe to
// retry automatically.
const EXIT = { OK: 0, TOOL_ERROR: 1, UNKNOWN: 2, TRANSPORT: 3, USAGE: 64 };
const KIND = {
  [EXIT.TOOL_ERROR]: 'tool_error',
  [EXIT.UNKNOWN]: 'unknown_outcome',
  [EXIT.TRANSPORT]: 'transport',
  [EXIT.USAGE]: 'usage',
};

const USAGE = `cic - call Claude in Chrome MCP tools from the shell.

Usage:
  cic list                          list available tools
  cic call <tool> [json-args]       call a tool, arguments default to {}
  cic session --jsonl               many calls over one connection, one JSON object per line
  cic shell                         the same connection, driven by hand

Options:
  --timeout <secs>   ceiling on how long to wait for the reply (default ${DEFAULT_TIMEOUT_SECONDS})
  --retries <n>      retry only failures that never reached the browser (exit 3)
  --json             print the raw result object, or one error object, on one line
  -h, --help         this text
  -v, --version      print the version

Examples:
  cic list
  cic call navigate '{"url":"https://example.com"}'
  cic call get_page_text '{}' --timeout 60
  cic call computer '{"action":"screenshot"}' --json
  cic call navigate '{"url":"https://example.com"}' --retries 3
  echo '{"id":1,"tool":"tabs_create_mcp"}' | cic session --jsonl
  cic shell

One connection, many calls:
  cic session --jsonl reads one JSON object per line and writes one per call.
    in:   {"id":<any>,"tool":"<name>","arguments":{...},"timeout":<secs>}
    out:  {"id":<same>,"exit":0,"result":{...}}
          {"id":<same>,"error":true,"kind":"...","exit":<code>,"message":"..."}
  Calls run one at a time, in order. Each record carries its own outcome, so the
  process exit code describes only the session: 0 clean, 2 a call whose outcome
  was unknown ended it, 3 it never started. An unknown outcome is fatal by
  design: the request was sent, nobody knows if the browser acted, and a later
  call must not race it.

Exit codes:
  0   success
  1   the tool reported an error
  2   outcome unknown: the request was sent and no usable reply came back
  3   failed before the request was sent, so the browser cannot have acted
  64  usage error, or invalid arguments JSON`;

class UsageError extends Error {}

// A flag a command cannot act on is a mistake worth reporting, not one worth
// ignoring: `cic list --jsonl` used to exit 0 having quietly done something
// other than what was asked for.
const FLAGS_BY_COMMAND = {
  list: new Set(['--json', '--timeout', '--retries']),
  call: new Set(['--json', '--timeout', '--retries']),
  session: new Set(['--jsonl', '--timeout']),
  shell: new Set(['--timeout']),
};

function rejectUnsupportedFlags(command, provided) {
  const allowed = FLAGS_BY_COMMAND[command];
  if (!allowed) { return; }
  const wrong = [...provided].filter((flag) => !allowed.has(flag));
  if (wrong.length) {
    throw new UsageError(
      `${command} does not take ${wrong.join(', ')}. It understands ${[...allowed].join(', ')}.`);
  }
}

// Nothing here calls process.exit() after writing. Writing to a pipe is
// asynchronous, and exiting discards whatever has not drained yet, which
// truncated a large page-text result at the pipe buffer boundary. Every path
// awaits its write and sets process.exitCode instead.
let stdoutBroken = false;

// A broken pipe reaches us twice: once through the write callback below, and
// once as an 'error' event on the stream itself. Without a listener for the
// second, Node rethrows it, so piping a large result into `head -c 1` died with
// a stack trace after the output had already been delivered.
function absorbStreamError(stream) {
  stream.on('error', (error) => {
    if (error && error.code === 'EPIPE') {
      if (stream === process.stdout) { stdoutBroken = true; }
      return;
    }
    try { process.stderr.write(`cic: ${stream === process.stdout ? 'stdout' : 'stderr'} failed: ${error && error.message}\n`); } catch { /* nothing left to write to */ }
  });
}
absorbStreamError(process.stdout);
absorbStreamError(process.stderr);

function write(stream, text) {
  return new Promise((resolve, reject) => {
    if (stdoutBroken && stream === process.stdout) { resolve(); return; }
    stream.write(text, (error) => {
      if (!error) { resolve(); return; }
      // The reader went away, as in `cic list | head -1`. Their choice, not a
      // failure of ours, so stop writing and let the exit code stand.
      if (error.code === 'EPIPE') {
        if (stream === process.stdout) { stdoutBroken = true; }
        resolve();
        return;
      }
      reject(error);
    });
  });
}

const writeOut = (text) => write(process.stdout, text);
const writeErr = (text) => write(process.stderr, text);

const envelope = (exitCode, message) => JSON.stringify({
  error: true, kind: KIND[exitCode], exit: exitCode, message,
}) + '\n';

/** The text parts of a tool result, which is where a tool puts its complaint. */
const textOf = (result) => (result.content || [])
  .filter((part) => part && part.type === 'text')
  .map((part) => part.text)
  .join('\n');

// Deliberately not unref'd. An unref'd timer does not hold the event loop open,
// and by the time a retry is waiting the child is dead and its pipes are
// destroyed, so nothing else does either: Node exited cleanly with code 0
// mid-backoff, reporting success for a call that never happened.
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function parseArguments(argv) {
  const options = { timeout: DEFAULT_TIMEOUT_SECONDS, retries: 0, json: false, jsonl: false };
  // Which flags were actually typed, as opposed to left at a default. A command
  // can then refuse one it would silently ignore, rather than exiting 0 having
  // done something other than what was asked.
  const provided = new Set();
  const positional = [];
  // Scanning continues past the first mistake so that `--json` is still seen,
  // and a --json caller gets the error envelope rather than a bare exit code.
  let error = null;
  const note = (message) => { error = error || message; };

  // Never swallow the next token when it is itself a flag: consuming `--json`
  // as a value lost the very flag that decides how the error gets reported.
  const valueFor = (flag, index) => {
    const raw = argv[index + 1];
    if (raw === undefined || raw.startsWith('-')) {
      note(`${flag} wants a value, got ${raw === undefined ? 'nothing' : raw}`);
      return null;
    }
    return raw;
  };

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--json') { options.json = true; provided.add('--json'); }
    else if (argument === '--jsonl') { options.jsonl = true; provided.add('--jsonl'); }
    else if (argument === '-h' || argument === '--help') { options.help = true; }
    else if (argument === '-v' || argument === '--version') { options.version = true; }
    else if (argument === '--timeout') {
      const raw = valueFor('--timeout', i);
      if (raw === null) { continue; }
      i++;
      provided.add('--timeout');
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        note(`--timeout wants a positive number of seconds, got ${raw}`);
      } else {
        options.timeout = value;
      }
    } else if (argument === '--retries') {
      const raw = valueFor('--retries', i);
      if (raw === null) { continue; }
      i++;
      provided.add('--retries');
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        note(`--retries wants a whole number of attempts, got ${raw}`);
      } else {
        options.retries = value;
      }
    } else if (argument.startsWith('-')) {
      note(`unknown option ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  return { options, positional, provided, error };
}

/** Decides what the command means, before anything is spawned. */
function planRequest(positional) {
  const [command, toolName, rawArguments, ...extra] = positional;
  if (command !== 'list' && command !== 'call') {
    throw new UsageError(`unknown command '${command}'. Expected 'list', 'call', 'session' or 'shell'.`);
  }

  if (command === 'list') {
    if (toolName !== undefined) {
      throw new UsageError(`list takes no arguments, got '${toolName}'.`);
    }
    return { command, method: 'tools/list', params: {} };
  }

  if (!toolName) { throw new UsageError('call wants a tool name.'); }
  if (extra.length) {
    throw new UsageError(
      `call takes a tool name and optional JSON arguments, got ${extra.length} extra: '${extra.join("', '")}'.`);
  }
  let toolArguments;
  try {
    toolArguments = JSON.parse(rawArguments === undefined ? '{}' : rawArguments);
  } catch (failure) {
    throw new UsageError(`arguments are not valid JSON: ${failure.message}`);
  }
  if (toolArguments === null || typeof toolArguments !== 'object' || Array.isArray(toolArguments)) {
    throw new UsageError('arguments must be a JSON object.');
  }
  return { command, method: 'tools/call', params: { name: toolName, arguments: toolArguments } };
}

/**
 * One attempt: open a session, make the call, close it. Returns the validated
 * reply, or throws. The session is always closed, including on failure, so a
 * retry never leaves a bridge behind.
 */
async function attempt(plan, options) {
  const session = new BridgeSession({ timeoutSeconds: options.timeout });
  session.clientVersion = VERSION;
  try {
    await session.open();
    return await session.call(plan.method, plan.params);
  } finally {
    await session.close();
  }
}

async function main() {
  const { options, positional, provided, error } = parseArguments(process.argv.slice(2));
  if (error) { throw new UsageError(error); }

  if (options.version) { await writeOut(VERSION + '\n'); return EXIT.OK; }
  if (options.help || positional.length === 0) { await writeOut(USAGE + '\n'); return EXIT.OK; }

  // The streaming commands own their own loop and their own exit meaning, so
  // they return before any of the one-shot machinery below.
  if (positional[0] === 'session' || positional[0] === 'shell') {
    rejectUnsupportedFlags(positional[0], provided);
  }
  if (positional[0] === 'session') {
    if (positional.length > 1) {
      throw new UsageError(`session takes no positional arguments, got '${positional[1]}'.`);
    }
    if (!options.jsonl) {
      throw new UsageError('session needs --jsonl. It is the only protocol it speaks.');
    }
    return runSession({
      timeoutSeconds: options.timeout,
      input: process.stdin,
      output: process.stdout,
      jsonl: true,
    });
  }
  if (positional[0] === 'shell') {
    if (positional.length > 1) {
      throw new UsageError(`shell takes no positional arguments, got '${positional[1]}'.`);
    }
    return runShell({
      timeoutSeconds: options.timeout,
      input: process.stdin,
      output: process.stdout,
    });
  }

  const plan = planRequest(positional);
  rejectUnsupportedFlags(plan.command, provided);

  let reply;
  // Retries are limited to failures that never reached the browser. After
  // dispatch the outcome is unknown, and repeating a click or a script is a
  // second action, not a second look at the first one.
  for (let tries = 0; ; tries++) {
    try {
      reply = await attempt(plan, options);
      break;
    } catch (failure) {
      const retryable = failure instanceof BridgeError && !failure.dispatched;
      if (!retryable || tries >= options.retries) { throw failure; }
      await sleep(Math.min(RETRY_BASE_MS * (2 ** tries), RETRY_MAX_MS));
    }
  }

  if (reply.error) {
    // Guaranteed a string by the session's validation, so the envelope keeps
    // its shape.
    const message = reply.error.message;
    if (options.json) { await writeOut(envelope(EXIT.TOOL_ERROR, message)); }
    else { await writeErr(`cic: ${JSON.stringify(reply.error)}\n`); }
    return EXIT.TOOL_ERROR;
  }

  const result = reply.result;

  if (options.json) {
    // isError is the tool saying it failed, so --json owes the caller the
    // frozen error envelope, not the raw result it would print on success.
    if (result.isError) {
      await writeOut(envelope(EXIT.TOOL_ERROR, textOf(result) || 'the tool reported an error'));
      return EXIT.TOOL_ERROR;
    }
    await writeOut(JSON.stringify(result) + '\n');
    return EXIT.OK;
  }

  // One write rather than one per line: a page-text dump is a single large
  // string, and every await here is a chance to be interrupted.
  const lines = plan.command === 'list'
    ? (result.tools || []).map((tool) => `- ${tool.name} :: ${(tool.description || '').split('\n')[0].slice(0, 80)}`)
    : (result.content || []).map((part) => (part.type === 'text' ? part.text : `[${part.type || '?'}]`));
  if (lines.length) { await writeOut(lines.join('\n') + '\n'); }

  // isError printed its text above, the way the shell version did, but exits
  // non-zero, which the shell version did not: pipelines carried on regardless.
  return result.isError ? EXIT.TOOL_ERROR : EXIT.OK;
}

/**
 * A failure before the request went out can never be UNKNOWN, and one after it
 * can never be TRANSPORT, because the browser may already have acted.
 */
function classify(failure) {
  if (failure instanceof UsageError) { return EXIT.USAGE; }
  if (failure instanceof BridgeError) { return failure.dispatched ? EXIT.UNKNOWN : EXIT.TRANSPORT; }
  return EXIT.TRANSPORT;
}

(async () => {
  let asJson = false;
  try {
    // Parsed twice on the failure path only, so the error formatter knows
    // whether --json was asked for even when parsing itself failed.
    asJson = parseArguments(process.argv.slice(2)).options.json;
    process.exitCode = await main();
  } catch (failure) {
    const exitCode = classify(failure);
    const message = failure instanceof UsageError || failure instanceof BridgeError
      ? failure.message
      : `unexpected failure: ${failure && failure.message}`;
    try {
      if (asJson) { await writeOut(envelope(exitCode, message)); }
      else { await writeErr(`cic: ${message}\n`); }
    } catch { /* the caller closed the stream; the exit code still stands */ }
    process.exitCode = exitCode;
  }
})();
