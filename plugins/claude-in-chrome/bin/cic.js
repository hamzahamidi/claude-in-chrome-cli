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

/** Prints one frozen-shape error line for --json callers, or a human message. */
function fail(exitCode, message, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify({
      error: true, kind: KIND[exitCode], exit: exitCode, message,
    }) + '\n');
  } else {
    process.stderr.write(`cic: ${message}\n`);
  }
  process.exit(exitCode);
}

function parseArguments(argv) {
  const options = { timeout: DEFAULT_TIMEOUT_SECONDS, json: false };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--json') { options.json = true; }
    else if (argument === '-h' || argument === '--help') { options.help = true; }
    else if (argument === '-v' || argument === '--version') { options.version = true; }
    else if (argument === '--timeout') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        return { error: `--timeout wants a positive number of seconds, got ${argv[i]}` };
      }
      options.timeout = value;
    } else if (argument.startsWith('-')) {
      return { error: `unknown option ${argument}` };
    } else { positional.push(argument); }
  }
  return { options, positional };
}

/** Resolves once the reply to `id` arrives, or rejects with a contract-shaped error. */
function requestReply(child, id, timeoutSeconds, onLine) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    // A line-oriented reader that also flushes what is left when the stream ends:
    // a reply split across chunks by a child that exits immediately afterwards
    // would otherwise read as no reply at all.
    const consume = (text, isFinal) => {
      buffer += text;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) { onLine(line, finish, resolve); }
      }
      if (isFinal && buffer.trim()) { onLine(buffer.trim(), finish, resolve); }
    };

    const timer = setTimeout(() => {
      finish(reject, { exit: EXIT.UNKNOWN, message:
        `no reply within ${timeoutSeconds}s. Raise --timeout, or check that the Claude in Chrome extension is connected.` });
    }, timeoutSeconds * 1000);

    child.stdout.on('data', (chunk) => consume(String(chunk), false));
    child.stdout.on('end', () => consume('', true));
    child.on('exit', (code) => {
      setImmediate(() => finish(reject, { exit: EXIT.UNKNOWN, message:
        `the bridge exited (code ${code}) before a usable reply arrived.` }));
    });
    child.on('error', (error) => {
      finish(reject, { exit: EXIT.UNKNOWN, message: `bridge failed: ${error.message}` });
    });
  });
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  // Usage is decided entirely before spawning, so a malformed call can never
  // race with a transport failure for the exit code.
  if (parsed.error) { fail(EXIT.USAGE, parsed.error, false); }
  const { options, positional } = parsed;

  if (options.version) { process.stdout.write(VERSION + '\n'); return; }
  if (options.help || positional.length === 0) { process.stdout.write(USAGE + '\n'); return; }

  const command = positional[0];
  if (command !== 'list' && command !== 'call') {
    fail(EXIT.USAGE, `unknown command '${command}'. Expected 'list' or 'call'.`, options.json);
  }

  let method = 'tools/list';
  let params = {};
  if (command === 'call') {
    const toolName = positional[1];
    if (!toolName) { fail(EXIT.USAGE, "call wants a tool name.", options.json); }
    const rawArguments = positional[2] === undefined ? '{}' : positional[2];
    let toolArguments;
    try { toolArguments = JSON.parse(rawArguments); }
    catch (error) {
      fail(EXIT.USAGE, `arguments are not valid JSON: ${error.message}`, options.json);
    }
    if (toolArguments === null || typeof toolArguments !== 'object' || Array.isArray(toolArguments)) {
      fail(EXIT.USAGE, 'arguments must be a JSON object.', options.json);
    }
    method = 'tools/call';
    params = { name: toolName, arguments: toolArguments };
  }

  const binary = process.env.CIC_CLAUDE_BIN || 'claude';
  const binaryArguments = process.env.CIC_CLAUDE_ARGS
    ? process.env.CIC_CLAUDE_ARGS.split(' ').filter(Boolean)
    : ['--claude-in-chrome-mcp'];

  let child;
  try {
    child = spawn(binary, binaryArguments, { stdio: ['pipe', 'pipe', 'inherit'] });
  } catch (error) {
    fail(EXIT.TRANSPORT, `could not start ${binary}: ${error.message}`, options.json);
  }

  // Every failure below branches on this, not on the error's shape.
  let requestWritten = false;

  const write = (object) => new Promise((resolve, reject) => {
    child.stdin.write(JSON.stringify(object) + '\n', (error) => error ? reject(error) : resolve());
  });

  const abort = (exitCode, message) => {
    child.kill();
    fail(requestWritten ? EXIT.UNKNOWN : exitCode, message, options.json);
  };

  child.on('error', (error) => {
    abort(EXIT.TRANSPORT, `could not start ${binary}: ${error.message}`);
  });

  try {
    // 1. initialize, and wait for the response before anything else. cic.sh sent
    //    all three messages in one burst, which the specification forbids.
    const initializePromise = requestReply(child, 1, options.timeout, (line, finish, resolve) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== 1) { return; }
      finish(resolve, message);
    });
    await write({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: CLIENT_PROTOCOL, capabilities: {},
        clientInfo: { name: 'cic', version: VERSION },
      },
    });
    const initialized = await initializePromise;

    if (initialized.error) {
      abort(EXIT.TRANSPORT, `the bridge refused the handshake: ${JSON.stringify(initialized.error)}`);
    }
    const agreed = initialized.result && initialized.result.protocolVersion;
    if (!SUPPORTED_PROTOCOLS.has(agreed)) {
      abort(EXIT.TRANSPORT, `the bridge answered with unsupported protocol version ${JSON.stringify(agreed)}.`);
    }

    // 2. Only now is the session initialized, so the request may go out.
    const replyPromise = requestReply(child, 2, options.timeout, (line, finish, resolve) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== 2) { return; }
      finish(resolve, message);
    });
    await write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await write({ jsonrpc: '2.0', id: 2, method, params });
    requestWritten = true;

    const reply = await replyPromise;
    child.kill();

    if (reply.error) {
      if (options.json) {
        process.stdout.write(JSON.stringify({
          error: true, kind: KIND[EXIT.TOOL_ERROR], exit: EXIT.TOOL_ERROR,
          message: reply.error.message || 'the tool reported an error',
        }) + '\n');
      } else {
        process.stderr.write(`cic: ${JSON.stringify(reply.error)}\n`);
      }
      process.exit(EXIT.TOOL_ERROR);
    }

    const result = reply.result || {};
    if (options.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else if (command === 'list') {
      for (const tool of result.tools || []) {
        const firstLine = (tool.description || '').split('\n')[0];
        process.stdout.write(`- ${tool.name} :: ${firstLine.slice(0, 80)}\n`);
      }
    } else {
      for (const part of result.content || []) {
        process.stdout.write((part.type === 'text' ? part.text : `[${part.type || '?'}]`) + '\n');
      }
    }

    // isError is the tool saying it failed, which the shell version printed and
    // then exited 0 on, so pipelines carried on after a failure.
    process.exit(result.isError ? EXIT.TOOL_ERROR : EXIT.OK);
  } catch (failure) {
    if (failure && failure.exit) {
      abort(failure.exit === EXIT.UNKNOWN && !requestWritten ? EXIT.TRANSPORT : failure.exit, failure.message);
    }
    abort(EXIT.TRANSPORT, `unexpected failure: ${failure && failure.message}`);
  }
}

main();
