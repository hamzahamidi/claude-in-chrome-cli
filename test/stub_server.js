#!/usr/bin/env node
// A scripted stdio MCP server, standing in for `claude --claude-in-chrome-mcp`.
//
// CIC_STUB_MODE selects the misbehaviour under test. Every mode here maps to one
// branch of the exit-code contract, so the CLI's cases and this file's cases are
// meant to stay one-to-one.
'use strict';

const mode = process.env.CIC_STUB_MODE || 'ok';
const delayMs = Number(process.env.CIC_STUB_DELAY_MS || 0);
const protocolVersion = process.env.CIC_STUB_PROTOCOL || '2024-11-05';
const capture = process.env.CIC_STUB_CAPTURE;

const send = (object) => process.stdout.write(JSON.stringify(object) + '\n');
const captured = [];

const initializeResult = (id) => ({
  jsonrpc: '2.0',
  id,
  result: {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: 'stub', version: '0.0.0' },
  },
});

const toolsListResult = (id) => ({
  jsonrpc: '2.0',
  id,
  result: {
    tools: [
      { name: 'navigate', description: 'Navigate to a URL.\nSecond line ignored.' },
      { name: 'get_page_text', description: 'Read the page text.' },
    ],
  },
});

const callResult = (id) => ({
  jsonrpc: '2.0',
  id,
  result: { content: [{ type: 'text', text: 'stub replied' }] },
});

// Well past a pipe buffer, which is where output used to be cut off.
const BIG_BYTES = 1024 * 1024;

function replyTo(message) {
  const { id, method } = message;
  // A notification carries no id and must never be answered.
  if (id === undefined) { return; }

  if (method === 'initialize') {
    if (mode === 'no-initialize-reply') { return; }
    send(initializeResult(id));
    return;
  }

  // Anything past initialize is the request the exit 2 / exit 3 split turns on.
  if (mode === 'exit-early') { process.exit(7); }

  if (mode === 'malformed') {
    process.stdout.write('this is not json\n');
    return;
  }

  if (mode === 'split') {
    // The reply arrives in two chunks and the child exits straight after, so a
    // reader that only parses on newline must still flush its buffer.
    const line = JSON.stringify(callResult(id));
    process.stdout.write(line.slice(0, 12));
    setTimeout(() => {
      process.stdout.write(line.slice(12) + '\n');
      setTimeout(() => process.exit(0), 20);
    }, 20);
    return;
  }

  if (mode === 'tool-error') {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'tool blew up' } });
    return;
  }

  if (mode === 'is-error') {
    send({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: 'the tool refused' }], isError: true },
    });
    return;
  }

  if (mode === 'never-reply') { return; }

  // A result far larger than a pipe buffer. Truncation here is silent data
  // loss, and page text is exactly what people pipe out of this tool.
  if (mode === 'big') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'x'.repeat(BIG_BYTES) }] } });
    return;
  }

  // A reply that agreed to nothing: neither result nor error. Reporting success
  // on this is the shell version's exit-0-on-failure bug in a new place.
  if (mode === 'no-result') {
    send({ jsonrpc: '2.0', id });
    return;
  }

  // Valid JSON that is not a message. Dereferencing it threw an uncaught
  // TypeError straight out of the client's stream handler.
  if (mode === 'null-reply') {
    process.stdout.write('null\n');
    return;
  }

  // Addressed to the right request but not in a JSON-RPC 2.0 envelope, which
  // used to be accepted and reported as a success.
  if (mode === 'no-envelope') {
    process.stdout.write(JSON.stringify({ id, result: { content: [{ type: 'text', text: 'unenveloped' }] } }) + '\n');
    return;
  }

  // An error whose message is not a string. This went into the frozen envelope
  // verbatim, so `message` came out as a number.
  if (mode === 'numeric-error-message') {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: 42 } });
    return;
  }

  // Both halves at once, which JSON-RPC forbids: choosing either is guessing.
  if (mode === 'result-and-error') {
    send({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: 'succeeded' }] },
      error: { code: -1, message: 'and also failed' },
    });
    return;
  }

  // A result with none of the arrays its method requires. This printed nothing
  // and exited 0, which reads as an empty page rather than a broken reply.
  if (mode === 'empty-result') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  // The array is there and empty, which is a real answer: a page with no text
  // content must not be confused with a reply that never got filled in.
  if (mode === 'empty-content') {
    send({ jsonrpc: '2.0', id, result: { content: [] } });
    return;
  }

  // Replies, then exits, leaving a detached descendant holding its stdout. That
  // pipe alone used to keep the client alive forever.
  if (mode === 'linger') {
    const readyFile = process.env.CIC_STUB_READY;
    const { spawn, spawnSync } = require('child_process');
    // The descendant reports its own pid, which proves it is running and gives
    // the test something to kill. It also gives up on its own: a detached
    // process that only a passing test cleans up is a process that leaks every
    // time the test does not reach its cleanup, which is how three immortal
    // node processes ended up on the machine this was written on.
    const holder = "require('fs').writeFileSync(process.env.R, String(process.pid));"
      + 'setTimeout(() => process.exit(0), 20000).unref();'
      + 'setInterval(() => {}, 1000);';
    spawn(process.execPath, ['-e', holder], {
      stdio: ['ignore', 1, 'ignore'],
      detached: true,
      env: { ...process.env, R: readyFile },
    }).unref();
    // Do not exit before the descendant is actually holding the pipe.
    while (!require('fs').existsSync(readyFile)) { spawnSync(process.execPath, ['-e', '']); }
    send(callResult(id));
    setTimeout(() => process.exit(0), 30);
    return;
  }

  const reply = method === 'tools/list' ? toolsListResult(id) : callResult(id);
  if (delayMs) { setTimeout(() => send(reply), delayMs); } else { send(reply); }
}

if (mode === 'spawn-failure') { process.exit(9); }
if (mode === 'stderr') { process.stderr.write('stub: the extension is not connected\n'); }

// A child that refuses SIGTERM and never replies, to prove the client escalates
// rather than leaving one of these behind on every call.
if (mode === 'ignore-sigterm') {
  process.on('SIGTERM', () => {});
  if (process.env.CIC_STUB_PIDFILE) {
    require('fs').writeFileSync(process.env.CIC_STUB_PIDFILE, String(process.pid));
  }
  setInterval(() => {}, 1000);
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) { continue; }
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    captured.push(message);
    if (capture) {
      require('fs').writeFileSync(capture, captured.map(m => JSON.stringify(m)).join('\n'));
    }
    replyTo(message);
  }
});

process.stdin.on('end', () => {
  if (mode !== 'never-reply' && mode !== 'no-initialize-reply') { process.exit(0); }
});
