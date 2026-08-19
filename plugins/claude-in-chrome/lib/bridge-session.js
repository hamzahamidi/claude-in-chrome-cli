// One MCP protocol implementation, owned here rather than in the command line.
//
// A BridgeSession is the whole lifecycle of talking to
// `claude --claude-in-chrome-mcp`: spawn the child, negotiate initialization in
// the order the specification requires, allocate request ids, validate replies
// before anyone reads them, and terminate and reap the child on the way out.
//
// The command line above this decides what to print and what to exit with. It
// does not know how the protocol works, and this file does not know that exit
// codes exist beyond carrying the one fact that decides them: whether a request
// reached the child.
'use strict';

const { spawn } = require('child_process');

const CLIENT_PROTOCOL = '2024-11-05';
// Versions whose handshake this client understands. A server answering with
// anything else has not agreed a protocol, so no request is ever sent.
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
// How long a terminated child gets to leave before SIGKILL. A child that
// ignores SIGTERM would otherwise outlive every call and accumulate. On Windows
// a signal cannot be refused, so this grace never elapses there.
const TERMINATE_GRACE_MS = 2000;

/**
 * `dispatched` is the only thing the caller needs to classify this: false means
 * the request never reached the child, so the browser cannot have acted.
 */
class BridgeError extends Error {
  constructor(message, { dispatched = false, handshake = false } = {}) {
    super(message);
    this.dispatched = dispatched;
    this.handshake = handshake;
  }
}

/**
 * A tab could not be set up because the browser answered and said no. Always a
 * tool error: the bridge worked, the tool refused. A bridge that fails instead
 * raises BridgeError, which is what carries the dispatched boundary.
 */
class TabLifecycleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TabLifecycleError';
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const textOf = (result) => (result && result.content ? result.content : [])
  .filter((part) => part && part.type === 'text')
  .map((part) => part.text)
  .join('\n');

/**
 * Digs the new tab's id out of what tabs_create_mcp said.
 *
 * This is the one place the client reads meaning out of the bridge's prose
 * rather than out of a field, because the id is only ever reported in a
 * sentence. It is deliberately narrow and it fails loudly: a silent miss here
 * would send every later call to the wrong tab, or to no tab at all.
 */
function tabIdFrom(result) {
  const match = /Tab ID:\s*(\d+)/.exec(textOf(result));
  if (!match) {
    // Dispatched, so exit 2 rather than 3. A tab was made and the reply simply
    // did not say which one, which leaves a real tab nobody can address. Exit 3
    // would claim the browser never acted and is the one class --retries will
    // repeat, and repeating this creates a second orphan.
    throw new BridgeError(
      'the bridge created a tab but did not report its id, so it cannot be addressed or found again.',
      { dispatched: true });
  }
  return Number(match[1]);
}

/** JSON-RPC requires the code to be an integer, and MCP the message a string. */
function describeBadError(error) {
  if (!isPlainObject(error)) { return 'an error that is not an object'; }
  // An integer, not merely a number: 1.5 and NaN are not JSON-RPC error codes,
  // and accepting them means passing something meaningless to a caller
  // deciding what to do next.
  if (!Number.isInteger(error.code)) { return 'an error whose code is not an integer'; }
  if (typeof error.message !== 'string') { return 'an error whose message is not a string'; }
  return null;
}

/**
 * Describes what is wrong with a result for the method that asked for it.
 *
 * Each method promises one shape. Checking only that the outer array exists
 * left its members free to be anything, and the plain and --json paths then
 * disagreed about them: plain printed `undefined` for a text part with no text
 * while --json passed the same part through as a success.
 */
function describeBadResult(result, method) {
  if (!isPlainObject(result)) { return 'a result that is not an object'; }

  if (method === 'initialize') {
    if (typeof result.protocolVersion !== 'string') {
      return 'an initialize result whose protocolVersion is not a string';
    }
    return null;
  }

  if (method === 'tools/list') {
    if (!Array.isArray(result.tools)) { return 'a tools/list result without a tools array'; }
    for (const tool of result.tools) {
      if (!isPlainObject(tool)) { return 'a tools/list result holding an entry that is not an object'; }
      if (typeof tool.name !== 'string' || tool.name === '') {
        return 'a tools/list result holding a tool without a name';
      }
      if (tool.description !== undefined && typeof tool.description !== 'string') {
        return 'a tools/list result holding a tool whose description is not a string';
      }
    }
    return null;
  }

  if (!Array.isArray(result.content)) { return 'a tools/call result without a content array'; }
  // isError decides the exit code, so a non-boolean here would make the
  // difference between success and failure depend on JavaScript truthiness.
  if (result.isError !== undefined && typeof result.isError !== 'boolean') {
    return 'a tools/call result whose isError is not a boolean';
  }
  for (const part of result.content) {
    if (!isPlainObject(part)) { return 'a tools/call result holding a content part that is not an object'; }
    if (typeof part.type !== 'string' || part.type === '') {
      return 'a tools/call result holding a content part without a type';
    }
    if (part.type === 'text' && typeof part.text !== 'string') {
      return 'a tools/call result holding a text part whose text is not a string';
    }
  }
  return null;
}

/**
 * Describes what is wrong with a reply, or returns null when it is usable.
 *
 * A reply that parsed and carries the right id is still not an answer. These
 * checks are the whole reason the exit codes mean anything: an error whose
 * message is a number would have gone straight into the frozen envelope as a
 * number, and a result missing its required array would have printed nothing
 * and exited 0.
 */
function describeBadReply(reply, method) {
  const hasResult = Object.prototype.hasOwnProperty.call(reply, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(reply, 'error');

  // JSON-RPC allows exactly one. Both together means the server contradicted
  // itself, and picking either one is guessing which half to believe.
  if (hasResult === hasError) {
    return hasResult
      ? 'replied with both a result and an error'
      : 'replied without a result or an error';
  }

  const bad = hasError
    ? describeBadError(reply.error)
    : describeBadResult(reply.result, method);
  return bad ? `replied with ${bad}` : null;
}

class BridgeSession {
  constructor({ binary, binaryArguments, timeoutSeconds } = {}) {
    this.binary = binary || process.env.CIC_CLAUDE_BIN || 'claude';
    this.binaryArguments = binaryArguments || (process.env.CIC_CLAUDE_ARGS
      ? process.env.CIC_CLAUDE_ARGS.split(' ').filter(Boolean)
      : ['--claude-in-chrome-mcp']);
    this.timeoutSeconds = timeoutSeconds;
    this.child = null;
    // True once any request has been written. A one-shot caller reads this to
    // classify a failure; a long-lived session classifies per call instead,
    // from the waiter's own `sent` flag, because one unknown outcome must not
    // relabel every later call.
    this.dispatched = false;
    this.nextId = 1;
    this.closed = false;
    // id -> waiter. One reader serves all of them: a reader per request dropped
    // whatever arrived between requests, which serialized one-shot use never
    // noticed and a streaming session would have.
    this.waiters = new Map();
    this.readBuffer = '';
    this.readerAttached = false;
  }

  /** Spawn the child and complete initialization, or throw with dispatched false. */
  async open() {
    try {
      this.child = spawn(this.binary, this.binaryArguments, { stdio: ['pipe', 'pipe', 'inherit'] });
    } catch (failure) {
      throw new BridgeError(`could not start ${this.binary}: ${failure.message}`, { handshake: true });
    }
    this.#attachReader();

    const id = this.nextId++;
    const pending = this.#awaitReply(id, this.timeoutSeconds);
    // Whichever error wins the race below, the loser must still count as
    // handled or Node kills the process on the late rejection.
    pending.catch(() => {});
    await this.#send({
      jsonrpc: '2.0', id, method: 'initialize',
      params: {
        protocolVersion: CLIENT_PROTOCOL, capabilities: {},
        clientInfo: { name: 'cic', version: this.clientVersion || '0.6.0' },
      },
    }, pending);
    const initialized = await pending;

    // The handshake reply gets the same scrutiny as a tool reply. Everything
    // here is still pre-dispatch: nothing was sent to the browser.
    const badInitialize = describeBadReply(initialized, 'initialize');
    if (badInitialize) {
      throw new BridgeError(`the bridge ${badInitialize} while initializing.`, { handshake: true });
    }
    if (initialized.error) {
      throw new BridgeError(
        `the bridge refused the handshake: ${JSON.stringify(initialized.error)}`, { handshake: true });
    }
    const agreed = initialized.result.protocolVersion;
    if (!SUPPORTED_PROTOCOLS.has(agreed)) {
      throw new BridgeError(
        `the bridge answered with unsupported protocol version ${JSON.stringify(agreed)}.`,
        { handshake: true });
    }

    // Only now is the session initialized, so requests may go out.
    await this.#send({ jsonrpc: '2.0', method: 'notifications/initialized' }, null);
    return initialized.result;
  }

  /**
   * One request, one validated reply. Calls are serialized: the caller awaits
   * each before issuing the next, so reply demultiplexing is not yet a public
   * behaviour even though ids are already allocated per request.
   */
  async call(method, params, { timeoutSeconds } = {}) {
    if (this.closed) { throw new BridgeError('the session is closed.', { handshake: true }); }
    const id = this.nextId++;
    const pending = this.#awaitReply(id, timeoutSeconds || this.timeoutSeconds);
    pending.catch(() => {});
    // Marked sent before the write, not after it. Waiting for the write callback
    // left a window where the child had already received the request and
    // replied, or died, while this still said nothing was dispatched: the
    // failure was then classified exit 3 and --retries would repeat an action
    // that had already run. Once the bytes are handed to the pipe the outcome is
    // unknowable, so the flag has to lead the write rather than follow it. A
    // write that then fails outright still counts as sent, because a broken pipe
    // does not prove nothing arrived, and of the two ways to guess wrong only
    // that one can repeat a click.
    const waiter = this.waiters.get(id);
    if (waiter) { waiter.sent = true; }
    this.dispatched = true;
    await this.#send({ jsonrpc: '2.0', id, method, params }, pending);

    const reply = await pending;
    const bad = describeBadReply(reply, method);
    if (bad) {
      throw new BridgeError(`the bridge ${bad}, so the outcome is unknown.`, { dispatched: true });
    }
    return reply;
  }

  /**
   * Creates a tab, optionally navigates it, hands the tabId to `body`, and
   * closes the tab when it is done.
   *
   * The cleanup rule is the point of this helper, and it is fail-closed. A tab
   * is closed after success and after an ordinary tool error, because both mean
   * the browser finished and said so. It is deliberately NOT closed after an
   * unknown outcome: the request reached the browser and nobody knows whether it
   * acted, so closing could discard a half-finished action and destroy the only
   * evidence of what happened. The tab is left open and identified instead, on
   * `tabId` and `tabLeftOpen` of the thrown error, so a caller can say which one.
   *
   * A cleanup failure after a successful body does not turn success into
   * failure. The work the caller asked for finished; a stray tab is untidy, not
   * a wrong answer, and it is reported through `tabWarning` on the result.
   */
  async withTab({ url, keepTab = false, timeoutSeconds } = {}, body) {
    const created = await this.call('tools/call',
      { name: 'tabs_create_mcp', arguments: {} }, { timeoutSeconds });
    if (created.result.isError) {
      throw new TabLifecycleError(`could not create a tab: ${textOf(created.result) || 'the tool reported an error'}`);
    }
    const tabId = tabIdFrom(created.result);

    let leaveOpen = false;
    try {
      if (url !== undefined) {
        const moved = await this.call('tools/call',
          { name: 'navigate', arguments: { url, tabId } }, { timeoutSeconds });
        if (moved.result.isError) {
          throw new TabLifecycleError(
            `could not navigate to ${url}: ${textOf(moved.result) || 'the tool reported an error'}`,
            );
        }
      }
      const outcome = await body(tabId);
      if (!keepTab) {
        const warning = await this.#closeTab(tabId, timeoutSeconds);
        if (warning) { return { outcome, tabWarning: warning, tabId }; }
      }
      return { outcome, tabId };
    } catch (failure) {
      // Only a dispatched failure is unknown. One that never reached the
      // browser leaves the tab in a known state, so it is still tidied up.
      if (failure instanceof BridgeError && failure.dispatched) {
        leaveOpen = true;
        failure.tabId = tabId;
        failure.tabLeftOpen = true;
      }
      if (!leaveOpen && !keepTab) {
        await this.#closeTab(tabId, timeoutSeconds);
      }
      throw failure;
    }
  }

  /**
   * Closes a tab on the way out. Returns a description of what went wrong
   * rather than throwing, because this runs while another outcome is already
   * being reported and must not replace it.
   */
  async #closeTab(tabId, timeoutSeconds) {
    try {
      const closed = await this.call('tools/call',
        { name: 'tabs_close_mcp', arguments: { tabId } }, { timeoutSeconds });
      if (closed.result.isError) {
        return `tab ${tabId} may still be open: ${textOf(closed.result) || 'the tool reported an error'}`;
      }
      return null;
    } catch (failure) {
      return `tab ${tabId} may still be open: ${failure.message}`;
    }
  }

  /**
   * SIGTERM, then SIGKILL if that is ignored, and wait for the child to go.
   *
   * Releasing the pipes is not optional cleanup. A descendant of the bridge can
   * hold the bridge's stdout open after the bridge itself has exited, and that
   * handle alone kept the process alive indefinitely with nothing left to read.
   */
  close() {
    const child = this.child;
    this.closed = true;
    if (!child) { return Promise.resolve(); }

    const release = () => {
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        try { if (stream) { stream.destroy(); } } catch { /* already gone */ }
      }
      try { child.unref(); } catch { /* not refcounted */ }
    };

    if (child.exitCode !== null || child.signalCode !== null) {
      release();
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(escalate);
        clearTimeout(giveUp);
        release();
        resolve();
      };
      // On Windows a signal cannot be refused, so this never fires there.
      const escalate = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, TERMINATE_GRACE_MS);
      // Never hang a caller on a child that cannot be reaped at all.
      const giveUp = setTimeout(done, TERMINATE_GRACE_MS * 2);
      child.once('close', done);
      try { child.stdin.destroy(); } catch { /* already closed */ }
      try { child.kill('SIGTERM'); } catch { done(); }
    });
  }

  /**
   * A failed write only ever reports a broken pipe. The child's own error event
   * carries the reason it broke (`spawn ... ENOENT` for a missing binary), and
   * the pending reply promise is what surfaces it, so on a write failure let
   * that promise speak first.
   */
  async #send(object, pending) {
    const child = this.child;
    try {
      await new Promise((resolve, reject) => {
        child.stdin.write(JSON.stringify(object) + '\n', (failure) => {
          if (failure) {
            reject(new BridgeError(`could not reach ${this.binary}: ${failure.message}`,
              { dispatched: this.dispatched, handshake: !this.dispatched }));
          } else { resolve(); }
        });
      });
    } catch (writeFailure) {
      if (pending) { await pending; }
      throw writeFailure;
    }
  }

  /**
   * One reader for the whole session, attached at open(). Each request registers
   * a waiter under its id; this dispatches lines to them. A reader per request
   * meant bytes arriving between requests were dropped, which serialized
   * one-shot use never noticed and a streaming session would have.
   */
  #attachReader() {
    if (this.readerAttached) { return; }
    this.readerAttached = true;
    const child = this.child;

    const onLine = (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      // Valid JSON is not necessarily a message: `null`, a number and an array
      // all parse, and dereferencing them threw an uncaught TypeError straight
      // out of this handler. Anything that is not an object is log noise.
      if (!isPlainObject(message)) { return; }
      const waiter = this.waiters.get(message.id);
      // A reply nobody is waiting for is not an error: a late answer to a call
      // that already timed out has nowhere to go, and dropping it is right.
      if (!waiter) { return; }
      if (message.jsonrpc !== '2.0') {
        waiter.fail(`replied to request ${message.id} without a JSON-RPC 2.0 envelope, so the outcome is unknown.`);
        return;
      }
      waiter.settle(message);
    };

    const consume = (text, isFinal) => {
      this.readBuffer += text;
      let index;
      while ((index = this.readBuffer.indexOf('\n')) !== -1) {
        const line = this.readBuffer.slice(0, index).trim();
        this.readBuffer = this.readBuffer.slice(index + 1);
        if (line) { onLine(line); }
      }
      if (isFinal && this.readBuffer.trim()) {
        onLine(this.readBuffer.trim());
        this.readBuffer = '';
      }
    };

    // A child that dies fails every outstanding call, each classified by
    // whether its own request had been written.
    const failAll = (message) => {
      for (const waiter of [...this.waiters.values()]) { waiter.fail(message); }
    };

    child.stdout.on('data', (chunk) => consume(String(chunk), false));
    child.stdout.on('end', () => consume('', true));
    child.on('exit', (code) => {
      // Let the final stdout chunk land before calling this no reply.
      setImmediate(() => failAll(`the bridge exited (code ${code}) before a usable reply arrived.`));
    });
    child.on('error', (error) => failAll(`bridge failed: ${error.message}`));
  }

  /** Resolves once the reply to `id` arrives, or rejects with a BridgeError. */
  #awaitReply(id, timeoutSeconds) {
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(waiter.timer);
        this.waiters.delete(id);
      };
      const waiter = {
        // Whether this particular request reached the pipe. Per waiter rather
        // than per session: in a long-lived session one unknown outcome must not
        // relabel the classification of every later call.
        sent: false,
        timer: null,
        settle: (message) => { done(); resolve(message); },
        fail: (message) => {
          done();
          reject(new BridgeError(message, { dispatched: waiter.sent, handshake: !waiter.sent }));
        },
      };
      waiter.timer = setTimeout(() => {
        waiter.fail(`no reply within ${timeoutSeconds}s. Raise --timeout, or check that the Claude in Chrome extension is connected.`);
      }, timeoutSeconds * 1000);
      this.waiters.set(id, waiter);
    });
  }
}

module.exports = {
  BridgeSession,
  BridgeError,
  TabLifecycleError,
  describeBadReply,
  tabIdFrom,
  SUPPORTED_PROTOCOLS,
  TERMINATE_GRACE_MS,
};
