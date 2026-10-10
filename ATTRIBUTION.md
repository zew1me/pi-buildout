# Attribution

## Subagent implementations

The subagent extension in [`extensions/subagents`](extensions/subagents) was informed by the two implementations
identified by the project owner. The implementation in this repository is original code, but it deliberately carries
forward architectural ideas and operational lessons from both projects.

## `nicobailon/pi-subagents`

- Repository: <https://github.com/nicobailon/pi-subagents>
- Initial revision reviewed: `315e1eb1482c4ac2d912a8d95aac4287dc7e60ac`
- Latest revision reviewed: `1b64c35cc221a23a5b8293deb108a30c0646f520` (`0.48.0` plus unreleased changes)
- License declared by its package: MIT

Ideas and lessons used:

- Treat a subagent as a separate Pi process and session rather than an in-process prompt persona.
- Keep asynchronous child work observable through structured state and transcript tails.
- Expose explicit lifecycle controls for status inspection, steering, interruption, and stopping.
- Bound child protocol and diagnostic output so a malformed or noisy child cannot grow parent memory without limit.
- Make recursive delegation safe by scoping child registries and controls to a parent/child tree rather than a global
  fleet.
- Validate model choices against Pi's live model registry and preserve a clear fallback path.
- Clean up child processes and extension-owned resources during Pi session shutdown/reload.
- Keep the child JSONL protocol bounded while allowing Pi-sized resized-image events; this repository uses a 16 MiB
  per-line ceiling.
- Sanitize child-controlled transcript and diagnostic text before terminal rendering while retaining the original
  bounded text in the model-facing tool result.

We intentionally did **not** reproduce its agent profiles, chain/parallel workflow engine, intercom/supervisor channel,
watchdog, artifact protocol, slash-command suite, or TUI fleet. This extension stays between that feature-rich design
and a one-shot runner.

## `elpapi42/pi-minimal-subagent`

- Repository: <https://github.com/elpapi42/pi-minimal-subagent>
- Local revision reviewed: `4c847a37b7d675470a8c5eb50d736d11ceac910a`
- License declared by its package: MIT

Ideas and lessons used:

- Keep the model-facing surface centered on one small `subagent` tool.
- Let ordinary natural-language requests cause the parent model to delegate; do not require a special slash workflow.
- Launch child Pi with normal extension/resource discovery by default so configured tools and integrations remain
  available.
- Resolve the Pi executable robustly when Pi is running either as a standalone executable or through Node.
- Use process isolation and propagate shutdown/abort behavior instead of sharing an agent session object.
- Keep task dispatch simple and avoid requiring named role/persona files.

We extended that minimal shape with persistent RPC children, task-targeted context compaction, automatic model/effort
classification, direct-child spying and control, and recursive child creation.

## `tintinweb/pi-subagents`

- Repository: <https://github.com/tintinweb/pi-subagents>
- Initial revision reviewed: `c161865a0e8ca12f406041c263ea6c2ca35c74d5` (`0.14.1`)
- Latest revision reviewed: `4cc473855c2af4f12873c01dad130dd0b3d52639` (`0.15.1`)
- License: MIT

This package was reviewed after the initial implementation as a source of possible follow-up ideas. The review
considered its in-process SDK sessions, background concurrency queue, graceful turn limits, result/steering tools,
conversation viewer, context-usage statistics, compact tool-description mode, model-scope guardrail, and resumable
sessions.

Follow-up work adopted three conceptual patterns: explicit, bounded result waiting; richer inspection statistics
(tokens, cost, context utilization, compactions, and active tool); and treating an output-limit stop with no assistant
text as a failed child run rather than a successful empty result. They were implemented as original code inside the
existing single-tool RPC design. No tintinweb code was copied or modified. Major pieces intentionally not adopted
include named/default agent types, custom agent frontmatter, proactive completion notifications, FleetView/widget UI,
scheduling, event-bus RPC, persistent memory, worktree isolation, skill preloading, and its three-tool Claude
Code-compatible surface.

## Pi 0.85.1 `/skills` runtime patch

- Source: `@earendil-works/pi-coding-agent@0.85.1`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `d981de1229ef899957bbe968bc8dcda02a21f477` (`v0.85.1`)
- License declared by the package: MIT

[`patches/pi-0.85.1/skills.patch`](patches/pi-0.85.1/skills.patch) is a modified-code patch against Pi's published,
generated runtime and documentation. It modifies upstream `dist/bundle/cli.js`, `dist/bundle/rpc-entry.js`,
`dist/core/resource-loader.js`, `dist/core/slash-commands.js`, `dist/main.js`,
`dist/modes/interactive/interactive-mode.js`, and `docs/skills.md`; their unchanged context and modified lines derive
from the MIT-licensed Pi package. The bundled entrypoints become thin wrappers so the patched unbundled runtime handles
CLI and RPC execution. The added `dist/core/skill-management.js` is primarily an original implementation for this
repository, informed by Pi's resource-loading and command conventions.

The persisted-skill locking helpers are modified adaptations of the synchronous `proper-lockfile` retry and guaranteed
release pattern in Pi's MIT-licensed `dist/core/trust-manager.js`; the integration around the complete skill
read-modify-write transaction is original to this repository. The patch adopts explicit global, repository, and session
skill activation; a discoverable-but-inactive catalog; normalized repository identity; shared CLI and interactive
command semantics; diagnostics for invalid configuration; concurrent-update locking; and checksum-guarded installation.
Its catalog reuses Pi's package manager to include enabled package and settings skill sources while preserving Pi's
precedence and project-trust behavior. It intentionally does not adopt automatic loading of every discovered skill,
configured-path confinement, new public resource-loader mutator APIs, or changes to Pi's unrelated extension, prompt,
theme, package, trust, and provider behavior.

## Pi 0.99.2 `/skills` runtime patch

- Source: `@earendil-works/pi-coding-agent@0.99.2`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `005af57d88ee23b33778f343a9595b32e67ff788` (`v0.99.2`), from npm `gitHead`
- License declared by the package: MIT

[`pi-overlay/versions/0.99.2/integration.patch`](pi-overlay/versions/0.99.2/integration.patch) adapts the prior 0.85.1
integration seam to the MIT-licensed 0.99.2 TypeScript source and documentation. Its unchanged context and modified call
sites derive from Pi's `resource-loader.ts`, `slash-commands.ts`, `main.ts`, `interactive-mode.ts`, and
`docs/skills.md`. The generated [`skills.patch`](patches/pi-0.99.2/skills.patch) modifies their published JavaScript
counterparts and documentation; it adds the original `skill-management*.js` overlay modules. The patch reuses Pi's
package/resource discovery, project-trust and `proper-lockfile` APIs, adapting the trust-manager lock pattern described
below. It makes catalog skills opt-in with global, repository, and session activation, preserving explicit CLI skill
paths and avoiding Pi's automatic loading of all discovered skills. It does not adopt or change Pi's unrelated
extension, prompt, theme, package, provider, trust, or bundled-chunk behavior.

The hand-written `cli-runtime.js` and `rpc-entry.js` replacements in the 0.99.2 overlay are original wrappers reused
from the earlier patch; they delegate to the patched unbundled runtime. Pi's published `dist/bundle/cli.js` loader is
unchanged and pinned by checksum. The entrypoint test uses a byte-identical five-line stand-in based on that
MIT-licensed loader. Inputs are fetched from the 0.99.2 release archive (verified against its published `SHA256SUMS`)
and npm tarball; no complete Pi source checkout is committed.

## Pi 1.0.3 `/skills` runtime patch

- Source: `@earendil-works/pi-coding-agent@1.0.3`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `d78dc83d633229d12f8b79631384c4c2717c399f` (`v1.0.3`), from npm `gitHead`
- Source archive: `pi-1.0.3-source.tar.gz`, verified against the release's published `SHA256SUMS`
- License declared by the package: MIT

[`pi-overlay/versions/1.0.3/integration.patch`](pi-overlay/versions/1.0.3/integration.patch) adapts the existing opt-in
skills seam to the MIT-licensed 1.0.3 TypeScript sources and documentation. The generated
[`skills.patch`](patches/pi-1.0.3/skills.patch) modifies the published resource loader, slash-command list, CLI and
interactive entry points, and `docs/skills.md`; it adds this repository's original skill-management modules. The patch
reuses Pi's package/resource discovery, project-trust, and `proper-lockfile` APIs, including an adapted lock pattern
previously attributed above. It keeps discovered skills catalog-only, enables explicit global, repository, and session
activation, preserves explicit `--skill` paths when `--no-skills` is used, and leaves Pi's unrelated extensions,
prompts, themes, packages, providers, trust behavior, and bundled chunks unchanged. It does not copy Pi's automatic
skill-loading behavior or its runtime implementation into the overlay.

The `cli-runtime.js` and `rpc-entry.js` replacements are original wrappers reused from the earlier generated patch; Pi's
published `dist/bundle/cli.js` compile-cache loader remains unchanged and is pinned by checksum. Source inputs are
fetched from the 1.0.3 release archive and npm tarball with committed checksums; no complete Pi source checkout is
committed.

## Pi 1.0.4 `/skills` runtime patch

- Source: `@earendil-works/pi-coding-agent@1.0.4`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `7c10bd4337495ee613f2224843ecdf349b80d1df` (`v1.0.4`), from npm `gitHead`
- Source archive: `pi-1.0.4-source.tar.gz`, verified against the release's published `SHA256SUMS`
- License declared by the package: MIT

[`pi-overlay/versions/1.0.4/integration.patch`](pi-overlay/versions/1.0.4/integration.patch) adapts the opt-in skills
integration seam to the MIT-licensed 1.0.4 TypeScript sources and documentation. The generated
[`skills.patch`](patches/pi-1.0.4/skills.patch) modifies Pi's published resource loader, slash-command list, CLI and
interactive entry points, and skill documentation. It adds this repository's original skill-management modules and
reuses Pi's package/resource discovery, project-trust, and `proper-lockfile` APIs. It preserves explicit `--skill` with
`--no-skills`, makes discovered skills catalog-only until activated, and leaves unrelated extensions, prompts, themes,
packages, providers, trust behavior, and bundled chunks unchanged. Pi's automatic loading of all discovered skills and
its skill implementation were not copied into the overlay. The original `cli-runtime.js` and `rpc-entry.js` wrappers are
reused from the earlier patch; the published `dist/bundle/cli.js` loader is unchanged and checksum-pinned. Inputs come
from the verified release archive and npm tarball; no complete Pi source checkout is committed.

## Pi 1.1.0 `/skills` runtime patch

- Source: `@earendil-works/pi-coding-agent@1.1.0`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `abe508e1b89912adde45528136c3221eb69acdd7` (`v1.1.0`)
- Source archive: `pi-1.1.0-source.tar.gz`, verified against the release's published `SHA256SUMS`
- License declared by the package: MIT

[`pi-overlay/versions/1.1.0/integration.patch`](pi-overlay/versions/1.1.0/integration.patch) adapts the opt-in skills
seam to Pi 1.1.0's MIT-licensed TypeScript sources and documentation. The generated
[`skills.patch`](patches/pi-1.1.0/skills.patch) modifies the published resource loader, slash-command list, CLI and
interactive entry points, and skill documentation. It adds this repository's original skill-management modules and
reuses Pi's package/resource discovery, project-trust, and `proper-lockfile` APIs. It keeps catalog skills inactive
until explicitly enabled, preserves explicit `--skill` paths with `--no-skills`, and does not copy Pi's automatic skill
loading or its skill implementation. The original `cli-runtime.js` wrapper reuses Pi's `setupCli()` path; the original
`rpc-entry.js` wrapper also preserves Pi 1.1.0's process markers and HTTP-dispatcher setup. The published
`dist/bundle/cli.js` loader remains unchanged and checksum-pinned. No complete Pi source checkout is committed.

## Pi `/skills` TypeScript overlay

- Source: `@earendil-works/pi-coding-agent@0.85.1`, `@earendil-works/pi-coding-agent@0.99.2`,
  `@earendil-works/pi-coding-agent@1.0.3`, `@earendil-works/pi-coding-agent@1.0.4`, and
  `@earendil-works/pi-coding-agent@1.1.0`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revisions reviewed: `d981de1229ef899957bbe968bc8dcda02a21f477` (`v0.85.1`),
  `005af57d88ee23b33778f343a9595b32e67ff788` (`v0.99.2`), `d78dc83d633229d12f8b79631384c4c2717c399f` (`v1.0.3`),
  `7c10bd4337495ee613f2224843ecdf349b80d1df` (`v1.0.4`), and `abe508e1b89912adde45528136c3221eb69acdd7` (`v1.1.0`),
  taken from the npm registry's `gitHead` for each release
- Source acquired from the 0.85.1, 0.99.2, 1.0.3, 1.0.4, and 1.1.0 release archives and verified against each release's
  published `SHA256SUMS`
- License declared by the package: MIT

[`pi-overlay`](pi-overlay) is the authored form of the `/skills` runtime patch; the artifacts under
`patches/pi-0.85.1/`, `patches/pi-0.99.2/`, `patches/pi-1.0.3/`, `patches/pi-1.0.4/`, and `patches/pi-1.1.0/` are
generated from it.

`pi-overlay/skill-management-core.ts` and `pi-overlay/skill-management.ts` are original code for this repository. They
are a TypeScript reimplementation of the `dist/core/skill-management.js` previously authored here as JavaScript,
informed by Pi's resource-loading and command conventions rather than copied from an upstream file. They additionally
absorb logic that earlier versions of the patch inlined into upstream files, so those files now receive only imports and
call sites.

The persisted-skill lock in `pi-overlay/skill-management-core.ts` (`acquireSkillConfigLock` and `withSkillConfigLock`)
is a modified adaptation of the `acquireTrustLockSync` and `withTrustFileLock` pattern in Pi's MIT-licensed
`src/core/trust-manager.ts`: a synchronous `proper-lockfile` lock on a sibling `.lock` path, retried only on `ELOCKED`,
and released in `finally`. It differs by waiting with `Atomics.wait` instead of busy-spinning, allowing more attempts,
and reporting rather than throwing a failed release so the update's own result or error is preserved. The shell binds
Pi's existing `proper-lockfile` dependency; no new upstream dependency is introduced.

`pi-overlay/versions/0.85.1/integration.patch` is a modified-code patch against Pi's MIT-licensed TypeScript sources:
`src/core/resource-loader.ts`, `src/core/slash-commands.ts`, `src/main.ts`, `src/modes/interactive/interactive-mode.ts`,
and `docs/skills.md`. Its unchanged context and modified lines derive from the MIT-licensed Pi package.

`pi-overlay/versions/0.85.1/replacements/dist/bundle/cli.js` and `rpc-entry.js` are original hand-written wrappers, not
derived from upstream's generated bundle output. They replace Pi's esbuild-produced bundled entrypoints so the patched
unbundled runtime handles CLI and RPC execution.

This repository vendors no upstream source and maintains no fork. Upstream source is fetched per generation run against
pinned, checksum-verified inputs, and is not committed here.

## Pi documentation and examples

- Source: `@earendil-works/pi-coding-agent`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Releases reviewed: `0.80.6`, `0.82.0`, `0.82.1`, `0.83.0`, `0.84.0`, `0.84.1`, `0.84.2`, `0.84.4`, `0.85.1`, `0.99.2`,
  and `1.0.3`
- Latest documentation and example revision reviewed: `d78dc83d633229d12f8b79631384c4c2717c399f`
- License declared by the package: MIT

Ideas and API patterns used:

- Extension tool registration, lifecycle shutdown hooks, resource discovery, and TUI tool rendering.
- The Pi 0.85.1 versioned skills catalog reuses `DefaultPackageManager.resolve()` and its resolved-resource metadata to
  discover package and settings skills with upstream manifest, filtering, scope, and precedence behavior. The catalog
  merge and opt-in activation logic remain original code; Pi's automatic skill loading is intentionally not adopted.
- The Pi 0.85.1 patch adapts the synchronous `proper-lockfile` acquisition/retry and `finally` release pattern from Pi's
  trust manager so skill configuration updates serialize across processes.
- SDK `AgentSession.compact()` with custom instructions and in-memory sessions.
- RPC JSONL framing and the `prompt`, `steer`, `follow_up`, `abort`, state, and event protocols.
- Model-registry authentication, fuzzy CLI-equivalent model resolution, thinking-level capability maps, and normal child
  resource inheritance.
- Pi's thinking-level clamp policy (prefer the nearest supported level above the request, fall back downward only when
  necessary) is a conceptual adaptation, reimplemented in `extensions/subagents/helpers.ts`; no Pi code was copied.
  `supportedThinkingLevels` additionally narrows OpenAI's direct GPT-5.6 levels beyond what Pi's generated model
  metadata declares, because the live endpoint rejects `minimal` and `max`. Pi's own permissive handling of those two
  levels is intentionally not adopted.
- Pi's bundled subagent and custom-compaction examples as reference implementations for process invocation, output
  bounds, and compaction setup.

Major pieces intentionally not adopted include Pi's full interactive mode, session-replacement runtime, prompt-template
workflows, custom provider implementations, and bundled role-based subagent profiles. No Pi source file or example was
copied verbatim; the extension is original code using Pi's published APIs and adapting the documented architectural
patterns.
