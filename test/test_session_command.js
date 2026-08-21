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

// Printed, never silent. A suite that quietly covers less on one platform is how
// a support claim outruns its evidence.
let skipped = 0;
function skip(label, why) {
  skipped++;
  console.log(`skip  ${label} — ${why}`);
}

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

// A fatal session must end the process, not sit waiting for the writer at the
// other end of stdin to finish. Every test above passes input through spawnSync,
// which closes stdin immediately and so cannot see this: the record arrived and
// then nothing happened for as long as the caller kept the pipe open.
{
  // Measured in a child with its own event loop. Two earlier attempts measured
  // the wrong thing: timing a shell pipeline timed the `sleep` holding the pipe
  // open, and polling child.exitCode from a busy loop could never see the exit,
  // because execSync blocks the very loop that would deliver it.
  const probe = `
    const { spawn } = require('child_process');
    const child = spawn(process.argv[1], [process.argv[2], 'session', '--jsonl', '--timeout', '2'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, CIC_STUB_MODE: 'exit-early' },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stdin.write('{"id":"first","tool":"navigate"}\\n');
    // stdin stays open on purpose: that is the condition under test.
    const started = Date.now();
    const giveUp = setTimeout(() => {
      console.log(JSON.stringify({ exited: false, ms: Date.now() - started, code: null, out }));
      child.kill('SIGKILL');
      process.exit(0);
    }, 8000);
    child.on('exit', (code) => {
      clearTimeout(giveUp);
      console.log(JSON.stringify({ exited: true, ms: Date.now() - started, code, out }));
    });
  `;
  const probed = spawnSync(process.execPath, ['-e', probe, process.execPath, CIC], {
    encoding: 'utf8',
    env: { ...process.env, CIC_CLAUDE_BIN: process.execPath, CIC_CLAUDE_ARGS: STUB },
  });
  let seen = {};
  try { seen = JSON.parse(probed.stdout.trim().split('\n').pop()); } catch { seen = {}; }
  check('a fatal session exits while stdin is still open', seen.exited, true);
  check('and does so promptly rather than waiting for the writer', seen.ms < 5000, true);
  check('with the session exit code', seen.code, 2);
  check('having emitted the record first', /unknown_outcome/.test(seen.out || ''), true);
}

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

// A shell that cannot reach the bridge says so on the way out rather than
// dropping the user at a prompt that can never work.
const shellNoBridge = run(['shell', '--timeout', '2'], ['navigate'],
  { env: { CIC_CLAUDE_BIN: '/nonexistent/claude' } });
check('a shell that cannot start reports transport', shellNoBridge.status, 3);
check('and explains itself rather than exiting silently',
  /ENOENT|could not|bridge failed/.test(shellNoBridge.stdout + shellNoBridge.stderr), true);

// Arguments that parse but are not an object.
const shellArray = run(['shell', '--timeout', '2'], ['navigate [1,2]', 'get_page_text']);
check('a shell line with non-object arguments is refused',
  /must be a JSON object/.test(shellArray.stdout), true);
check('and the shell carries on to the next line',
  /stub replied/.test(shellArray.stdout), true);

// A JSON-RPC error reaches the shell user as a message, not a crash.
const shellToolError = run(['shell', '--timeout', '2'], ['navigate'], { mode: 'tool-error' });
check('a tool error is printed in the shell', /tool blew up/.test(shellToolError.stdout), true);
check('and the shell still exits 0, since the session is healthy', shellToolError.status, 0);

// ---- a blocked consumer must not become unbounded memory ------------------

// Reads were paced by the bridge and writes by nothing, so with stdout unread
// forty one-megabyte replies were all accepted and buffered. What matters is not
// the absolute figure but that it does not grow with the number of requests.
// Measuring another process's resident memory needs `ps`, and pacing the samples
// needs `sleep`; neither exists on Windows, where execSync simply threw and both
// measurements came back zero, which the comparison then read as a pass waiting
// to happen. The behaviour under test is OS-agnostic, so proving it on the two
// platforms that can measure it is honest, and claiming it on the third is not.
if (process.platform === 'win32') {
  skip('memory does not grow with queued requests when stdout is unread',
    'needs ps and sleep to measure another process');
} else {
  const { spawn, execSync } = require('child_process');
  const peakFor = (count) => {
    const child = spawn(process.execPath, [CIC, 'session', '--jsonl', '--timeout', '20'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        ...process.env,
        CIC_CLAUDE_BIN: process.execPath,
        CIC_CLAUDE_ARGS: STUB,
        CIC_STUB_MODE: 'big',
      },
    });
    // Deliberately never read stdout.
    let peak = 0;
    const deadline = Date.now() + 3000;
    for (let i = 0; i < count; i++) {
      child.stdin.write(JSON.stringify({ id: i, tool: 'get_page_text' }) + '\n');
    }
    while (Date.now() < deadline) {
      try {
        const rss = Number(execSync(`ps -o rss= -p ${child.pid}`).toString().trim());
        if (rss > peak) { peak = rss; }
      } catch { break; }
      try { execSync('sleep 0.2'); } catch { break; }
    }
    child.kill('SIGKILL');
    return peak;
  };
  const small = peakFor(20);
  const large = peakFor(200);
  // Ten times the requests must not mean anything like ten times the memory.
  // Both being zero would satisfy that trivially, so the measurement has to be
  // shown to have worked at all.
  check('the memory probe actually measured something', small > 0, true);
  check('memory does not grow with queued requests when stdout is unread',
    small > 0 && large < small * 2, true);
  if (!(small > 0 && large < small * 2)) {
    console.log(`        20 requests peaked at ${small} KB, 200 at ${large} KB`);
  }
}

// ---- .adopt in the shell --------------------------------------------------

// The protocol itself is tested in test_tab_adoption.js. What matters here is
// what a human sees, and the exit rule, which is the one place this tool
// knowingly leaves something behind.
const BLANK = { tabId: 901, title: 'New tab', url: 'chrome://newtab/' };
const PAGE = {
  tabId: 500,
  title: 'GitHub — PR #24',
  url: 'https://github.com/hamzahamidi/claude-in-chrome-cli/pull/24?tab=secret#frag',
};
const adoptScript = (steps) => ({
  mode: 'adopt',
  env: { CIC_STUB_ADOPT: JSON.stringify(steps) },
});

{
  const adopted = run(['shell', '--timeout', '10'], ['.adopt', '.exit'],
    adoptScript([[], [BLANK], [BLANK, PAGE], [BLANK, PAGE]]));
  check('.adopt explains what moving a tab grants before waiting',
    /read and interact with that live page/.test(adopted.stdout), true);
  check('and says how to do it', /Add tab to group/.test(adopted.stdout), true);
  check('and says it is waiting, with how to cancel',
    /Waiting for a tab….*Ctrl-C to cancel/.test(adopted.stdout), true);
  check('the adopted tab leads with its title, not its id',
    /✓ GitHub — PR #24/.test(adopted.stdout), true);
  check('the url is shown as origin and path only',
    /github\.com\/hamzahamidi\/claude-in-chrome-cli\/pull\/24\n/.test(adopted.stdout), true);
  check('so a query string never reaches the prompt', /secret/.test(adopted.stdout), false);
  check('nor a fragment', /frag/.test(adopted.stdout), false);
  check('the id is given, because the next line needs it',
    /Adopted as tab 500/.test(adopted.stdout), true);
  // The exit rule: the anchor is the group's first tab, so closing it would
  // take the adopted tab with it.
  check('an anchor is left open when a tab was adopted',
    /leaving the blank tab 901 open on purpose/.test(adopted.stdout), true);
  check('and the reason is stated, not just the fact',
    /make the bridge lose the group/.test(adopted.stdout), true);
  check('the shell still exits 0', adopted.status, 0);
}

{
  // Nothing adopted, so there is nothing to orphan and the anchor goes.
  const nothing = run(['shell', '--timeout', '1'], ['.adopt', '.exit'],
    adoptScript([[], [BLANK]]));
  check('a window with nothing moved in adopts nothing',
    /nothing was adopted/.test(nothing.stdout), true);
  check('and says no page was touched', /No page was touched/.test(nothing.stdout), true);
  check('and the anchor is not left behind, having nothing to protect',
    /leaving the blank tab/.test(nothing.stdout), false);
  check('exiting 0 either way', nothing.status, 0);
}

{
  // A group that already had a tab: nothing was created, so nothing is tidied.
  const existing = run(['shell', '--timeout', '10'], ['.adopt', '.exit'],
    adoptScript([[PAGE], [PAGE], [PAGE, { ...BLANK, tabId: 777, url: 'https://example.com/x' }],
      [PAGE, { ...BLANK, tabId: 777, url: 'https://example.com/x' }]]));
  check('an existing group is adopted into without creating an anchor',
    /Adopted as tab 777/.test(existing.stdout), true);
  check('and nothing is left behind, because nothing was opened',
    /leaving the blank tab/.test(existing.stdout), false);
}

{
  // Every recoverable state has to say something useful, or a human is left
  // watching a silent prompt wondering whether it noticed.
  const noisy = run(['shell', '--timeout', '3'], ['.adopt', '.exit'],
    adoptScript([[], [BLANK], [BLANK, PAGE, { tabId: 600, title: 'Other', url: 'https://example.com/o' }],
      [BLANK, PAGE, { tabId: 600, title: 'Other', url: 'https://example.com/o' }]]));
  check('two tabs moved in is reported with the count',
    /2 tabs were added/.test(noisy.stdout), true);
  check('and says what to do about it',
    /Move the ones you do not want back out/.test(noisy.stdout), true);

  const blankOnly = run(['shell', '--timeout', '2'], ['.adopt', '.exit'],
    adoptScript([[], [BLANK], [BLANK, { tabId: 902, title: 'New tab', url: 'chrome://newtab/' }],
      [BLANK, { tabId: 902, title: 'New tab', url: 'chrome://newtab/' }]]));
  check('a blank tab is called out rather than silently ignored',
    /blank tab rather than a page/.test(blankOnly.stdout), true);

  const undrivable = run(['shell', '--timeout', '2'], ['.adopt', '.exit'], {
    mode: 'adopt',
    env: {
      CIC_STUB_ADOPT: JSON.stringify([[], [BLANK], [BLANK, PAGE], [BLANK, PAGE]]),
      CIC_STUB_ADOPT_UNDRIVABLE: '[500]',
    },
  });
  check('a tab that cannot be driven says so, and why it might be temporary',
    /cannot be driven yet, possibly still loading/.test(undrivable.stdout), true);

  const emptied = run(['shell', '--timeout', '3'], ['.adopt', '.exit'],
    adoptScript([[], [BLANK], [], [BLANK, PAGE], [BLANK, PAGE]]));
  check('a group that empties says it is being held open again',
    /held open again/.test(emptied.stdout), true);

  // A bridge that will not produce a group at all: reported on the prompt, and
  // the shell survives it rather than dying.
  const noGroup = run(['shell', '--timeout', '2'], ['.adopt', 'navigate {}', '.exit'],
    { mode: 'is-error' });
  check('a bridge that will not open a group is reported', /cic: /.test(noGroup.stdout), true);
  check('and the shell carries on afterwards', noGroup.status, 0);
}

// Ctrl-C must cancel the adoption and leave the shell running, which is the
// whole reason cancellation is a flag rather than an interruption: a poll
// already in flight is read-only and is allowed to settle, so cancelling never
// invents an outcome nobody can classify. Sending a signal to a child needs
// POSIX semantics, so Windows says so rather than pretending.
if (process.platform === 'win32') {
  skip('Ctrl-C cancels the adoption without killing the shell',
    'needs POSIX signal delivery to a child');
} else {
  const probe = `
    const { spawn } = require('child_process');
    const child = spawn(process.argv[1], [process.argv[2], 'shell', '--timeout', '20'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, CIC_STUB_MODE: 'adopt',
        CIC_STUB_ADOPT: JSON.stringify([[], [{ tabId: 901, title: 'New tab', url: 'chrome://newtab/' }]]) },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stdin.write('.adopt\\n');
    // Once it is visibly waiting, interrupt it.
    const interrupt = setInterval(() => {
      if (/Waiting for a tab/.test(out)) {
        clearInterval(interrupt);
        child.kill('SIGINT');
        setTimeout(() => child.stdin.end(), 400);
      }
    }, 50);
    const giveUp = setTimeout(() => {
      clearInterval(interrupt);
      console.log(JSON.stringify({ code: null, signal: 'timeout', out }));
      child.kill('SIGKILL');
      process.exit(0);
    }, 12000);
    child.on('exit', (code, signal) => {
      clearInterval(interrupt);
      clearTimeout(giveUp);
      console.log(JSON.stringify({ code, signal, out }));
    });
  `;
  const ran = spawnSync(process.execPath, ['-e', probe, process.execPath, CIC], {
    encoding: 'utf8',
    env: { ...process.env, CIC_CLAUDE_BIN: process.execPath, CIC_CLAUDE_ARGS: STUB },
  });
  let seen = {};
  try { seen = JSON.parse(ran.stdout.trim().split('\n').pop()); } catch { seen = {}; }
  check('Ctrl-C is acknowledged', /cancelling/.test(seen.out || ''), true);
  check('the adoption reports itself cancelled', /Cancelled\. No page was touched/.test(seen.out || ''), true);
  check('and the shell was not killed by the signal', seen.signal, null);
  check('exiting normally instead', seen.code, 0);
  if (seen.code !== 0) { console.log(`        exit ${seen.code} signal ${seen.signal}`); }
}

{
  // A shell that never adopts must be unchanged by the feature existing.
  const plain = run(['shell', '--timeout', '2'], ['navigate {"url":"https://example.com"}', '.exit']);
  check('the shell without .adopt still answers a tool line',
    /stub replied/.test(plain.stdout), true);
  check('and mentions .adopt in its banner', /\.adopt/.test(plain.stdout), true);
}

// ---- a command refuses flags it would otherwise ignore --------------------

for (const [args, why] of [
  [['list', '--jsonl'], 'list has no streaming mode'],
  [['call', 'navigate', '{}', '--jsonl'], 'call has no streaming mode'],
  [['session', '--jsonl', '--retries', '3'], 'retrying inside a session is not defined'],
  [['session', '--jsonl', '--json'], 'session already emits JSON per line'],
  [['shell', '--json'], 'the shell prints for a human'],
  [['shell', '--jsonl'], 'the shell is not the streaming protocol'],
]) {
  check(`${args.join(' ')} is a usage error, since ${why}`, run(args, []).status, 64);
}

// The combinations each command does understand still work.
check('list --json is accepted', run(['list', '--json'], []).status, 0);
check('session --jsonl --timeout is accepted',
  jsonl(['{"id":"a","tool":"navigate"}']).status, 0);
check('shell --timeout is accepted', run(['shell', '--timeout', '2'], ['.exit']).status, 0);

console.log(failures
  ? `\n${failures} failed${skipped ? `, ${skipped} skipped` : ''}`
  : `\nall passed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failures ? 1 : 0);
