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

// ---- a flag must never be eaten as another flag's value --------------------

// `--timeout --json` consumed --json as the timeout value, losing the flag that
// decides how the resulting error is reported.
const eatenFlag = run(['call', 'navigate', '{}', '--timeout', '--json']);
check('--timeout does not swallow a following flag', eatenFlag.status, 64);
const eatenFlagJson = jsonLine(eatenFlag);
check('--json survives being written after a valueless --timeout',
  eatenFlagJson && eatenFlagJson.kind, 'usage');
check('a --timeout with no value at all is a usage error',
  run(['call', 'navigate', '{}', '--timeout']).status, 64);

// ---- replies that are not JSON-RPC messages -------------------------------

// `null`, a number and an array all parse as JSON. Dereferencing them threw an
// uncaught TypeError out of the stdout handler and killed the process.
const nullReply = run(['call', 'navigate', '{}'], { mode: 'null-reply', timeoutSeconds: 1 });
check('a literal null reply does not crash the client', nullReply.status, 2);
check('a literal null reply reports no usable reply, not a stack trace',
  /Unhandled|TypeError/.test(nullReply.stderr), false);

// An error whose message is not a string used to go into the frozen envelope
// verbatim, so a machine caller got `"message":42` from a contract that
// promises a string.
const numericMessage = run(['call', 'navigate', '{}'], { mode: 'numeric-error-message', timeoutSeconds: 2 });
check('an error whose message is not a string is unknown, not a tool error', numericMessage.status, 2);
const numericMessageJson = jsonLine(run(['call', 'navigate', '{}', '--json'], { mode: 'numeric-error-message', timeoutSeconds: 2 }));
check('the envelope message stays a string when the bridge sends a number',
  typeof (numericMessageJson && numericMessageJson.message), 'string');

// JSON-RPC allows a result or an error, never both.
check('a reply with both a result and an error is unknown',
  run(['call', 'navigate', '{}'], { mode: 'result-and-error', timeoutSeconds: 2 }).status, 2);

// A result missing the array its method requires printed nothing and exited 0,
// which is indistinguishable from a genuinely empty page.
check('a tools/call result with no content array is unknown, not empty success',
  run(['call', 'navigate', '{}'], { mode: 'empty-result', timeoutSeconds: 2 }).status, 2);
check('a tools/list result with no tools array is unknown, not empty success',
  run(['list'], { mode: 'empty-result', timeoutSeconds: 2 }).status, 2);
// An empty array is a real answer and must stay one.
check('an empty content array is still a success', run(['call', 'navigate', '{}'], { mode: 'empty-content' }).status, 0);

const noEnvelope = run(['call', 'navigate', '{}'], { mode: 'no-envelope', timeoutSeconds: 2 });
check('a reply without a JSON-RPC 2.0 envelope is unknown, not success', noEnvelope.status, 2);
const noEnvelopeJson = jsonLine(run(['call', 'navigate', '{}', '--json'], { mode: 'no-envelope', timeoutSeconds: 2 }));
check('--json says unknown for an unenveloped reply',
  noEnvelopeJson && noEnvelopeJson.kind, 'unknown_outcome');

// ---- a reader that goes away mid-write ------------------------------------

// EPIPE arrives twice, through the write callback and as a stream error event.
// Without a listener for the second, Node rethrew it and printed a stack trace
// after the output had already been delivered.
const piped = spawnSync('sh', ['-c',
  `${JSON.stringify(process.execPath)} ${JSON.stringify(CIC)} call get_page_text '{}' | head -c 1`], {
  encoding: 'utf8',
  env: { ...process.env, CIC_CLAUDE_BIN: process.execPath, CIC_CLAUDE_ARGS: STUB, CIC_STUB_MODE: 'big' },
});
check('a reader closing early does not produce a stack trace',
  /Unhandled|EPIPE/.test(piped.stderr), false);

// ---- shutdown when something else holds the pipe --------------------------

// A descendant of the bridge holding the bridge's stdout kept the client alive
// indefinitely, because terminate() returned early for an already-exited child
// and never released the pipes.
const readyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cic-linger-')), 'ready');
const startedAt = Date.now();
const lingered = run(['call', 'get_page_text', '{}'], {
  mode: 'linger',
  env: { CIC_STUB_READY: readyFile },
  timeoutSeconds: 10,
});
const lingerSeconds = (Date.now() - startedAt) / 1000;
check('a bridge whose descendant holds stdout still lets the client exit', lingered.status, 0);
check('and the client does not wait on that pipe to do it', lingerSeconds < 9, true);

// Kill the process this test deliberately created. Signal 0 only asks whether a
// pid exists, so the first version of this cleanup killed nothing and leaked an
// immortal node process on every run.
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
let holderPid = NaN;
try { holderPid = Number(fs.readFileSync(readyFile, 'utf8').trim()); } catch { /* never started */ }
check('the linger stub reported a usable pid', Number.isInteger(holderPid) && holderPid > 0, true);
if (Number.isInteger(holderPid) && holderPid > 0) {
  try { process.kill(holderPid, 'SIGKILL'); } catch { /* already gone */ }
  // Reaping is not instant, so give it a moment before asserting.
  for (let attempt = 0; attempt < 40 && alive(holderPid); attempt++) {
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 25)']);
  }
  check('this test leaves nothing of its own behind', alive(holderPid), false);
}
fs.rmSync(path.dirname(readyFile), { recursive: true, force: true });

// ---- a hostile handshake is exit 3, because nothing was dispatched ---------

for (const [mode, label] of [
  ['initialize-no-protocol', 'an initialize result with no protocolVersion'],
  ['initialize-numeric-protocol', 'an initialize result whose protocolVersion is a number'],
  ['initialize-both', 'an initialize reply with both a result and an error'],
  ['initialize-bad-error-code', 'an initialize error whose code is not an integer'],
  ['initialize-error', 'an initialize error the bridge actually meant'],
]) {
  check(`${label} is transport, not unknown`,
    run(['call', 'navigate', '{}'], { mode, timeoutSeconds: 2 }).status, 3);
}

// Nothing may go out before the handshake is accepted, so a rejected handshake
// must leave the request unsent rather than racing it.
const handshakeCapture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cic-hs-')), 'captured.jsonl');
run(['call', 'navigate', '{}'], {
  mode: 'initialize-no-protocol',
  env: { CIC_STUB_CAPTURE: handshakeCapture },
  timeoutSeconds: 2,
});
const handshakeSeen = fs.readFileSync(handshakeCapture, 'utf8').trim().split('\n')
  .filter(Boolean).map((line) => JSON.parse(line));
check('a malformed handshake never dispatches the request',
  handshakeSeen.some((message) => message.method === 'tools/call'), false);

// ---- error and result members are validated, not just their containers -----

check('an error code that is not an integer is unknown',
  run(['call', 'navigate', '{}'], { mode: 'noninteger-error-code', timeoutSeconds: 2 }).status, 2);
check('an isError that is not a boolean is unknown',
  run(['call', 'navigate', '{}'], { mode: 'nonboolean-is-error', timeoutSeconds: 2 }).status, 2);
check('a content part that is not an object is unknown',
  run(['call', 'navigate', '{}'], { mode: 'content-part-not-object', timeoutSeconds: 2 }).status, 2);
check('a content part with no type is unknown',
  run(['call', 'navigate', '{}'], { mode: 'content-part-no-type', timeoutSeconds: 2 }).status, 2);
check('a text part whose text is missing is unknown',
  run(['call', 'navigate', '{}'], { mode: 'text-part-without-text', timeoutSeconds: 2 }).status, 2);
check('a tool with no name is unknown',
  run(['list'], { mode: 'tool-without-name', timeoutSeconds: 2 }).status, 2);
check('a tools entry that is not an object is unknown',
  run(['list'], { mode: 'tool-entry-not-object', timeoutSeconds: 2 }).status, 2);

// ---- the two output modes must never disagree ------------------------------

// A difference between plain and --json for the same reply is a bug in the
// contract, not a formatting choice: a caller that switches to --json for
// machine parsing would silently change which replies it treats as failures.
const CALL_MODES = [
  'ok', 'tool-error', 'is-error', 'no-result', 'null-reply', 'no-envelope',
  'numeric-error-message', 'result-and-error', 'empty-result', 'empty-content',
  'noninteger-error-code', 'nonboolean-is-error', 'content-part-not-object',
  'content-part-no-type', 'text-part-without-text', 'malformed', 'exit-early',
  'initialize-no-protocol', 'initialize-both', 'initialize-error',
];
for (const mode of CALL_MODES) {
  const plain = run(['call', 'navigate', '{}'], { mode, timeoutSeconds: 2 });
  const asJson = run(['call', 'navigate', '{}', '--json'], { mode, timeoutSeconds: 2 });
  check(`plain and --json agree on call '${mode}' (${plain.status})`, plain.status, asJson.status);
}
for (const mode of ['ok', 'empty-result', 'tool-without-name', 'tool-entry-not-object', 'no-envelope']) {
  const plain = run(['list'], { mode, timeoutSeconds: 2 });
  const asJson = run(['list', '--json'], { mode, timeoutSeconds: 2 });
  check(`plain and --json agree on list '${mode}' (${plain.status})`, plain.status, asJson.status);
}

// Every non-zero exit under --json owes the caller an envelope, with a string
// message, whatever went wrong.
for (const mode of CALL_MODES) {
  const asJson = run(['call', 'navigate', '{}', '--json'], { mode, timeoutSeconds: 2 });
  if (asJson.status === 0) { continue; }
  const parsed = jsonLine(asJson);
  check(`--json emits a well-formed envelope for '${mode}'`,
    Boolean(parsed && parsed.error === true && typeof parsed.message === 'string'
      && parsed.exit === asJson.status && typeof parsed.kind === 'string'),
    true);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
