// Borrowing a tab for one piece of work, and cleaning up after it.
//
// Separate from BridgeSession on purpose. That class is the generic protocol
// layer: it knows about requests, replies, ids and whether bytes reached the
// child, and nothing about what any particular tool is called. This file is the
// opposite, and it is where `tabs_create_mcp`, `navigate` and `tabs_close_mcp`
// are allowed to be named. Keeping them out of the session is what stops the
// protocol layer from slowly accumulating knowledge of the browser.
'use strict';

const { BridgeError } = require('./bridge-session.js');

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

const textOf = (result) => (result && result.content ? result.content : [])
  .filter((part) => part && part.type === 'text')
  .map((part) => part.text)
  .join('\n');

/**
 * The message a failed call carries, whichever of the two ways it failed.
 *
 * A reply is a JSON-RPC error or a result, never both, and a result can still
 * carry isError. Reading `.result` without checking `.error` first is how this
 * threw a TypeError on a lifecycle tool that answered with an error: the CLI
 * then classified an unrecognized exception as exit 3, which promises the
 * browser cannot have acted. For a failed navigate a tab certainly existed
 * already, and exit 3 is the one class --retries repeats.
 */
function refusalIn(reply) {
  if (reply.error) { return reply.error.message; }
  if (reply.result.isError) { return textOf(reply.result) || 'the tool reported an error'; }
  return null;
}

/**
 * Digs the new tab's id out of what tabs_create_mcp said.
 *
 * This is the one place anything reads meaning out of the bridge's prose rather
 * than out of a field, because the id is only ever reported in a sentence. It
 * fails loudly: a silent miss here would address every later call to nothing.
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

/**
 * Closes a tab on the way out. Returns a description of what went wrong rather
 * than throwing, because this runs while another outcome is already being
 * reported and must not replace it.
 */
async function closeTab(session, tabId, timeoutSeconds) {
  try {
    const reply = await session.call('tools/call',
      { name: 'tabs_close_mcp', arguments: { tabId } }, { timeoutSeconds });
    const refusal = refusalIn(reply);
    return refusal ? `tab ${tabId} may still be open: ${refusal}` : null;
  } catch (failure) {
    return `tab ${tabId} may still be open: ${failure.message}`;
  }
}

/**
 * Creates a tab, optionally navigates it, hands the tabId to `body`, and closes
 * the tab when it is done.
 *
 * The cleanup rule is the point of this helper, and it is fail-closed. A tab is
 * closed after success and after an ordinary tool error, because both mean the
 * browser finished and said so. It is deliberately NOT closed after an unknown
 * outcome: the request reached the browser and nobody knows whether it acted, so
 * closing could discard a half-finished action and destroy the only evidence of
 * what happened. The tab is left open and identified instead, on `tabId` and
 * `tabLeftOpen` of the thrown error.
 *
 * A cleanup failure never replaces the outcome that was already being reported.
 * After success it comes back as `tabWarning` on the result; after a failure it
 * is attached to that failure as `tabWarning`, because a tab that may still be
 * open is exactly what someone needs to know while reading why the work failed.
 */
async function withTab(session, { url, keepTab = false, timeoutSeconds } = {}, body) {
  const created = await session.call('tools/call',
    { name: 'tabs_create_mcp', arguments: {} }, { timeoutSeconds });
  const createRefusal = refusalIn(created);
  if (createRefusal) { throw new TabLifecycleError(`could not create a tab: ${createRefusal}`); }
  const tabId = tabIdFrom(created.result);

  try {
    if (url !== undefined) {
      const moved = await session.call('tools/call',
        { name: 'navigate', arguments: { url, tabId } }, { timeoutSeconds });
      const moveRefusal = refusalIn(moved);
      if (moveRefusal) { throw new TabLifecycleError(`could not navigate to ${url}: ${moveRefusal}`); }
    }
    const outcome = await body(tabId);
    if (!keepTab) {
      const warning = await closeTab(session, tabId, timeoutSeconds);
      if (warning) { return { outcome, tabWarning: warning, tabId }; }
    }
    return { outcome, tabId };
  } catch (failure) {
    // Only a dispatched failure is unknown. One that never reached the browser
    // leaves the tab in a known state, so it is still tidied up.
    if (failure instanceof BridgeError && failure.dispatched) {
      failure.tabId = tabId;
      failure.tabLeftOpen = true;
      throw failure;
    }
    if (!keepTab) {
      const warning = await closeTab(session, tabId, timeoutSeconds);
      if (warning) {
        failure.tabWarning = warning;
        failure.tabId = tabId;
      }
    }
    throw failure;
  }
}

module.exports = { withTab, closeTab, tabIdFrom, refusalIn, TabLifecycleError };
