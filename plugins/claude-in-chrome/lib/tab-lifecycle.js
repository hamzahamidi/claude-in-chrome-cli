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
 * The availableTabs payload out of a tabs_context_mcp reply.
 *
 * An empty group answers in prose rather than JSON, which is a state and not a
 * failure, so it reads as no tabs rather than as an unparseable reply.
 */
function contextOf(reply) {
  if (!reply || reply.error) { return null; }
  const text = textOf(reply.result);
  const match = /\{"availableTabs".*?\}\s*\]\s*,\s*"tabGroupId"\s*:\s*-?\d+\s*\}/s.exec(text);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* fall through to the prose case */ }
  }
  if (/no mcp tab group/i.test(text)) { return { availableTabs: [], tabGroupId: null }; }
  return null;
}

const tabsIn = (context) => (context && Array.isArray(context.availableTabs) ? context.availableTabs : []);

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
async function closeTab(session, tabId, timeoutSeconds, { keepGroupAlive = false } = {}) {
  // Closing a group's FIRST tab makes the bridge lose the entire group, and
  // every other tab in it becomes invisible and unclosable from any session.
  // Those unreachable groups are what pile up as identical pills in the tab
  // strip, so this refuses rather than making one. A tab of ours left open is
  // the cheaper mistake by a wide margin.
  // contextOf returns null for a reply it cannot read and an empty tab list for a
  // group that really is empty. Collapsing those with tabsIn() made the
  // unreadable case look like an empty group and fail OPEN, which is the wrong
  // direction for a guard whose whole purpose is refusing to orphan tabs.
  let context;
  try {
    context = contextOf(await session.call('tools/call',
      { name: 'tabs_context_mcp', arguments: {} }, { timeoutSeconds }));
  } catch (failure) {
    return `tab ${tabId} was left open: the group could not be read first, and closing blind `
      + `risks orphaning tabs in it (${failure.message})`;
  }
  if (context === null) {
    return `tab ${tabId} was left open: the group could not be read first, and closing blind `
      + 'risks orphaning tabs in it';
  }
  const tabs = tabsIn(context);
  if (tabs.length > 1 && tabs[0].tabId === tabId) {
    return `tab ${tabId} was left open: it is the first tab in its group, and closing it would `
      + `make the bridge lose the group along with the ${tabs.length - 1} other tab(s) in it`;
  }
  // Emptying a group leaves its pill behind in the tab strip, and nothing can
  // reach it afterwards: Chromium records no group-lifecycle event, so a group
  // exists only while a tab implies it, and an emptied one becomes a runtime
  // artifact invisible even on disk. Measured by diffing the session file around
  // a known create and close: closing the last tab produced no group command at
  // all. So a group this opened is kept alive with one tab instead, which the
  // next run reuses rather than opening another. Steady state is one group and
  // one spare tab, rather than one more pill per invocation.
  if (keepGroupAlive && tabs.length === 1 && tabs[0].tabId === tabId) {
    return null;
  }

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
  // tabs_create_mcp requires a group to exist already: with none, it refuses and
  // points at tabs_context_mcp. Shipped 0.7.0 called it straight away and so
  // failed for anyone whose group was empty, which is the ordinary case. Every
  // live check passed anyway because a group happened to exist from earlier work,
  // and the stub answered create unconditionally, so nothing caught it.
  //
  // The group is therefore established first. When it did not exist,
  // createIfEmpty hands back the tab it just made and that tab is ours to drive.
  // When it did exist, a fresh tab is created instead, because a tab this did not
  // make must never be navigated.
  const existing = tabsIn(contextOf(await session.call('tools/call',
    { name: 'tabs_context_mcp', arguments: {} }, { timeoutSeconds })));

  let tabId;
  // True when this call is what brought the group into being, which is the only
  // case where emptying it again would strand a pill.
  let openedGroup = false;
  if (existing.length === 0) {
    openedGroup = true;
    const opened = await session.call('tools/call',
      { name: 'tabs_context_mcp', arguments: { createIfEmpty: true } }, { timeoutSeconds });
    const openRefusal = refusalIn(opened);
    if (openRefusal) { throw new TabLifecycleError(`could not open a tab group: ${openRefusal}`); }
    const tabs = tabsIn(contextOf(opened));
    if (tabs.length === 0) {
      throw new TabLifecycleError('could not open a tab group to work in');
    }
    tabId = tabs[0].tabId;
  } else {
    const created = await session.call('tools/call',
      { name: 'tabs_create_mcp', arguments: {} }, { timeoutSeconds });
    const createRefusal = refusalIn(created);
    if (createRefusal) { throw new TabLifecycleError(`could not create a tab: ${createRefusal}`); }
    tabId = tabIdFrom(created.result);
  }

  try {
    if (url !== undefined) {
      const moved = await session.call('tools/call',
        { name: 'navigate', arguments: { url, tabId } }, { timeoutSeconds });
      const moveRefusal = refusalIn(moved);
      if (moveRefusal) { throw new TabLifecycleError(`could not navigate to ${url}: ${moveRefusal}`); }
    }
    const outcome = await body(tabId);
    if (!keepTab) {
      const warning = await closeTab(session, tabId, timeoutSeconds, { keepGroupAlive: openedGroup });
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
      const warning = await closeTab(session, tabId, timeoutSeconds, { keepGroupAlive: openedGroup });
      if (warning) {
        failure.tabWarning = warning;
        failure.tabId = tabId;
      }
    }
    throw failure;
  }
}

module.exports = { withTab, closeTab, tabIdFrom, refusalIn, contextOf, tabsIn, TabLifecycleError };
