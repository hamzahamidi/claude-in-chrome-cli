#!/usr/bin/env node
// cic - call Claude in Chrome MCP tools from the shell, without an MCP client.
//
// Claude Code ships a stdio MCP server, `claude --claude-in-chrome-mcp`, that
// bridges to the Claude in Chrome extension and drives your real, logged-in
// browser. This negotiates the MCP handshake over stdio, calls one tool, prints
// the result, and exits.
'use strict';

const { spawn } = require('child_process');

const VERSION = '0.4.0';
const CLIENT_PROTOCOL = '2024-11-05';
// Versions whose handshake this client understands. A server answering with
// anything else has not agreed a protocol, so the request is never sent.
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const DEFAULT_TIMEOUT_SECONDS = 30;
// How long a terminated child gets to leave before SIGKILL. A child that
// ignores SIGTERM would otherwise outlive every call and accumulate.
const TERMINATE_GRACE_MS = 2000;

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

Options:
  --timeout <secs>   ceiling on how long to wait for the reply (default ${DEFAULT_TIMEOUT_SECONDS})
  --json             print the raw result object, or one error object, on one line
  -h, --help         this text
  -v, --version      print the version

Examples:
  cic list
  cic call navigate '{"url":"https://example.com"}'
  cic call get_page_text '{}' --timeout 60
  cic call computer '{"action":"screenshot"}' --json

Exit codes:
  0   success
  1   the tool reported an error
  2   outcome unknown: the request was sent and no usable reply came back
  3   failed before the request was sent, so the browser cannot have acted
  64  usage error, or invalid arguments JSON`;

class CicError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

// Nothing here calls process.exit() after writing. Writing to a pipe is
// asynchronous, and exiting discards whatever has not drained yet, which
// truncated a large page-text result at the pipe buffer boundary. Every path
// awaits its write and sets process.exitCode instead, letting Node leave once
// the streams are empty.
let stdoutBroken = false;

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

/**
 * A failure before the request went out can never be UNKNOWN, and one after it
 * can never be TRANSPORT, because the browser may already have acted. USAGE and
 * TOOL_ERROR are decided explicitly and pass through untouched.
 */
function normalizeExit(exitCode, requestWritten) {
  if (exitCode === EXIT.USAGE || exitCode === EXIT.TOOL_ERROR) { return exitCode; }
  return requestWritten ? EXIT.UNKNOWN : EXIT.TRANSPORT;
}

/** SIGTERM, then SIGKILL if that is ignored, and wait for the child to go. */
function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const escalate = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, TERMINATE_GRACE_MS);
    // Never hang a caller on a child that cannot be reaped at all.
    const giveUp = setTimeout(resolve, TERMINATE_GRACE_MS * 2);
    const done = () => { clearTimeout(escalate); clearTimeout(giveUp); resolve(); };
    child.once('close', done);
    try { child.stdin.destroy(); } catch { /* already closed */ }
    try { child.kill('SIGTERM'); } catch { done(); }
  });
}

function parseArguments(argv) {
  const options = { timeout: DEFAULT_TIMEOUT_SECONDS, json: false };
  const positional = [];
  // Scanning continues past the first mistake so that `--json` is still seen,
  // and a --json caller gets the error envelope rather than a bare exit code.
  let error = null;
  const note = (message) => { error = error || message; };

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--json') { options.json = true; }
    else if (argument === '-h' || argument === '--help') { options.help = true; }
    else if (argument === '-v' || argument === '--version') { options.version = true; }
    else if (argument === '--timeout') {
      const raw = argv[++i];
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        note(`--timeout wants a positive number of seconds, got ${raw}`);
      } else {
        options.timeout = value;
      }
    } else if (argument.startsWith('-')) {
      note(`unknown option ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  return { options, positional, error };
}

/** Resolves once the reply to `id` arrives, or rejects with a CicError. */
function requestReply(child, id, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const onLine = (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== id) { return; }
      finish(resolve, message);
    };

    // A line-oriented reader that also flushes what is left when the stream
    // ends: a reply split across chunks by a child that exits immediately
    // afterwards would otherwise read as no reply at all.
    const consume = (text, isFinal) => {
      buffer += text;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) { onLine(line); }
      }
      if (isFinal && buffer.trim()) { onLine(buffer.trim()); }
    };

    const timer = setTimeout(() => {
      finish(reject, new CicError(EXIT.UNKNOWN,
        `no reply within ${timeoutSeconds}s. Raise --timeout, or check that the Claude in Chrome extension is connected.`));
    }, timeoutSeconds * 1000);

    child.stdout.on('data', (chunk) => consume(String(chunk), false));
    child.stdout.on('end', () => consume('', true));
    child.on('exit', (code) => {
      // Let the final stdout chunk land before calling this no reply.
      setImmediate(() => finish(reject, new CicError(EXIT.UNKNOWN,
        `the bridge exited (code ${code}) before a usable reply arrived.`)));
    });
    child.on('error', (error) => {
      finish(reject, new CicError(EXIT.UNKNOWN, `bridge failed: ${error.message}`));
    });
  });
}

async function main(ctx) {
  const { options, positional, error } = parseArguments(process.argv.slice(2));
  // Recorded before anything can fail, so the error path knows how to format.
  ctx.json = options.json;
  // Usage is decided entirely before spawning, so a malformed call can never
  // race with a transport failure for the exit code.
  if (error) { throw new CicError(EXIT.USAGE, error); }

  if (options.version) { await writeOut(VERSION + '\n'); return EXIT.OK; }
  if (options.help || positional.length === 0) { await writeOut(USAGE + '\n'); return EXIT.OK; }

  const [command, toolName, rawArguments, ...extra] = positional;
  if (command !== 'list' && command !== 'call') {
    throw new CicError(EXIT.USAGE, `unknown command '${command}'. Expected 'list' or 'call'.`);
  }

  let method = 'tools/list';
  let params = {};
  if (command === 'list') {
    if (toolName !== undefined) {
      throw new CicError(EXIT.USAGE, `list takes no arguments, got '${toolName}'.`);
    }
  } else {
    if (!toolName) { throw new CicError(EXIT.USAGE, 'call wants a tool name.'); }
    if (extra.length) {
      throw new CicError(EXIT.USAGE,
        `call takes a tool name and optional JSON arguments, got ${extra.length} extra: '${extra.join("', '")}'.`);
    }
    let toolArguments;
    try {
      toolArguments = JSON.parse(rawArguments === undefined ? '{}' : rawArguments);
    } catch (failure) {
      throw new CicError(EXIT.USAGE, `arguments are not valid JSON: ${failure.message}`);
    }
    if (toolArguments === null || typeof toolArguments !== 'object' || Array.isArray(toolArguments)) {
      throw new CicError(EXIT.USAGE, 'arguments must be a JSON object.');
    }
    method = 'tools/call';
    params = { name: toolName, arguments: toolArguments };
  }

  const binary = process.env.CIC_CLAUDE_BIN || 'claude';
  const binaryArguments = process.env.CIC_CLAUDE_ARGS
    ? process.env.CIC_CLAUDE_ARGS.split(' ').filter(Boolean)
    : ['--claude-in-chrome-mcp'];

  try {
    ctx.child = spawn(binary, binaryArguments, { stdio: ['pipe', 'pipe', 'inherit'] });
  } catch (failure) {
    throw new CicError(EXIT.TRANSPORT, `could not start ${binary}: ${failure.message}`);
  }
  const child = ctx.child;

  const write1 = (object) => new Promise((resolve, reject) => {
    child.stdin.write(JSON.stringify(object) + '\n', (failure) => {
      if (failure) { reject(new CicError(EXIT.TRANSPORT, `could not reach ${binary}: ${failure.message}`)); }
      else { resolve(); }
    });
  });

  // A failed write only ever reports a broken pipe. The child's own error
  // event carries the reason the pipe broke (`spawn ... ENOENT` for a missing
  // binary), and the pending reply promise is what surfaces it, so on a write
  // failure let that promise speak first.
  const send = async (object, pending) => {
    try {
      await write1(object);
    } catch (writeFailure) {
      await pending;
      throw writeFailure;
    }
  };

  // 1. initialize, and wait for the response before anything else. cic.sh sent
  //    all three messages in one burst, which the specification forbids.
  const initializePromise = requestReply(child, 1, options.timeout);
  // Whichever error wins the race below, the loser must still count as handled
  // or Node kills the process on the late rejection with a stack trace.
  initializePromise.catch(() => {});
  await send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: CLIENT_PROTOCOL, capabilities: {},
      clientInfo: { name: 'cic', version: VERSION },
    },
  }, initializePromise);
  const initialized = await initializePromise;

  if (initialized.error) {
    throw new CicError(EXIT.TRANSPORT,
      `the bridge refused the handshake: ${JSON.stringify(initialized.error)}`);
  }
  const agreed = initialized.result && initialized.result.protocolVersion;
  if (!SUPPORTED_PROTOCOLS.has(agreed)) {
    throw new CicError(EXIT.TRANSPORT,
      `the bridge answered with unsupported protocol version ${JSON.stringify(agreed)}.`);
  }

  // 2. Only now is the session initialized, so the request may go out.
  const replyPromise = requestReply(child, 2, options.timeout);
  replyPromise.catch(() => {});
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, replyPromise);
  await send({ jsonrpc: '2.0', id: 2, method, params }, replyPromise);
  // Everything from here is post-dispatch: the browser may have acted, so no
  // failure below may report TRANSPORT.
  ctx.requestWritten = true;

  const reply = await replyPromise;

  if (reply.error) {
    const message = (reply.error && reply.error.message) || 'the tool reported an error';
    if (options.json) { await writeOut(envelope(EXIT.TOOL_ERROR, message)); }
    else { await writeErr(`cic: ${JSON.stringify(reply.error)}\n`); }
    return EXIT.TOOL_ERROR;
  }

  // A reply carrying neither result nor error agreed to nothing. Reporting
  // success on it would be the shell version's bug in a new place.
  const result = reply.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new CicError(EXIT.UNKNOWN,
      'the bridge replied without a result, so the outcome is unknown.');
  }

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
  const lines = command === 'list'
    ? (result.tools || []).map((tool) => `- ${tool.name} :: ${(tool.description || '').split('\n')[0].slice(0, 80)}`)
    : (result.content || []).map((part) => (part.type === 'text' ? part.text : `[${part.type || '?'}]`));
  if (lines.length) { await writeOut(lines.join('\n') + '\n'); }

  // isError printed its text above, the way the shell version did, but exits
  // non-zero, which the shell version did not: pipelines carried on regardless.
  return result.isError ? EXIT.TOOL_ERROR : EXIT.OK;
}

(async () => {
  const ctx = { json: false, child: null, requestWritten: false };
  try {
    process.exitCode = await main(ctx);
  } catch (failure) {
    const claimed = failure instanceof CicError ? failure.exitCode : EXIT.TRANSPORT;
    const message = failure instanceof CicError
      ? failure.message
      : `unexpected failure: ${failure && failure.message}`;
    const exitCode = normalizeExit(claimed, ctx.requestWritten);
    try {
      if (ctx.json) { await writeOut(envelope(exitCode, message)); }
      else { await writeErr(`cic: ${message}\n`); }
    } catch { /* the caller closed the stream; the exit code still stands */ }
    process.exitCode = exitCode;
  } finally {
    await terminate(ctx.child);
  }
})();
