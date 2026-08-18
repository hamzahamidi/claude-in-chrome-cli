# Roadmap

Where this project is going, release by release: from a one-shot shell bridge to a browser-automation CLI written in Node, still driving your real, logged-in Chrome.

Each release is small and shippable on its own. The non-goals are part of the plan: they are what keeps a one-maintainer project moving.

## Invariants

Three rules hold across every release below.

1. **`cic call` never owns a schema.** Pure pass-through is why the CLI cannot break when the extension changes its tools. Friendly verbs (0.5.0) each own one positional argument mapping at most; `cic call` remains the schema-agnostic escape hatch forever.
2. **The exit-code contract is defined at 0.4.0 and frozen from then on:** 0 success, 1 tool error (a JSON-RPC error or `isError: true`), 2 outcome unknown (the `tools/call` request was written and no usable reply came back, whether by timeout, the child exiting, a malformed reply or an I/O failure), 3 failure strictly before the `tools/call` request was written (`claude` missing or failing to spawn, the initialize handshake failing, an unsupported protocol version), 64 usage error or invalid arguments JSON. The boundary between 2 and 3 is whether the request went out: exit 3 means the browser cannot have acted, so it is the only class safe to retry. With `--json`, every failure emits one line on stdout in the frozen shape `{"error": true, "kind": "tool_error" | "unknown_outcome" | "transport" | "usage", "exit": 1 | 2 | 3 | 64, "message": "<human readable>"}`, so a machine caller never has to parse an empty stream. Known defect until then: `cic.sh` exits 0 on tool errors, so a pipeline proceeds after a failure. That is fixed by the Node CLI, not patched in shell.
3. **`plugin.json` is the single source of truth for the version.** CI asserts every other version constant matches it.

## v0.2.3: docs tell the truth (shipped 2026-08-17)

Docs corrections only (#3). The README, the skill and the code comments now describe how the browser tools actually behave: the tab group is the only boundary, windows are irrelevant, and `chrome-devtools` is not sessionless.

## v0.3.0: see every tab, in Node (reworks #4)

Theme: the tab-visibility gap closes, shipping once, in the target runtime.

- The `chrome-tabs` MCP server from #4, with its SNSS session-file parser ported from Python to a standalone zero-dependency Node script, registered in `.mcp.json` as `node ${CLAUDE_PLUGIN_ROOT}/...`. Read-only, one tool: `list_open_tabs`. The Python file never ships registered; it serves as the reference implementation during the port and is dropped once the Node output matches it on generated SNSS fixtures. The final suite uses generated parser fixtures and injected path-discovery tests for macOS, Windows and Linux; real-profile validation is limited to read-only aggregate checks on macOS. Node 22 or later is the baseline from this first Node component onward, and CI runs it on Node 22.
- The MCP handshake test is ported and expanded along with it, including the unknown-tool error path.
- Infrastructure starts here: GitHub Actions running the tests on every push, a CHANGELOG backfilled to 0.2.0 (the first tagged release; there is no 0.1.0 to backfill to), and a CI check that the server's version constant equals `plugin.json`.
- README documents the `node` requirement for this one server. If `node` is absent, only `chrome-tabs` degrades; the main bridge is untouched.
- The privacy boundary is wider than the bridge's and the release says so. The parser scans every recognized profile (`Default` and `Profile *`, Chrome and Chromium alike), reports encrypted or unreadable profiles it cannot list, and a raw URL can carry tokens, credentials or sensitive query parameters that the bridge's own redaction would have caught. Default output is therefore titles plus origin and path only: credentials, query strings and fragments are stripped. Full URLs require an explicit opt-in argument, and the all-profile scope is documented in the tool description itself, where the calling agent sees it.

Non-goals: no `cic.sh` changes, no write operations on tabs.

Risk: SNSS is an undocumented Chromium internal and can shift across Chrome versions. Mitigated by fail-closed parsing, generated fixtures and read-only validation against real macOS profiles. Windows and Linux discovery are covered by injected unit tests, not real installations. Also to verify rather than assume: that `node` is on PATH for plugin users, since Claude Code's native builds may not guarantee it.

## v0.4.0: cic in Node, cic.sh retired

Theme: one implementation, and it stops lying to pipelines.

- An npm package (bin: `cic`), Node 22 or later (18 and 20 are already past end of life), zero runtime dependencies. Commands: `cic list` and `cic call <tool> [json-args]`, pure pass-through preserved.
- `cic.sh` is deleted in this same release. No coexistence period, no wrapper. The curl install path becomes `npm install -g`; a migration section maps every documented `cic.sh` invocation to its `cic` equivalent. The old script stays fetchable from the v0.2.x tags.
- The plugin keeps its own shell entry point: the Node CLI ships bundled inside the plugin and the skill invokes it as `node ${CLAUDE_PLUGIN_ROOT}/...`, with the global npm install as the standalone path. Both installation paths are tested; deleting `cic.sh` must not silently leave the plugin without one.
- The MCP lifecycle is fixed, not ported. `cic.sh` writes `initialize`, the `initialized` notification and the tool request in one burst without waiting for the initialize response; the spec says requests wait until initialization completes. The Node client negotiates in order, and the tests drive it against a scripted stub server that enforces ordering: acceptance cases for ordered negotiation, protocol-version rejection, timeout termination and child-process reaping, not just canned reply lines.
- Everything the shell version got wrong, fixed once, here:
  - The exit-code contract, implemented and frozen.
  - stderr passthrough: a missing binary, a disconnected extension and an auth failure stop collapsing into one "no reply" message.
  - Arguments JSON validated client-side before send; garbage gets exit 64 instead of a silent drop (the 0.2.1 bug class).
  - Adaptive wait: read the child's stdout line by line and return the moment the reply lands. `--timeout <secs>` becomes a ceiling, not a floor. The 35 to 40 second worst-case advice drops to actual reply latency. This is structurally impossible in `cic.sh`, where a writer-side `sleep` holds the pipe open for the full wait on every call.
  - `--json`: the raw result object on one line. The machine-readable contract, defined once, in the implementation that keeps it.
- An offline test corpus: a scripted stub server plus canned JSON-RPC replies, asserting output, ordering and exit codes, no Chrome needed.

Non-goals: no friendly verbs, no retries, no persistence. This is the biggest release for a solo maintainer; parity, correctness, adaptive wait and `--json` only.

Risk: deleting `cic.sh` breaks anyone who curled it. Accepted, versioned, and documented in the migration section.

## v0.5.0: Windows, and friendly verbs

Theme: the platform claim becomes real, and the common path stops requiring hand-written JSON.

- CI matrix: ubuntu, macos, windows, on Node 22 and 24. All tests are offline, so CI cannot flake on Chrome. Windows support formally claimed in the README, with the Windows and Linux profile paths verified against fixtures.
- Friendly verbs for roughly six tools: `cic navigate <url>`, `cic text [tabId]`, `cic screenshot [-o out.png]` (finally an exit route for image content, which `cic.sh` discarded as `[image]`), `cic find "<query>"`, `cic js "<code>"`, and `cic tabs` (reads the session-file parser directly; a local file read needs no MCP round trip).
- This is where the CLI starts owning schemas, and the line is drawn explicitly: each verb maps its positionals to the single most-stable argument key, does no client-side schema validation, passes extras through `--arg key=value`, and surfaces server errors verbatim. The cost is accepted and documented: an extension-side rename breaks a verb until patched. `cic call` never breaks.
- `--retries N` with backoff, only on the exit-3 class, where the request never went out. Nothing after dispatch is retried automatically, whether it failed by timeout, child exit or malformed reply: the action may already have run in the browser, and retrying a click, a submit or a `javascript_tool` call repeats it. Exit 2 keeps meaning "outcome unknown" and the caller decides.

Verbs ship two releases before 1.0 deliberately, so names can still change on real usage feedback.

## v0.6.0: stay connected

Theme: one live MCP connection.

- `cic serve`, a daemon (or auto-spawned on `--session`) holding one `claude --claude-in-chrome-mcp` child: unix socket (named pipe on Windows), request-id allocation, reply demultiplexing, idle-timeout shutdown, `cic session stop`.
- One-shot stays the default and `--session` is opt-in, so a daemon bug never breaks the default path. Per-call cost drops from process spawn plus handshake to a socket round trip, and the tab group survives between calls, which removes the empty-tab-group-per-invocation defect entirely.
- The transport carries a security and compatibility contract, because whoever reaches the socket drives a logged-in browser: the socket lives in a directory owned by the current user with 0700 permissions (a DACL restricted to the current user for the Windows named pipe), the CLI and daemon exchange a version handshake on connect so a stale daemon left over from before an npm upgrade is detected and replaced rather than trusted, and auto-spawn takes an atomic lock so two racing invocations cannot start two daemons.

This release ships nothing else. It is the hardest engineering in the roadmap: lifecycle, stale sockets, crash recovery, and two IPC implementations.

## v0.7.0: tabs with names

Theme: first persistent state.

- `cic tab name <name> <tabId>` records a mapping (the id is explicit; there is no "current tab" to infer), and `--tab <name>` is accepted by the friendly verbs. It is deliberately not accepted by `cic call`: injecting a tabId into caller-supplied arguments would mean owning the schema, which the first invariant forbids. Raw calls compose instead through `cic tab resolve <name>`, which prints the id.
- One store for both modes: a single atomic on-disk file (`~/.cache/cic/state.json`). The daemon reads and writes the same file rather than holding names in memory, so an idle-timeout shutdown loses nothing.
- The staleness rule: a name-to-id mapping is validated against the live tab list on every read, because tab ids die with a Chrome restart. A dead mapping produces a specific error and is pruned, never silently reused.

## v0.8.x: stabilization

A bug-fix-only runway, as many patches as it takes. Soak the daemon, fix Windows papercuts, freeze the docs. Explicit non-goal: any new feature.

## v1.0.0: the contract release

1.0 means, concretely:

1. Frozen contracts: the exit-code map and `--json` shape (unchanged since 0.4.0) and the verb names and positionals (unchanged since 0.5.0). Changing any of them after 1.0 requires a major bump.
2. Three-OS CI green, including offline daemon lifecycle tests.
3. The persistent session survives a week of the maintainer's real daily use without a hang or an orphaned process.
4. One repo, one version number, shipping as both an npm package and a Claude Code plugin, with a release checklist in CONTRIBUTING.
5. Zero known bugs that lose a reply, hang a pipeline, or misreport an exit code.
