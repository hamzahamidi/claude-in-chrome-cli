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
const { writeImageResult, ImageOutputError } = require('../lib/image-output.js');
const { withTab, TabLifecycleError } = require('../lib/tab-lifecycle.js');

const VERSION = '0.8.1';
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
  cic shell                         the same connection, driven by hand (.adopt uses a tab you already have open)
  cic with-tab <url> <tool> [args]  make a tab, navigate, call one tool, close it
  cic tabs                          every open tab, read from disk without the bridge

Options:
  --timeout <secs>   ceiling on how long to wait for the reply (default ${DEFAULT_TIMEOUT_SECONDS})
  --retries <n>      retry only failures that never reached the browser (exit 3)
  --json             print the raw result object, or one error object, on one line
  --output <path>    write the image in the result to a file (call, with-tab)
  --keep-tab         leave the tab open instead of closing it (with-tab)
  --profile <name>   only this browser profile (tabs)
  --full-urls        raw URLs instead of redacted origin and path (tabs)
  -h, --help         this text
  -v, --version      print the version

Examples:
  cic list
  cic call navigate '{"url":"https://example.com"}'
  cic call get_page_text '{}' --timeout 60
  cic call computer '{"action":"screenshot","tabId":123}' --output shot.png
  cic call navigate '{"url":"https://example.com"}' --retries 3
  cic with-tab https://example.com get_page_text
  cic with-tab https://example.com computer '{"action":"screenshot"}' --output shot.png
  cic tabs
  cic tabs --json --profile Default
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
  call: new Set(['--json', '--timeout', '--retries', '--output']),
  session: new Set(['--jsonl', '--timeout']),
  shell: new Set(['--timeout']),
  'with-tab': new Set(['--json', '--timeout', '--retries', '--output', '--keep-tab']),
  // No bridge is involved, so nothing here can time out, be retried or be
  // unknown. Offering those flags would imply otherwise.
  tabs: new Set(['--json', '--profile', '--full-urls']),
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
    if (error?.code === 'EPIPE') {
      if (stream === process.stdout) { stdoutBroken = true; }
      return;
    }
    try { process.stderr.write(`cic: ${stream === process.stdout ? 'stdout' : 'stderr'} failed: ${error?.message}\n`); } catch { /* nothing left to write to */ }
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
  .filter((part) => part?.type === 'text')
  .map((part) => part.text)
  .join('\n');

// Deliberately not unref'd. An unref'd timer does not hold the event loop open,
// and by the time a retry is waiting the child is dead and its pipes are
// destroyed, so nothing else does either: Node exited cleanly with code 0
// mid-backoff, reporting success for a call that never happened.
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const BOOLEAN_OPTIONS = {
  '--json': ['json', true, true],
  '--jsonl': ['jsonl', true, true],
  '--full-urls': ['fullUrls', true, true],
  '--keep-tab': ['keepTab', true, true],
  '-h': ['help', true, false],
  '--help': ['help', true, false],
  '-v': ['version', true, false],
  '--version': ['version', true, false],
};
const VALUE_OPTIONS = { '--output': 'output', '--profile': 'profile' };

function argumentValue(argv, index, flag, note) {
  const raw = argv[index + 1];
  if (raw === undefined || raw.startsWith('-')) {
    note(`${flag} wants a value, got ${raw === undefined ? 'nothing' : raw}`);
    return null;
  }
  return raw;
}

function setNumericOption(argument, raw, options, note) {
  const value = Number(raw);
  if (argument === '--timeout') {
    if (!Number.isFinite(value) || value <= 0) {
      note(`--timeout wants a positive number of seconds, got ${raw}`);
    } else {
      options.timeout = value;
    }
    return;
  }
  if (!Number.isInteger(value) || value < 0) {
    note(`--retries wants a whole number of attempts, got ${raw}`);
  } else {
    options.retries = value;
  }
}

function parseArgument(argument, argv, index, state) {
  const booleanOption = Object.hasOwn(BOOLEAN_OPTIONS, argument) ? BOOLEAN_OPTIONS[argument] : null;
  if (booleanOption) {
    const [name, value, wasProvided] = booleanOption;
    state.options[name] = value;
    if (wasProvided) state.provided.add(argument);
    return 1;
  }

  if (Object.hasOwn(VALUE_OPTIONS, argument) || argument === '--timeout' || argument === '--retries') {
    const raw = argumentValue(argv, index, argument, state.note);
    if (raw === null) return 1;
    state.provided.add(argument);
    if (Object.hasOwn(VALUE_OPTIONS, argument)) state.options[VALUE_OPTIONS[argument]] = raw;
    else setNumericOption(argument, raw, state.options, state.note);
    return 2;
  }

  if (argument.startsWith('-')) state.note(`unknown option ${argument}`);
  else state.positional.push(argument);
  return 1;
}

function parseArguments(argv) {
  const state = {
    options: {
      timeout: DEFAULT_TIMEOUT_SECONDS,
      retries: 0,
      json: false,
      jsonl: false,
      fullUrls: false,
      keepTab: false,
      output: null,
      profile: null,
    },
    provided: new Set(),
    positional: [],
    error: null,
  };
  state.note = (message) => { state.error = state.error || message; };

  // Keep scanning after an error so a later --json still selects the envelope.
  for (let i = 0; i < argv.length; i++) {
    i += parseArgument(argv[i], argv, i, state) - 1;
  }
  return { options: state.options, positional: state.positional, provided: state.provided, error: state.error };
}
const COMMANDS = ['list', 'call', 'session', 'shell', 'with-tab', 'tabs'];

/** Arguments JSON, or a usage error naming why it was rejected. */
function parseToolArguments(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw === undefined ? '{}' : raw);
  } catch (error) {
    throw new UsageError(`arguments are not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError('arguments must be a JSON object.');
  }
  return parsed;
}

/** Decides what the command means, before anything is spawned. */
function planWithTab(rest) {
  // with-tab takes the URL first, then the same tool name and JSON arguments
  // call takes. The tabId is the one key it fills in, which is the whole point
  // of the command; everything else stays pass-through.
  const [url, toolName, rawArguments, ...extra] = rest;
  if (!url) { throw new UsageError('with-tab wants a url.'); }
  if (!toolName) { throw new UsageError('with-tab wants a url and a tool name.'); }
  if (extra.length) {
    throw new UsageError(
      `with-tab takes a url, a tool name and optional JSON arguments, got ${extra.length} extra: '${extra.join("', '")}'.`);
  }
  const toolArguments = parseToolArguments(rawArguments);
  if ('tabId' in toolArguments) {
    throw new UsageError('with-tab sets tabId itself, so passing one would be ignored. Use call for a tab you already have.');
  }
  return { command: 'with-tab', method: 'tools/call', url, params: { name: toolName, arguments: toolArguments } };
}

function planCall(rest) {
  const [toolName, rawArguments, ...extra] = rest;
  if (!toolName) { throw new UsageError('call wants a tool name.'); }
  if (extra.length) {
    throw new UsageError(
      `call takes a tool name and optional JSON arguments, got ${extra.length} extra: '${extra.join("', '")}'.`);
  }
  return { command: 'call', method: 'tools/call', params: { name: toolName, arguments: parseToolArguments(rawArguments) } };
}

function planRequest(positional) {
  const [command, ...rest] = positional;
  if (command !== 'list' && command !== 'call' && command !== 'with-tab') {
    throw new UsageError(`unknown command '${command}'. Expected one of ${COMMANDS.join(', ')}.`);
  }
  if (command === 'list') {
    if (rest.length) throw new UsageError(`list takes no arguments, got '${rest[0]}'.`);
    return { command, method: 'tools/list', params: {} };
  }
  return command === 'with-tab' ? planWithTab(rest) : planCall(rest);
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
    if (plan.command !== 'with-tab') {
      return await session.call(plan.method, plan.params);
    }
    const held = await withTab(session,
      { url: plan.url, keepTab: options.keepTab, timeoutSeconds: options.timeout },
      (tabId) => session.call('tools/call', {
        name: plan.params.name,
        arguments: { ...plan.params.arguments, tabId },
      }));
    if (held.tabWarning) { await writeErr(`cic: ${held.tabWarning}\n`); }
    return held.outcome;
  } finally {
    await session.close();
  }
}

/**
 * `cic tabs`: the same answer the chrome-tabs MCP tool gives, straight from the
 * files, with no bridge in the middle.
 *
 * The redaction is applied here for --json as well, not only in the rendered
 * text. collect() returns raw URLs, so emitting them as JSON would have quietly
 * turned the safe default off for whoever chose the machine-readable output.
 */
async function reportTabs(options) {
  const { collect, render, redactUrl } = require('../lib/session-tabs.js');
  const groups = collect(options.profile);

  // A profile that matched nothing is a typo worth naming. The rendered text
  // would otherwise say no session data was found, which is true of that name
  // and misleading about the machine.
  if (options.profile && groups.length === 0) {
    const available = [...new Set(collect().map((group) => group.profile))];
    throw new UsageError(available.length
      ? `no profile named '${options.profile}'. This machine has ${available.join(', ')}.`
      : `no profile named '${options.profile}', and no readable browser profile was found at all.`);
  }

  if (options.json) {
    const payload = {
      groups: groups.map((group) => ({
        ...group,
        tabs: group.tabs.map((tab) => ({
          ...tab,
          url: options.fullUrls ? tab.url : redactUrl(tab.url),
        })),
      })),
    };
    await writeOut(JSON.stringify(payload) + '\n');
    return EXIT.OK;
  }

  await writeOut(render(groups, { includeUrls: true, fullUrls: options.fullUrls }) + '\n');
  return EXIT.OK;
}

async function runSessionCommand(positional, options, provided) {
  rejectUnsupportedFlags('session', provided);
  if (positional.length > 1) {
    throw new UsageError(`session takes no positional arguments, got '${positional[1]}'.`);
  }
  if (!options.jsonl) throw new UsageError('session needs --jsonl. It is the only protocol it speaks.');
  return runSession({
    timeoutSeconds: options.timeout,
    input: process.stdin,
    output: process.stdout,
    jsonl: true,
  });
}

async function runShellCommand(positional, options, provided) {
  rejectUnsupportedFlags('shell', provided);
  if (positional.length > 1) {
    throw new UsageError(`shell takes no positional arguments, got '${positional[1]}'.`);
  }
  return runShell({ timeoutSeconds: options.timeout, input: process.stdin, output: process.stdout });
}

async function runTabsCommand(positional, options, provided) {
  rejectUnsupportedFlags('tabs', provided);
  if (positional.length > 1) {
    throw new UsageError(`tabs takes no positional arguments, got '${positional[1]}'.`);
  }
  return reportTabs(options);
}

async function requestWithRetries(plan, options, tries = 0) {
  try {
    return await attempt(plan, options);
  } catch (error) {
    const retryable = error instanceof BridgeError && !error.dispatched;
    if (!retryable || tries >= options.retries) throw error;
    await sleep(Math.min(RETRY_BASE_MS * (2 ** tries), RETRY_MAX_MS)); // NOSONAR Sequential retry backoff is required.
    return requestWithRetries(plan, options, tries + 1);
  }
}

async function reportToolError(reply, options) {
  const message = reply.error.message;
  if (options.json) await writeOut(envelope(EXIT.TOOL_ERROR, message));
  else await writeErr(`cic: ${JSON.stringify(reply.error)}\n`);
  return EXIT.TOOL_ERROR;
}

async function writeImageIfRequested(result, options) {
  if (!options.output || result.isError) return;
  const written = await writeImageResult(result, options.output);
  const named = options.output.toLowerCase();
  const mismatched = /\.[a-z0-9]+$/.test(named) && !named.endsWith(written.extension)
    && !(written.extension === '.jpg' && named.endsWith('.jpeg'));
  const message = mismatched
    ? `cic: wrote ${written.bytes} bytes of ${written.mime} to ${options.output}, whose name suggests a different format. ${written.extension} would match the bytes.\n`
    : `cic: wrote ${written.bytes} bytes of ${written.mime} to ${options.output}\n`;
  await writeErr(message);
}

async function reportJsonResult(result) {
  if (result.isError) {
    await writeOut(envelope(EXIT.TOOL_ERROR, textOf(result) || 'the tool reported an error'));
    return EXIT.TOOL_ERROR;
  }
  await writeOut(JSON.stringify(result) + '\n');
  return EXIT.OK;
}

async function reportPlainResult(plan, result) {
  const lines = plan.command === 'list'
    ? (result.tools || []).map((tool) => `- ${tool.name} :: ${(tool.description || '').split('\n')[0].slice(0, 80)}`)
    : (result.content || []).map((part) => (part.type === 'text' ? part.text : `[${part.type || '?'}]`));
  if (lines.length) await writeOut(lines.join('\n') + '\n');
  return result.isError ? EXIT.TOOL_ERROR : EXIT.OK;
}

async function reportReply(plan, reply, options) {
  if (reply.error) return reportToolError(reply, options);
  const result = reply.result;
  await writeImageIfRequested(result, options);
  return options.json ? reportJsonResult(result) : reportPlainResult(plan, result);
}

async function runOneShot(positional, options, provided) {
  const plan = planRequest(positional);
  rejectUnsupportedFlags(plan.command, provided);
  const reply = await requestWithRetries(plan, options);
  return reportReply(plan, reply, options);
}

async function dispatchCommand(positional, options, provided) {
  const command = positional[0];
  if (command === 'session') return runSessionCommand(positional, options, provided);
  if (command === 'shell') return runShellCommand(positional, options, provided);
  if (command === 'tabs') return runTabsCommand(positional, options, provided);
  return runOneShot(positional, options, provided);
}

async function main() {
  const { options, positional, provided, error } = parseArguments(process.argv.slice(2));
  if (error) throw new UsageError(error);
  if (options.version) {
    await writeOut(VERSION + '\n');
    return EXIT.OK;
  }
  if (options.help || positional.length === 0) {
    await writeOut(USAGE + '\n');
    return EXIT.OK;
  }
  return dispatchCommand(positional, options, provided);
}
/**
 * A failure before the request went out can never be UNKNOWN, and one after it
 * can never be TRANSPORT, because the browser may already have acted.
 */
function classify(failure) {
  if (failure instanceof UsageError) { return EXIT.USAGE; }
  if (failure instanceof BridgeError) { return failure.dispatched ? EXIT.UNKNOWN : EXIT.TRANSPORT; }
  // The browser did what it was asked and the file is what could not be
  // produced, so this is neither a tool error nor anything retryable. It gets
  // 64 as the code for "this invocation cannot be completed as written",
  // rather than a sixth code added to a contract frozen since 0.4.0.
  if (failure instanceof ImageOutputError) { return EXIT.USAGE; }
  // A tab that could not be created or navigated: the browser answered, and
  // what it said was no. A bridge that failed instead arrives as a BridgeError
  // above, which is what carries the dispatched boundary.
  if (failure instanceof TabLifecycleError) { return EXIT.TOOL_ERROR; }
  return EXIT.TRANSPORT;
}

async function runCli() {
  let asJson = false;
  try {
    // Parsed twice on the failure path only, so the error formatter knows
    // whether --json was asked for even when parsing itself failed.
    asJson = parseArguments(process.argv.slice(2)).options.json;
    process.exitCode = await main();
  } catch (error) {
    const exitCode = classify(error);
    const known = error instanceof UsageError || error instanceof BridgeError
      || error instanceof ImageOutputError || error instanceof TabLifecycleError;
    let message = known ? error.message : `unexpected failure: ${error?.message}`;
    // A tab deliberately left open is only useful if its id is said out loud,
    // since the whole reason for keeping it is that someone has to look at it.
    if (error?.tabLeftOpen) {
      message += ` Tab ${error.tabId} was left open on purpose, because closing a tab whose outcome is unknown could discard what it was doing.`;
    }
    // A cleanup that also failed is appended rather than dropped. Reporting only
    // why the work failed, while its tab is still sitting there, hides the one
    // thing this command exists to get right.
    if (error?.tabWarning) { message += ` ${error.tabWarning}`; }
    try {
      if (asJson) { await writeOut(envelope(exitCode, message)); }
      else { await writeErr(`cic: ${message}\n`); }
    } catch { /* the caller closed the stream; the exit code still stands */ }
    process.exitCode = exitCode;
  }
}

void runCli();
