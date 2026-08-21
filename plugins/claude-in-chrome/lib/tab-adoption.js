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

const DEFAULT_POLL_MS = 1500;

/** Adoption could not be completed. Never raised for a user cancelling. */
class AdoptionError extends Error {
  constructor(message, { kind = 'failed' } = {}) {
    super(message);
    this.name = 'AdoptionError';
    this.kind = kind;
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
async function adoptTab(session, {
  timeoutSeconds = 300,
  pollMs = DEFAULT_POLL_MS,
  notify = () => {},
  cancelled = () => false,
} = {}) {
  const call = (name, args) => session.call('tools/call', { name, arguments: args });

  // ---- hold a group open, without disturbing one that already exists ------
  let anchor = null;
  let anchorCreated = false;
  const baseline = new Set();

  const opening = await call('tabs_context_mcp', {});
  let context = contextOf(opening);

  if (tabsIn(context).length > 0) {
    for (const tab of tabsIn(context)) { baseline.add(tab.tabId); }
    anchor = tabsIn(context)[0].tabId;
    notify({ kind: 'group-exists', tabs: baseline.size });
  } else {
    const made = await call('tabs_context_mcp', { createIfEmpty: true });
    context = contextOf(made);
    if (tabsIn(context).length === 0) {
      throw new AdoptionError(
        'could not open a tab group for you to move a tab into', { kind: 'no-group' });
    }
    anchor = tabsIn(context)[0].tabId;
    anchorCreated = true;
    for (const tab of tabsIn(context)) { baseline.add(tab.tabId); }
    notify({ kind: 'anchor-created', anchor });
  }

  notify({ kind: 'waiting' });

  // ---- watch for exactly one new tab that can actually be driven ----------
  const deadline = Date.now() + timeoutSeconds * 1000;
  let previous = null;
  let announcedInternal = null;
  let announcedExtras = 0;
  let polls = 0;

  while (Date.now() < deadline) {
    if (cancelled()) { return { outcome: 'cancelled', anchor, anchorCreated, polls }; }
    await sleep(pollMs);
    if (cancelled()) { return { outcome: 'cancelled', anchor, anchorCreated, polls }; }

    polls++;
    const now = contextOf(await call('tabs_context_mcp', {}));
    const ids = new Set(tabsIn(now).map((tab) => tab.tabId));

    // The group emptied out: whatever held it open is gone and nothing has been
    // moved in. Replace the anchor rather than abort, since a closed id can
    // never come back as an addition and the baseline stays sound.
    if (ids.size === 0) {
      if (anchor !== null) { baseline.delete(anchor); }
      const fresh = contextOf(await call('tabs_context_mcp', { createIfEmpty: true }));
      if (tabsIn(fresh).length === 0) {
        throw new AdoptionError('the tab group went away and could not be reopened', { kind: 'no-group' });
      }
      anchor = tabsIn(fresh)[0].tabId;
      anchorCreated = true;
      baseline.add(anchor);
      previous = null;
      notify({ kind: 'anchor-replaced', anchor });
      continue;
    }

    const addedTabs = tabsIn(now).filter((tab) => !baseline.has(tab.tabId));
    // Only a drivable-looking tab can be ambiguous. A blank chrome:// tab can
    // never be adopted, so it contributes no ambiguity and must not force the
    // user through a "move the extras out" round-trip alongside a real one.
    const candidates = addedTabs.filter((tab) => !looksInternal(tab));
    const internals = addedTabs.filter((tab) => looksInternal(tab));

    if (candidates.length === 0) {
      previous = null;
      announcedExtras = 0;
      if (internals.length > 0) {
        const signature = internals.map((tab) => tab.tabId).sort().join(',');
        if (announcedInternal !== signature) {
          announcedInternal = signature;
          notify({ kind: 'internal-tab', tab: internals[0] });
        }
      } else {
        announcedInternal = null;
      }
      continue;
    }

    if (candidates.length > 1) {
      // Recoverable by design: say what is ambiguous and keep waiting, rather
      // than making a human start over because they moved two tabs.
      if (announcedExtras !== candidates.length) {
        announcedExtras = candidates.length;
        notify({ kind: 'too-many', count: candidates.length });
      }
      previous = null;
      continue;
    }
    announcedExtras = 0;

    const candidate = candidates[0];

    // Stability first: a single reading of a set difference can catch the
    // browser mid-move.
    if (previous !== candidate.tabId) { previous = candidate.tabId; continue; }

    // Then capability, which is what actually settles it. Read-only: it asks the
    // page how long its title is and takes nothing out of it.
    const probe = await call('javascript_tool', {
      action: 'javascript_exec', tabId: candidate.tabId, text: 'String(document.title.length)',
    });
    if (probe.error || (probe.result && probe.result.isError)) {
      // Not fatal. A page can be mid-load, and a candidate that cannot be driven
      // yet is simply not adopted yet.
      notify({ kind: 'not-drivable', tab: candidate });
      previous = null;
      continue;
    }

    notify({ kind: 'adopted', tab: candidate, anchor, anchorCreated });
    return { outcome: 'adopted', tab: candidate, anchor, anchorCreated, polls };
  }

  return { outcome: 'timeout', anchor, anchorCreated, polls };
}

module.exports = { adoptTab, AdoptionError, contextOf, tabsIn, looksInternal, DEFAULT_POLL_MS };
