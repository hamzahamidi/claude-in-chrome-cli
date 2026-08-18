#!/usr/bin/env node
// The streaming interfaces: `cic session --jsonl` and `cic shell`.
//
// Driven through the real command line with piped stdin, because piped input is
// how a program will actually use this and it behaves differently from a
// terminal: readline emits every line and fires close before the first call
// finishes, which is exactly the case that broke the shell.
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const HERE = __dirname;
const CIC = path.join(HERE, '..', 'plugins', 'claude-in-chrome', 'bin', 'cic.js');
const STUB = path.join(HERE, 'stub_server.js');

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) { failures++; }
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}

/** Runs a command with `lines` on stdin and returns its result plus parsed records. */
function run(args, lines, { mode = 'ok', env = {} } = {}) {
  const result = spawnSync(process.execPath, [CIC, ...args], {
    encoding: 'utf8',
    input: lines.map((line) => line + '\n').join(''),
    env: {
      ...process.env,
      CIC_CLAUDE_BIN: process.execPath,
      CIC_CLAUDE_ARGS: STUB,
      CIC_STUB_MODE: mode,
      ...env,
    },
  });
  const records = result.stdout.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  return { ...result, records };
}

const jsonl = (lines, options) => run(['session', '--jsonl', '--timeout', '2'], lines, options);

// ---- one connection answers many calls, in order --------------------------

const three = jsonl([
  '{"id":"a","tool":"navigate","arguments":{"url":"https://example.com"}}',
  '{"id":"b","tool":"get_page_text"}',
  '{"id":"c","tool":"tabs_close_mcp","arguments":{"tabId":1}}',
]);
check('three calls over one session produce three records', three.records.length, 3);
check('and the ids come back in the order they were sent',
  three.records.map((r) => r.id).join(','), 'a,b,c');
check('each carries the caller-chosen id, not a generated one', three.records[1].id, 'b');
check('a successful record is exit 0 with a result', three.records[0].exit, 0);
check('and success carries no error flag', three.records[0].error, undefined);
check('the session exits 0 when every call was answered', three.status, 0);

// The id is whatever the caller chose, including a number or a long string.
const ids = jsonl(['{"id":7,"tool":"navigate"}', '{"id":"a-very-long-id","tool":"navigate"}']);
check('a numeric id round-trips as a number', ids.records[0] && ids.records[0].id, 7);
check('a string id round-trips unchanged', ids.records[1] && ids.records[1].id, 'a-very-long-id');

// ---- the envelope is the frozen one, plus the id -------------------------

const toolErr = jsonl(['{"id":"x","tool":"navigate"}'], { mode: 'tool-error' });
check('a tool error is exit 1 in the frozen envelope', toolErr.records[0].exit, 1);
check('with the frozen kind', toolErr.records[0].kind, 'tool_error');
check('and the frozen error flag', toolErr.records[0].error, true);
check('and a string message', typeof toolErr.records[0].message, 'string');

// A tool error is that call's problem, never the session's.
const twoErrors = jsonl(['{"id":"x","tool":"navigate"}', '{"id":"y","tool":"navigate"}'],
  { mode: 'tool-error' });
check('a tool error does not end the session', twoErrors.records.length, 2);
check('and the session still exits 0', twoErrors.status, 0);

const isError = jsonl(['{"id":"x","tool":"navigate"}'], { mode: 'is-error' });
check('isError true is exit 1, as in one-shot', isError.records[0].exit, 1);
check('carrying the tool text as the message', isError.records[0].message, 'the tool refused');

// ---- an unknown outcome is fatal to the session --------------------------

// The request was sent and nobody knows whether the browser acted, so a later
// call must not be allowed to race it.
const unknown = jsonl(['{"id":"first","tool":"navigate"}', '{"id":"second","tool":"navigate"}'],
  { mode: 'exit-early' });
check('an unknown outcome is reported as exit 2', unknown.records[0].exit, 2);
check('with the unknown kind', unknown.records[0].kind, 'unknown_outcome');
check('it answers only the call that failed', unknown.records.length, 1);
check('no record is emitted for the line behind it',
  unknown.records.some((r) => r.id === 'second'), false);
check('and the process exit code says the session died of it', unknown.status, 2);

// ---- malformed input is that record's problem ----------------------------

const bad = jsonl([
  'not json at all',
  '{"tool":"navigate"}',
  '{"id":"noname"}',
  '{"id":"badargs","tool":"navigate","arguments":[1,2]}',
  '{"id":"badtimeout","tool":"navigate","timeout":-5}',
  '{"id":"fine","tool":"navigate"}',
]);
check('every malformed line gets its own record', bad.records.length, 6);
check('unparseable JSON is a usage error', bad.records[0].kind, 'usage');
check('and has a null id, since none could be read', bad.records[0].id, null);
check('a missing id is a usage error', bad.records[1].exit, 64);
check('a missing tool is a usage error', bad.records[2].exit, 64);
check('and it reports the id it did manage to read', bad.records[2].id, 'noname');
check('non-object arguments are a usage error', bad.records[3].exit, 64);
check('a negative timeout is a usage error', bad.records[4].exit, 64);
check('and a good line after five bad ones still runs', bad.records[5].exit, 0);
check('malformed input never ends the session', bad.status, 0);

// A blank line is not an error, it is nothing.
const blanks = jsonl(['', '{"id":"a","tool":"navigate"}', '   ']);
check('blank lines are ignored rather than reported', blanks.records.length, 1);

// ---- startup failure is reported as a record too -------------------------

const noBridge = run(['session', '--jsonl', '--timeout', '2'], ['{"id":"a","tool":"navigate"}'],
  { env: { CIC_CLAUDE_BIN: '/nonexistent/claude' } });
check('a session that cannot start emits one record', noBridge.records.length, 1);
check('classified transport, because nothing was dispatched', noBridge.records[0].exit, 3);
check('with a null id, since no call was reached', noBridge.records[0].id, null);
check('and the process exit code matches', noBridge.status, 3);

// ---- session usage errors --------------------------------------------------

check('session without --jsonl is a usage error',
  run(['session'], []).status, 64);
check('session takes no positional arguments',
  run(['session', '--jsonl', 'extra'], []).status, 64);

// ---- the shell runs every line it was given ------------------------------

// Readline emits all piped lines and fires close before the first call
// finishes. Prompting a closed interface throws, and that rejection used to
// poison the queue so only the first line ever ran.
const shell = run(['shell', '--timeout', '2'],
  ['navigate {"url":"https://example.com"}', 'get_page_text', 'find']);
const replies = (shell.stdout.match(/stub replied/g) || []).length;
check('the shell answers every piped line, not just the first', replies, 3);
check('and exits 0 at end of input', shell.status, 0);

const shellExit = run(['shell', '--timeout', '2'], ['navigate', '.exit', 'navigate']);
check('.exit stops reading', (shellExit.stdout.match(/stub replied/g) || []).length, 1);
check('and exits 0', shellExit.status, 0);

const shellBad = run(['shell', '--timeout', '2'], ['navigate {oops}', 'get_page_text']);
check('a shell line with bad JSON is reported',
  /not valid JSON/.test(shellBad.stdout), true);
check('and the shell keeps going afterwards',
  /stub replied/.test(shellBad.stdout), true);

const shellUnknown = run(['shell', '--timeout', '2'], ['navigate', 'navigate'],
  { mode: 'exit-early' });
check('an unknown outcome ends the shell too', shellUnknown.status, 2);
check('and it says why rather than just stopping',
  /outcome is unknown/.test(shellUnknown.stdout), true);

check('shell takes no positional arguments', run(['shell', 'extra'], []).status, 64);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
