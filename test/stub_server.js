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
