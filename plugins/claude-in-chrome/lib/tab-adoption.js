// Adopting a tab the user already has open.
//
// The bridge only ever sees tabs inside its own group and has no tool to move
// one in, so the user does it themselves through Chrome's tab context menu. All
// this does is make that safe to detect: hold a group open, watch what appears,
// and refuse to guess.
//
// Three rules here come from measurement against a live bridge rather than from
// taste:
//
//   The anchor owns the group. Closing a group's first tab makes the bridge lose
//   the whole group, orphaning every other tab in it, so an anchor this created
//   is never closed while an adopted tab is still managed.
//
//   Detection is not adoption. A blank tab appearing in the group is a perfectly
//   stable singleton addition, and a chrome:// page cannot be driven at all, so
//   a candidate has to answer a read-only call before it counts.
//
//   Identity is the live id and nothing else. Title and URL are shown to a human
//   and never used to decide which tab was meant.
'use strict';

const { contextOf, tabsIn } = require('./tab-lifecycle.js');

const DEFAULT_POLL_MS = 1500;

/** Adoption could not be completed. Never raised for a user cancelling. */
class AdoptionError extends Error {
  constructor(message, { kind = 'failed' } = {}) {
    super(message);
    this.name = 'AdoptionError';
    this.kind = kind;
  }
}

/**
 * Whether a candidate is worth offering to the capability check at all.
 *
 * A prompt-level filter only: these schemes cannot be driven, so saying so early
 * beats waiting for the check to fail. The check still decides, because this
 * list can never be complete.
 */
const looksInternal = (tab) => /^(chrome|chrome-extension|devtools|about|edge|brave|view-source):/i.test(tab.url || '');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Runs the adoption protocol on an already-open session.
 *
 * Returns `{ outcome: 'adopted' | 'cancelled' | 'timeout', ... }`. It throws
 * only when no group can be held open at all, because every other ending is
 * something to report to a human rather than an exception.
 *
 * `notify` receives progress as plain objects, so a shell can render them and a
 * test can assert them. `cancelled()` is polled between steps rather than
 * interrupting a call in flight: a read-only poll is allowed to settle, which
 * keeps cancellation from inventing a new unknown-outcome class.
 */
async function establishGroup(call, notify) {
  const baseline = new Set();
  const opening = await call('tabs_context_mcp', {});
  const context = contextOf(opening);
  const currentTabs = tabsIn(context);
  if (currentTabs.length) {
    for (const tab of currentTabs) baseline.add(tab.tabId);
    const anchor = currentTabs[0].tabId;
    notify({ kind: 'group-exists', tabs: baseline.size });
    return { anchor, anchorCreated: false, baseline };
  }

  const made = await call('tabs_context_mcp', { createIfEmpty: true });
  const tabs = tabsIn(contextOf(made));
  if (!tabs.length) {
    throw new AdoptionError(
      'could not open a tab group for you to move a tab into', { kind: 'no-group' });
  }
  const anchor = tabs[0].tabId;
  for (const tab of tabs) baseline.add(tab.tabId);
  notify({ kind: 'anchor-created', anchor });
  return { anchor, anchorCreated: true, baseline };
}

async function inspectCandidate(call, state, notify) {
  const now = contextOf(await call('tabs_context_mcp', {}));
  const currentTabs = tabsIn(now);
  const ids = new Set(currentTabs.map((tab) => tab.tabId));
  if (!ids.size) {
    return replaceAnchor(call, state, notify);
  }

  const addedTabs = currentTabs.filter((tab) => !state.baseline.has(tab.tabId));
  const candidates = addedTabs.filter((tab) => !looksInternal(tab));
  const internals = addedTabs.filter((tab) => looksInternal(tab));
  if (!candidates.length) {
    state.previous = null;
    state.announcedExtras = 0;
    reportInternalTab(internals, state, notify);
    return null;
  }
  if (candidates.length > 1) {
    reportTooMany(candidates.length, state, notify);
    state.previous = null;
    return null;
  }

  state.announcedExtras = 0;
  const candidate = candidates[0];
  if (state.previous !== candidate.tabId) {
    state.previous = candidate.tabId;
    return null;
  }
  const probe = await call('javascript_tool', {
    action: 'javascript_exec', tabId: candidate.tabId, text: 'String(document.title.length)',
  });
  if (probe.error || probe.result?.isError) {
    notify({ kind: 'not-drivable', tab: candidate });
    state.previous = null;
    return null;
  }
  return candidate;
}

async function replaceAnchor(call, state, notify) {
  if (state.anchor !== null) state.baseline.delete(state.anchor);
  const fresh = contextOf(await call('tabs_context_mcp', { createIfEmpty: true }));
  const tabs = tabsIn(fresh);
  if (!tabs.length) {
    throw new AdoptionError('the tab group went away and could not be reopened', { kind: 'no-group' });
  }
  state.anchor = tabs[0].tabId;
  state.anchorCreated = true;
  state.baseline.add(state.anchor);
  state.previous = null;
  notify({ kind: 'anchor-replaced', anchor: state.anchor });
  return null;
}

function reportInternalTab(internals, state, notify) {
  if (!internals.length) {
    state.announcedInternal = null;
    return;
  }
  const signature = internals.map((tab) => tab.tabId).sort().join(',');
  if (state.announcedInternal === signature) return;
  state.announcedInternal = signature;
  notify({ kind: 'internal-tab', tab: internals[0] });
}

function reportTooMany(candidateCount, state, notify) {
  if (state.announcedExtras !== candidateCount) {
    state.announcedExtras = candidateCount;
    notify({ kind: 'too-many', count: candidateCount });
  }
}

async function adoptTab(session, {
  timeoutSeconds = 300,
  pollMs = DEFAULT_POLL_MS,
  notify = () => {},
  cancelled = () => false,
} = {}) {
  const call = (name, args) => session.call('tools/call', { name, arguments: args });
  const group = await establishGroup(call, notify);
  const state = {
    ...group,
    previous: null,
    announcedInternal: null,
    announcedExtras: 0,
    polls: 0,
  };
  notify({ kind: 'waiting' });

  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (cancelled()) return { outcome: 'cancelled', anchor: state.anchor, anchorCreated: state.anchorCreated, polls: state.polls };
    await sleep(pollMs);
    if (cancelled()) return { outcome: 'cancelled', anchor: state.anchor, anchorCreated: state.anchorCreated, polls: state.polls };
    state.polls++;
    const candidate = await inspectCandidate(call, state, notify);
    if (!candidate) continue;
    notify({ kind: 'adopted', tab: candidate, anchor: state.anchor, anchorCreated: state.anchorCreated });
    return { outcome: 'adopted', tab: candidate, anchor: state.anchor, anchorCreated: state.anchorCreated, polls: state.polls };
  }

  return { outcome: 'timeout', anchor: state.anchor, anchorCreated: state.anchorCreated, polls: state.polls };
}
module.exports = { adoptTab, AdoptionError, contextOf, tabsIn, looksInternal, DEFAULT_POLL_MS };
