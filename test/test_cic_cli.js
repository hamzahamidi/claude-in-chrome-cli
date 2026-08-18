#!/usr/bin/env node
// Freezes the 0.4.0 exit-code contract and the --json error shape. Runs offline
// against test/stub_server.js; no Chrome, no extension, no `claude` binary.
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HERE = __dirname;
const CIC = path.join(HERE, '..', 'plugins', 'claude-in-chrome', 'bin', 'cic.js');
const STUB = path.join(HERE, 'stub_server.js');

let failures = 0;

function run(args, { mode = 'ok', env = {}, timeoutSeconds } = {}) {
  const argv = [CIC, ...args];
  if (timeoutSeconds) { argv.push('--timeout', String(timeoutSeconds)); }
  return spawnSync(process.execPath, argv, {
    encoding: 'utf8',
    env: {
      ...process.env,
      CIC_CLAUDE_BIN: process.execPath,
      CIC_CLAUDE_ARGS: STUB,
      CIC_STUB_MODE: mode,
      ...env,
    },
  });
}

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) { failures++; }
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}

// ---- exit codes -----------------------------------------------------------

check('list succeeds', run(['list']).status, 0);
check('call succeeds', run(['call', 'navigate', '{"url":"https://example.com"}']).status, 0);

check('a JSON-RPC error is a tool error',
  run(['call', 'navigate', '{}'], { mode: 'tool-error' }).status, 1);
check('isError true is a tool error, not a success',
  run(['call', 'navigate', '{}'], { mode: 'is-error' }).status, 1);

check('a child that dies after the request is unknown',
  run(['call', 'navigate', '{}'], { mode: 'exit-early' }).status, 2);
check('no reply before the ceiling is unknown',
  run(['call', 'navigate', '{}'], { mode: 'never-reply', timeoutSeconds: 1 }).status, 2);
check('a malformed reply is unknown',
  run(['call', 'navigate', '{}'], { mode: 'malformed', timeoutSeconds: 1 }).status, 2);

check('a missing binary is transport, before the request',
  run(['call', 'navigate', '{}'], { env: { CIC_CLAUDE_BIN: '/nonexistent/claude' } }).status, 3);
check('a handshake that never answers is transport',
  run(['call', 'navigate', '{}'], { mode: 'no-initialize-reply', timeoutSeconds: 1 }).status, 3);
check('an unsupported protocol version is transport',
  run(['call', 'navigate', '{}'], { mode: 'ok', env: { CIC_STUB_PROTOCOL: '1999-01-01' } }).status, 3);

check('invalid arguments JSON is a usage error',
  run(['call', 'navigate', '{not json}']).status, 64);
check('non-object arguments are a usage error',
  run(['call', 'navigate', '[1,2]']).status, 64);
check('an unknown command is a usage error', run(['wat']).status, 64);
check('a bad --timeout is a usage error',
  run(['call', 'navigate', '{}', '--timeout', 'soon']).status, 64);

// Usage is settled before spawning, so garbage JSON wins over a missing binary
// rather than racing it.
check('usage beats transport when both are wrong',
  run(['call', 'navigate', '{oops}'], { env: { CIC_CLAUDE_BIN: '/nonexistent/claude' } }).status, 64);

// ---- the adaptive reader --------------------------------------------------

// The reply arrives split across chunks and the child exits immediately after.
// A reader that only parses on newline would call this no reply at all.
check('a reply split across chunks still counts',
  run(['call', 'navigate', '{}'], { mode: 'split' }).status, 0);

// ---- the --json error shape -----------------------------------------------

function jsonLine(result) {
  try { return JSON.parse(result.stdout.trim().split('\n').pop()); } catch { return null; }
}

const toolErrorJson = jsonLine(run(['call', 'navigate', '{}', '--json'], { mode: 'tool-error' }));
check('--json tool error kind', toolErrorJson && toolErrorJson.kind, 'tool_error');
check('--json tool error exit', toolErrorJson && toolErrorJson.exit, 1);
check('--json tool error flag', toolErrorJson && toolErrorJson.error, true);

const unknownJson = jsonLine(run(['call', 'navigate', '{}', '--json'], { mode: 'never-reply', timeoutSeconds: 1 }));
check('--json unknown kind', unknownJson && unknownJson.kind, 'unknown_outcome');
check('--json unknown exit', unknownJson && unknownJson.exit, 2);

const transportJson = jsonLine(run(['call', 'navigate', '{}', '--json'], { env: { CIC_CLAUDE_BIN: '/nonexistent/claude' } }));
check('--json transport kind', transportJson && transportJson.kind, 'transport');
check('--json transport exit', transportJson && transportJson.exit, 3);

const usageJson = jsonLine(run(['call', 'navigate', '{bad}', '--json']));
check('--json usage kind', usageJson && usageJson.kind, 'usage');
check('--json usage exit', usageJson && usageJson.exit, 64);

const okJson = jsonLine(run(['call', 'navigate', '{}', '--json']));
check('--json success emits the raw result', okJson && okJson.content[0].text, 'stub replied');

// ---- handshake ordering ---------------------------------------------------

const captureFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cic-')), 'captured.jsonl');
run(['call', 'navigate', '{"url":"https://example.com"}'], { env: { CIC_STUB_CAPTURE: captureFile } });
const seen = fs.readFileSync(captureFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
check('initialize goes first', seen[0] && seen[0].method, 'initialize');
check('initialized notification is second', seen[1] && seen[1].method, 'notifications/initialized');
check('the request goes last', seen[2] && seen[2].method, 'tools/call');
check('the request carries the arguments', seen[2] && seen[2].params.arguments.url, 'https://example.com');

// ---- stderr passthrough ---------------------------------------------------

const stderrRun = run(['call', 'navigate', '{}'], { mode: 'stderr' });
check('the child stderr reaches the caller',
  stderrRun.stderr.includes('the extension is not connected'), true);

// ---- output ---------------------------------------------------------------

check('list prints one line per tool',
  run(['list']).stdout.trim().split('\n').length, 2);
check('list prints only the first description line',
  run(['list']).stdout.includes('Second line ignored'), false);
check('call prints the text content',
  run(['call', 'navigate', '{}']).stdout.trim(), 'stub replied');

// ---- large output must not be truncated -----------------------------------

// process.exit() after writing discards whatever has not drained, which cut a
// 2 MB page-text result down to one pipe buffer in both output modes.
const BIG_BYTES = 1024 * 1024;
const bigPlain = run(['call', 'get_page_text', '{}'], { mode: 'big' });
check('a result larger than a pipe buffer survives intact',
  bigPlain.stdout.length, BIG_BYTES + 1);
const bigJson = run(['call', 'get_page_text', '{}', '--json'], { mode: 'big' });
check('a large --json result survives intact',
  JSON.parse(bigJson.stdout).content[0].text.length, BIG_BYTES);

// ---- a reply that agreed to nothing ---------------------------------------

const noResult = run(['call', 'navigate', '{}'], { mode: 'no-result' });
check('a reply with neither result nor error is unknown, not success', noResult.status, 2);
const noResultJson = jsonLine(run(['call', 'navigate', '{}', '--json'], { mode: 'no-result' }));
check('--json says unknown for a reply with no result',
  noResultJson && noResultJson.kind, 'unknown_outcome');

// ---- --json owes an envelope on every failure ------------------------------

// The parser used to discard its options on the first bad flag, so --json
// callers got exit 64 and an empty stdout to parse.
const timeoutJson = jsonLine(run(['call', 'navigate', '{}', '--timeout', 'soon', '--json']));
check('--json usage envelope survives a bad flag earlier in the line',
  timeoutJson && timeoutJson.kind, 'usage');
check('--json usage envelope carries the exit code',
  timeoutJson && timeoutJson.exit, 64);

// isError used to print the raw MCP result under --json, not the frozen shape.
const isErrorJson = jsonLine(run(['call', 'navigate', '{}', '--json'], { mode: 'is-error' }));
check('--json isError is the error envelope, not the raw result',
  isErrorJson && isErrorJson.kind, 'tool_error');
check('--json isError carries the tool text as the message',
  isErrorJson && isErrorJson.message, 'the tool refused');
check('--json isError still exits 1',
  run(['call', 'navigate', '{}', '--json'], { mode: 'is-error' }).status, 1);

// ---- extra positional arguments are a usage error --------------------------

check('list takes no arguments', run(['list', 'unexpected']).status, 64);
check('call rejects a fourth argument',
  run(['call', 'navigate', '{}', 'unexpected']).status, 64);

// ---- the child is reaped, not merely signalled -----------------------------

// A child ignoring SIGTERM used to outlive the call, so a cron job calling cic
// in a loop accumulated one stranded bridge per run.
const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cic-pid-')), 'pid');
run(['call', 'navigate', '{}'], {
  mode: 'ignore-sigterm',
  env: { CIC_STUB_PIDFILE: pidFile },
  timeoutSeconds: 1,
});
let stubAlive = true;
try {
  process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0);
} catch {
  stubAlive = false;
}
check('a child that ignores SIGTERM is killed rather than stranded', stubAlive, false);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
