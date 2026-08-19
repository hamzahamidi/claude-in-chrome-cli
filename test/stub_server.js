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
    // Hostile handshakes. Each is pre-dispatch, so each must be exit 3: the
    // request never goes out, so the browser cannot have acted.
    if (mode === 'initialize-no-protocol') {
      send({ jsonrpc: '2.0', id, result: { capabilities: {}, serverInfo: { name: 's', version: '0' } } });
      return;
    }
    if (mode === 'initialize-numeric-protocol') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: 20241105, capabilities: {} } });
      return;
    }
    if (mode === 'initialize-both') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: protocolVersion }, error: { code: -1, message: 'both' } });
      return;
    }
    if (mode === 'initialize-bad-error-code') {
      send({ jsonrpc: '2.0', id, error: { code: 'not-an-integer', message: 'refused' } });
      return;
    }
    if (mode === 'initialize-error') {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'handshake refused' } });
      return;
    }
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

  // The tab lifecycle. withTab needs three tools to answer differently within
  // one session, which no single-reply mode can express, so these dispatch on
  // the tool name. What the test reads back is the capture file: it is the only
  // way to prove from outside whether the close actually happened, which is the
  // behaviour the fail-closed rule is about.
  if (mode.startsWith('tabs-')) {
    const name = (message.params || {}).name;
    const ok = (text) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    const refuse = (text) => send({
      jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true },
    });

    // A JSON-RPC error, as opposed to a result carrying isError. Both mean the
    // browser answered and said no, and reading `.result` without checking
    // `.error` first made these throw a TypeError that surfaced as exit 3.
    const rpcError = (message) => send({
      jsonrpc: '2.0', id, error: { code: -32000, message },
    });

    if (name === 'tabs_create_mcp') {
      if (mode === 'tabs-no-id') { ok('Created new tab.'); return; }
      if (mode === 'tabs-create-error') { refuse('no tab available'); return; }
      if (mode === 'tabs-create-rpc-error') { rpcError('create blew up'); return; }
      ok('Created new tab. Tab ID: 4242');
      return;
    }
    if (name === 'navigate') {
      if (mode === 'tabs-navigate-error' || mode === 'tabs-navigate-and-close-error') {
        refuse('that url is blocked');
        return;
      }
      if (mode === 'tabs-navigate-rpc-error') { rpcError('navigate blew up'); return; }
      ok('Navigated to the url');
      return;
    }
    if (name === 'tabs_close_mcp') {
      if (mode === 'tabs-close-error' || mode === 'tabs-navigate-and-close-error') {
        refuse('that tab is gone already');
        return;
      }
      if (mode === 'tabs-close-rpc-error') { rpcError('close blew up'); return; }
      ok('Closed tab 4242. 0 tab(s) remain.');
      return;
    }
    // Whatever the caller asked for inside the tab.
    if (mode === 'tabs-body-unknown') { return; }
    if (mode === 'tabs-body-error') { refuse('the body tool refused'); return; }
    ok('body ran against tab 4242');
    return;
  }

  // Image results, for --output. These are whole files rather than a magic
  // header with filler after it: a header plus filler is exactly what an
  // incomplete transfer produces, so using it as the valid fixture would have
  // asserted the opposite of the guarantee.
  if (mode.startsWith('image-')) {
    const { PNG_1x1, JPEG, GIF, WEBP } = require('./fixtures/images.js');
    const part = (extra) => ({ type: 'image', ...extra });
    const reply = (content) => send({ jsonrpc: '2.0', id, result: { content } });

    if (mode === 'image-png') {
      reply([{ type: 'text', text: 'here is the shot' }, part({ data: PNG_1x1.toString('base64'), mimeType: 'image/png' })]);
      return;
    }
    if (mode === 'image-unlabelled') { reply([part({ data: PNG_1x1.toString('base64') })]); return; }
    if (mode === 'image-jpeg') { reply([part({ data: JPEG.toString('base64'), mimeType: 'image/jpeg' })]); return; }
    if (mode === 'image-gif') { reply([part({ data: GIF.toString('base64') })]); return; }
    if (mode === 'image-webp') { reply([part({ data: WEBP.toString('base64') })]); return; }
    if (mode === 'image-jpeg-labelled-png') {
      reply([part({ data: JPEG.toString('base64'), mimeType: 'image/png' })]);
      return;
    }
    if (mode === 'image-truncated') {
      // Base64 whose length is not a multiple of four: a cut-off encoding,
      // which Node's decoder accepts without complaint.
      reply([part({ data: PNG_1x1.toString('base64').slice(0, 41), mimeType: 'image/png' })]);
      return;
    }
    if (mode === 'image-truncated-cleanly') {
      // The harder case, and the one that got through. The image itself is cut
      // short and then encoded properly, so the base64 is valid, its length
      // divides by four and the PNG signature is intact. Only looking for the
      // end of the format catches this.
      reply([part({ data: PNG_1x1.subarray(0, PNG_1x1.length - 12).toString('base64'), mimeType: 'image/png' })]);
      return;
    }
    if (mode === 'image-webp-short-riff') {
      // RIFF states its own payload length; here it claims more than arrived.
      const lying = Buffer.from(WEBP);
      lying.writeUInt32LE(lying.length + 100, 4);
      reply([part({ data: lying.toString('base64') })]);
      return;
    }
    if (mode === 'image-not-base64') { reply([part({ data: 'not base64 at all!!', mimeType: 'image/png' })]); return; }
    if (mode === 'image-no-data') { reply([part({ mimeType: 'image/png' })]); return; }
    if (mode === 'image-garbage') {
      reply([part({ data: Buffer.alloc(40, 3).toString('base64'), mimeType: 'image/png' })]);
      return;
    }
    if (mode === 'image-two') {
      reply([part({ data: PNG_1x1.toString('base64') }), part({ data: PNG_1x1.toString('base64') })]);
      return;
    }
    if (mode === 'image-none') { reply([{ type: 'text', text: 'no picture here' }]); return; }
    if (mode === 'image-is-error') {
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: 'the tool refused' }], isError: true },
      });
      return;
    }
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

  // An error code that is a number but not an integer. JSON-RPC requires an
  // integer, and 1.5 means nothing to a caller branching on it.
  if (mode === 'noninteger-error-code') {
    send({ jsonrpc: '2.0', id, error: { code: 1.5, message: 'fractional code' } });
    return;
  }

  // isError decides the exit code, so a non-boolean would make success depend
  // on JavaScript truthiness rather than on what the tool said.
  if (mode === 'nonboolean-is-error') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ambiguous' }], isError: 'yes' } });
    return;
  }

  // Members of the arrays, which used to be free to be anything once the array
  // itself existed. The plain and --json paths disagreed about these.
  if (mode === 'content-part-not-object') {
    send({ jsonrpc: '2.0', id, result: { content: ['just a string'] } });
    return;
  }

  if (mode === 'content-part-no-type') {
    send({ jsonrpc: '2.0', id, result: { content: [{ text: 'typeless' }] } });
    return;
  }

  if (mode === 'text-part-without-text') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text' }] } });
    return;
  }

  // A tool whose description is present but not a string. The array and the
  // names are fine, so only member validation catches this.
  if (mode === 'tool-bad-description') {
    send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'navigate', description: 42 }] } });
    return;
  }

  // A complete reply with no trailing newline, then end of stream. The reader
  // has to flush what is left in its buffer or this reads as no reply at all.
  if (mode === 'no-trailing-newline') {
    process.stdout.write(JSON.stringify(callResult(id)));
    setTimeout(() => process.exit(0), 30);
    return;
  }

  if (mode === 'tool-without-name') {
    send({ jsonrpc: '2.0', id, result: { tools: [{ description: 'nameless' }] } });
    return;
  }

  if (mode === 'tool-entry-not-object') {
    send({ jsonrpc: '2.0', id, result: { tools: ['navigate'] } });
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

// Fails the handshake a fixed number of times, then succeeds, by counting
// attempts in a file across separate stub processes. Proves --retries actually
// retries, and that it stops once a call goes through.
if (mode === 'flaky-handshake') {
  const fs = require('fs');
  const file = process.env.CIC_STUB_ATTEMPTS;
  const failures = Number(process.env.CIC_STUB_FAIL_TIMES || 1);
  let seen = 0;
  try { seen = Number(fs.readFileSync(file, 'utf8')) || 0; } catch { seen = 0; }
  fs.writeFileSync(file, String(seen + 1));
  // Exit before answering initialize: pre-dispatch, so exit 3 and retryable.
  if (seen < failures) { process.exit(4); }
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
