# Roadmap

Where this project is going, release by release: from a one-shot shell bridge to a browser-automation CLI written in Node, still driving your real, logged-in Chrome.

Each release is small and shippable on its own. The non-goals are part of the plan: they are what keeps a one-maintainer project moving.

## Invariants

Three rules hold across every release below.

1. **`cic call` never owns a schema.** Pure pass-through is why the CLI cannot break when the extension changes its tools. Friendly commands introduced from 0.7.0 onward may own narrow mappings for the behavior they add; `cic call` remains the schema-agnostic escape hatch forever.
2. **The exit-code contract is defined at 0.4.0 and frozen from then on:** 0 success, 1 tool error (a JSON-RPC error or `isError: true`), 2 outcome unknown (the `tools/call` request was written and no usable reply came back, whether by timeout, the child exiting, a malformed reply or an I/O failure), 3 failure strictly before the `tools/call` request was written (`claude` missing or failing to spawn, the initialize handshake failing, an unsupported protocol version), 64 usage error or invalid arguments JSON. The boundary between 2 and 3 is whether the request went out: exit 3 means the browser cannot have acted, so it is the only class safe to retry. With `--json`, every failure emits one line on stdout in the frozen shape `{"error": true, "kind": "tool_error" | "unknown_outcome" | "transport" | "usage", "exit": 1 | 2 | 3 | 64, "message": "<human readable>"}`, so a machine caller never has to parse an empty stream. The retired `cic.sh` violated this contract by exiting 0 on tool errors; the Node CLI fixed it rather than preserving that behavior.
3. **`plugin.json` is the single source of truth for the version.** CI asserts every other version constant matches it.

One boundary is deliberately outside the release sequence: this project will not grow a second Chrome DevTools Protocol implementation for arbitrary daily-Chrome tabs. `list_open_tabs` stays passive, `reopen-tab` will create a new managed tab from a recovered URL, and true adoption of an existing tab belongs upstream in the Claude-in-Chrome extension or bridge. Users who need full-browser CDP access should use Chrome DevTools MCP.

## v0.2.3: docs tell the truth (shipped 2026-08-17)

Docs corrections only (#3). The README, the skill and the code comments now describe how the browser tools actually behave: the tab group is the only boundary, windows are irrelevant, and `chrome-devtools` is not sessionless.

## v0.3.0: see every tab, in Node (shipped 2026-08-18)

Theme: the tab-visibility gap closes, shipping once, in the target runtime.

- The `chrome-tabs` MCP server from #4, with its SNSS session-file parser ported from Python to a standalone zero-dependency Node script, registered in `.mcp.json` as `node ${CLAUDE_PLUGIN_ROOT}/...`. Read-only, one tool: `list_open_tabs`. The Python file never ships registered; it serves as the reference implementation during the port and is dropped once the Node output matches it on generated SNSS fixtures. The final suite uses generated parser fixtures and injected path-discovery tests for macOS, Windows and Linux; real-profile validation is limited to read-only aggregate checks on macOS. Node 22 or later is the baseline from this first Node component onward, and CI runs it on Node 22.
- The MCP handshake test is ported and expanded along with it, including the unknown-tool error path.
- Infrastructure starts here: GitHub Actions running the tests on every push, a CHANGELOG backfilled to 0.2.0 (the first tagged release; there is no 0.1.0 to backfill to), and a CI check that the server's version constant equals `plugin.json`.
- README documents the `node` requirement for this one server. If `node` is absent, only `chrome-tabs` degrades; the main bridge is untouched.
- The privacy boundary is wider than the bridge's and the release says so. The parser scans every recognized profile (`Default` and `Profile *`, Chrome and Chromium alike), reports encrypted or unreadable profiles it cannot list, and a raw URL can carry tokens, credentials or sensitive query parameters that the bridge's own redaction would have caught. Default output is therefore titles plus origin and path only: credentials, query strings and fragments are stripped. Full URLs require an explicit opt-in argument, and the all-profile scope is documented in the tool description itself, where the calling agent sees it.

Non-goals: no `cic.sh` changes, no write operations on tabs.

Risk: SNSS is an undocumented Chromium internal and can shift across Chrome versions. Mitigated by fail-closed parsing, generated fixtures and read-only validation against real macOS profiles. Windows and Linux discovery are covered by injected unit tests, not real installations. Also to verify rather than assume: that `node` is on PATH for plugin users, since Claude Code's native builds may not guarantee it.

## v0.3.1: ship the plugin, not the repository (shipped 2026-08-18)

Theme: the installed plugin cache contains runtime files, not the project's tests and development history.

- Move the plugin root into `plugins/claude-in-chrome/` and change its marketplace source from `"./"` to `"./plugins/claude-in-chrome"`. The repository remains the Git-backed marketplace; no GitHub Actions publishing job, generated archive or release asset sits in the installation path.
- The plugin subtree contains only what runs or is legally required: `.claude-plugin/plugin.json`, `.mcp.json`, `skills/`, `tabs_mcp.js`, the plugin copy of `cic.sh`, and `LICENSE`. Tests, fixtures, screenshots, repository docs, the roadmap and GitHub workflow files stay outside it and are therefore not copied into Claude Code's versioned plugin cache.
- Preserve the existing root `cic.sh` download URL for standalone users. Until v0.4.0 deletes the shell implementation, CI asserts that the root script and the plugin's bundled copy are byte-for-byte identical so the temporary duplication cannot drift.
- Add an install-level test from a clean checkout: validate the marketplace, install `claude-in-chrome`, assert the cached plugin contains only the allowlisted runtime surface, start `chrome-tabs` through its `${CLAUDE_PLUGIN_ROOT}` path, and verify that the extension bridge still registers as `claude --claude-in-chrome-mcp`.
- Bump `plugin.json` and the server version to 0.3.1 together. The explicit version is Claude Code's cache key, so the package-boundary change must be a real versioned update; the published v0.3.0 tag and release remain untouched.

Non-goals: no parser behavior change, no new MCP tool, and no change to `cic.sh` semantics. This is packaging hygiene only.

Unanticipated consequence, recorded because moving a plugin's path is not a private change: ClaudePluginHub derives a listing's identity from owner, plugin name and path within the repository, so relocating the plugin duplicated the directory entry rather than moving it. The root-path listing froze at 0.2.2 describing `cic.sh`, and its badge kept answering HTTP 200 while rendering "not found". Consolidating on the new path cost the short slug, the listing's traffic history and four days of stars. Check how a directory keys your listing before changing `source`.

## v0.4.0: cic in Node, cic.sh retired (shipped 2026-08-18)

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

## v0.4.1: measure, harden, automate (shipped 2026-08-18)

Theme: know what the tests actually cover, close the validation gaps 0.4.0 shipped with, and stop publishing by hand.

The order matters and is deliberate. Coverage comes first so the hardening has a number to move rather than a claim. Correctness comes before publishing automation, so the first automated publish ships something already believed correct.

- **Coverage, measured before anything is changed.** `c8` writes `coverage/lcov.info` from the offline suites, which follow both programs into their child processes through `NODE_V8_COVERAGE`. Codecov receives it over GitHub OIDC with `id-token: write`, so there is no long-lived token in the repository, and it uploads from a job of its own: minting an OIDC token that asserts this repository's identity does not belong beside steps that install and run third-party code. No threshold was invented. The measured baseline was 94.95% of lines and 82.55% of branches, Codecov's own gate is `target: auto` against the base commit, and the `c8` floors sit under the baseline as a coarse backstop rather than an aspiration. The README badge went in only after an upload had actually landed and processed, since a badge is a claim about a pipeline that works.
- **The validation gaps 0.4.0 listed as known.** The initialize response gets the same result-or-error validator as a tool reply, and a malformed one exits 3 without dispatching, because nothing has reached the browser yet. Error `code` is checked as an integer rather than any number, `isError` as a boolean, and the members of `content` and `tools` for the shape they claim. Plain and `--json` output must classify the same reply identically: a difference between them is a bug in the contract, not a formatting choice. Hostile-server cases cover each one.
- **Publishing, automated but not unattended.** `publish-npm.yml` fires on a `v*` tag, verifies the tag matches `package.json` exactly, runs the suites and `npm pack --dry-run`, then publishes through npm trusted publishing: GitHub OIDC, no `NPM_TOKEN`, provenance attached automatically. It runs in an `npm` GitHub Environment with manual approval, so a tag alone cannot ship. Needs Node 22.14 or later and npm 11.5.1 or later.
- Release as 0.4.1 in that order: push the tag, let npm publishing finish, and only then publish the GitHub release, so the install command in the release notes works the moment anyone reads it.

Non-goals: no new tools, no friendly verbs, no persistence. Nothing here changes what `cic` does when the bridge behaves.

**npm trusted publishing cannot perform a package's first publish**, which is why 0.4.0 went out by hand. A trusted publisher cannot be configured for a package that does not exist, and there is no token in this repository. That is done: `claude-in-chrome-cli@0.4.0` is on the registry, published manually without provenance, and the trusted publisher is configured against `publish-npm.yml` and the `npm` environment with only the `npm publish` permission. The workflow owns every publish from 0.4.1 onward, and those carry provenance.

Worth recording for the next manual publish, if there ever is one: `npm publish` in a non-interactive shell fails with `EOTP` and prints a masked auth URL, then exits without polling, so the browser flow is unreachable. Running it under a pseudo-TTY (`script -q /dev/null npm publish`) makes npm emit a real, pollable URL instead.

Risk: Codecov's OIDC support has a reported failure mode where the CLI ignores the credential, falls back to tokenless and then fails a rate limit. The upload step is therefore allowed to fail loudly rather than carrying `continue-on-error`, and it is skipped on fork pull requests, which are issued no `id-token` at all.

## v0.5.0: a portable session core (shipped 2026-08-18)

Theme: one protocol implementation, proven on every supported platform.

- Extract the MCP lifecycle from the command-line path into one internal `BridgeSession`: start the `claude --claude-in-chrome-mcp` child, negotiate and validate initialization, allocate request ids, parse replies, preserve the dispatched/not-dispatched boundary, forward stderr safely, enforce timeouts, and close and reap the child.
- Refactor the existing one-shot commands onto that core: `cic call` becomes create session, make one call, close. Its stdout, stderr, exit codes and frozen `--json` shape do not change.
- Calls are serialized. Reply demultiplexing may exist inside the core, but concurrent browser actions do not become public behavior until there is evidence that their ordering can be explained safely.
- Expand CI to Ubuntu, macOS and Windows on Node 22 and 24. The offline hostile-server corpus runs everywhere, and Windows support is claimed only once those process-lifecycle tests pass there. Windows and Linux browser-profile discovery remain fixture-backed until they are also checked on real installations.
- `--retries N` with backoff remains limited to exit 3, where the request was never dispatched. Exit 2 is never retried automatically.

Non-goals: no long-lived public mode, no workflow syntax, no daemon, and no friendly tool aliases. This release changes the implementation boundary and makes the platform claim real without changing the one-shot contract.

## v0.6.0: foreground sessions

Theme: many calls over one live MCP connection, without a background process.

- `cic session --jsonl` holds one `BridgeSession` open. Each input line carries a caller-chosen id, tool name, arguments and optional timeout; each output line carries the same id and a per-request outcome. The caller owns sequencing and dynamic values such as a returned `tabId`; `cic` owns the connection.
- A persistent process cannot report every call through its own exit status. Each response envelope therefore carries the one-shot classification (`exit`, `kind`, result or message), while the process exit code describes only startup, clean shutdown or a fatal session failure.
- Calls are processed serially. An exit-2 unknown outcome is fatal to the session by default: emit its record, close and reap the bridge, and require a fresh session so a later action cannot silently race an earlier action whose outcome is unknown.
- `cic shell` is a small human REPL over the same streaming interface. It initially has no variables, captures, aliases, implicit current tab or control flow.
- The JSONL protocol and its backpressure, malformed-input and shutdown behavior are driven by offline tests on all three operating systems.

Non-goal: no `batch` workflow language. Captures, references, dependencies, interpolation, conditions and loops belong to the calling program unless real usage later justifies a separate design.

## v0.7.0: tab lifecycle and useful output

Theme: solve lifecycle and transport gaps before adding spelling shortcuts.

- Add a library-level `withTab` helper on `BridgeSession`: create, navigate, hand the `tabId` to a callback, and close on success or ordinary tool error. Unknown outcomes get an explicit fail-closed cleanup policy, and `keepTab: true` preserves the tab for debugging. Its behavior is tested before a CLI spelling is frozen.
- Add screenshot-to-file output, including binary validation, atomic writes and refusal to corrupt a destination after a malformed or partial result.
- Add `cic tabs` as a direct facade over the local session parser; it does not spawn the MCP bridge for a read that only needs the filesystem.
- Expose a narrow tab-lifecycle CLI only after the helper contract is proven. The roadmap deliberately does not invent nested command syntax or a mini workflow language in advance.

Deferred, not rejected: `navigate`, `text`, `find` and `js`. They improve discoverability and avoid nested JSON quoting, especially in PowerShell, but they do not precede connection, lifecycle and file-output capabilities.

## v0.8.0: reopen a discovered tab safely

Theme: connect passive discovery to a managed, actionable tab without claiming to adopt the original renderer.

- `reopen-tab` searches the local parser by redacted URL metadata and title, resolves a unique candidate (or reports ambiguity), creates a Claude-managed tab, navigates it to the recovered URL and returns the new actionable `tabId`.
- The raw URL remains inside the process: it is read by importing the parser, passed directly to the MCP child over stdin, and never placed in process arguments, stdout candidates, logs, errors or shell history. Initial support is limited to ordinary HTTP(S) URLs.
- The name is intentional. Reopening does not preserve DOM state, form values, scroll position, JavaScript state, navigation history or active connections.
- Open an upstream request for a true `adopt_tab` or `add_tab_to_group` bridge operation. Do not simulate adoption with CDP inside this project.

## v0.9.0: optional daemon

Theme: persistence across separate CLI processes, built around the already-proven session core.

- A daemon holds one `BridgeSession` and exposes it over a Unix socket or Windows named pipe. It adds request routing, idle-timeout shutdown and explicit start/stop/status commands; it does not reimplement MCP negotiation, validation or child cleanup.
- One-shot remains the default and daemon use is opt-in, so IPC failure never breaks the basic path. The foreground JSONL mode remains available for callers that want persistence without background state.
- Whoever reaches the IPC endpoint drives a logged-in browser. The socket therefore lives in a user-owned 0700 directory; the Windows pipe uses a DACL restricted to the current user. Client and daemon exchange a version handshake, and auto-spawn takes an atomic lock so upgrades and racing callers cannot attach to the wrong process.
- Offline tests cover stale endpoints, concurrent startup, version mismatch, crash recovery, idle shutdown and child reaping on all three operating systems.

This is still the hardest release in the roadmap, but by this point connection lifecycle and request semantics are reused rather than debugged through two layers at once.

## v0.10.0: tabs with names, and observed conveniences

Theme: first persistent user state, after session behavior has survived real use.

- `cic tab name <name> <tabId>` records an explicit mapping. Friendly lifecycle commands may accept `--tab <name>`; `cic call` does not, because injecting a `tabId` into caller-owned arguments would violate the first invariant. Raw calls compose through `cic tab resolve <name>`, which prints the id.
- One atomic on-disk store is shared by foreground, daemon and one-shot modes, so process shutdown loses nothing.
- A mapping is validated against the live managed-tab list on every read. A dead id produces a specific error and is pruned, never silently reused after Chrome restarts.
- Add only the deferred convenience verbs that real foreground-session and Windows usage has justified. Their names and positionals remain pre-1.0 and may still change.

## v0.11.x: stabilization

A bug-fix-only runway, as many patches as it takes. Soak foreground sessions and the daemon, fix Windows papercuts, freeze the JSONL and command contracts, and finish the release checklist. Explicit non-goal: any new feature.

## v1.0.0: the contract release

1.0 means, concretely:

1. Frozen contracts: the exit-code map and `--json` shape (unchanged since 0.4.0), the foreground-session JSONL envelope, and every shipped command name and positional. Changing any of them after 1.0 requires a major bump.
2. Three-OS CI green, including offline daemon lifecycle tests.
3. The persistent session survives a week of the maintainer's real daily use without a hang or an orphaned process.
4. One repo, one version number, shipping as both an npm package and a Claude Code plugin, with a release checklist in CONTRIBUTING.
5. Zero known bugs that lose a reply, hang a pipeline, or misreport an exit code.
