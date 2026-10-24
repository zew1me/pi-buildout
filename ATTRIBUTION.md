# Attribution

## Public npm packaging and release automation

- Source: `nigel-upstart/pi-buildout`
- Canonical URL: <https://github.com/nigel-upstart/pi-buildout>
- Revision reviewed: `5ed4c390ee13fd8c491d964008cf37b459b621d9`
- Declared license: MIT (Nigel Stuke, 2026); the root `LICENSE` preserves that notice.

The separate per-extension package directories, explicit Pi entrypoints, host-provided peer dependencies, minimal
`prepack` staging, inclusion of license/attribution files, and separate patch-only CLI were informed by the fork's
`packages/`, `scripts/stage-release-package.mjs`, and package tests. The staging helper structure and portions of the
archive assertions are modified adaptations of that MIT-licensed code, reduced to this repository's extension set and
installer; the root `LICENSE` preserves its notice. Public manifests and version-driven release planning/publishing
logic are authored here. No router, OTel, telemetry defaults, private package names, CodeArtifact endpoints, AWS
credentials, internal documentation, or manual-only alpha-release restriction are adopted.

- Pi package documentation: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>
  (installed `@earendil-works/pi-coding-agent@1.3.0`; MIT).
- npm trusted publishing guidance: <https://docs.npmjs.com/trusted-publishers/>
- GitHub Actions concurrency guidance:
  <https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency>

These documentation sources informed explicit resource manifests, runtime/host dependency separation, npm OIDC
permissions and provenance, and queued non-cancelling release runs. Their prose and example workflows were not copied;
the workflow extends this repository's existing quality gate. Token-based publishing, git-tag-triggered releases, and Pi
runtime patching during npm installation were intentionally not adopted.

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
reuses Pi's package/resource discovery, project-trust, and `proper-lockfile` APIs, including the adapted lock pattern
described under the TypeScript overlay below. It keeps discovered skills catalog-only, enables explicit global,
repository, and session activation, preserves explicit `--skill` paths when `--no-skills` is used, and leaves Pi's
unrelated extensions, prompts, themes, packages, providers, trust behavior, and bundled chunks unchanged. It does not
copy Pi's automatic skill-loading behavior or its runtime implementation into the overlay.

The `cli-runtime.js` and `rpc-entry.js` replacements are original wrappers written for this repository, not derived from
upstream's bundle output; Pi's published `dist/bundle/cli.js` compile-cache loader remains unchanged and is pinned by
checksum. Source inputs are fetched from the 1.0.3 release archive and npm tarball with committed checksums; no complete
Pi source checkout is committed.

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

## Pi 1.3.0 `/skills` runtime patch

- Source: `@earendil-works/pi-coding-agent@1.3.0`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `71023aec1546d6d677a65669c5665c0927ce0dd0` (`v1.3.0`), the commit the lightweight release
  tag points to; the npm registry publishes no `gitHead` for this release, and the commit is unsigned
- Source archive: `pi-1.3.0-source.tar.gz`, verified against the release's published `SHA256SUMS`
- npm tarball: `pi-coding-agent-1.3.0.tgz`, pinned by SHA-256 and registry integrity
- License declared by the package: MIT

[`pi-overlay/versions/1.3.0/integration.patch`](pi-overlay/versions/1.3.0/integration.patch) is the 1.1.0 seam rebased
onto Pi 1.3.0's MIT-licensed TypeScript sources and documentation: the added and removed lines are unchanged, and only
hunk positions and blob indexes differ. The generated [`skills.patch`](patches/pi-1.3.0/skills.patch) modifies the
published resource loader, slash-command list, CLI and interactive entry points, and skill documentation, within the
same 48-line seam budget. It adds this repository's original skill-management modules, which compile byte-identically to
the 1.1.0 output, and reuses Pi's package/resource discovery, project-trust, and `proper-lockfile` APIs. It keeps
catalog skills inactive until explicitly enabled, preserves explicit `--skill` paths with `--no-skills`, and does not
copy Pi's automatic skill loading or its skill implementation. The original `cli-runtime.js` and `rpc-entry.js` wrappers
are reused byte-for-byte from 1.1.0 because Pi 1.3.0's `src/cli.ts`, `src/rpc-entry.ts`, and `src/cli/setup.ts` are
unchanged. The published `dist/bundle/cli.js` loader remains unchanged and checksum-pinned. Upstream changes elsewhere
in 1.3.0, including those near the seams, were not adopted. No complete Pi source checkout is committed.

## Pi 1.4.0 `/skills` runtime patch

- Source: `@earendil-works/pi-coding-agent@1.4.0`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `4a080252f06caf63a525d7873c5d94d3c23887e0` (`v1.4.0`), the commit referenced by the
  lightweight release tag; the npm registry publishes no `gitHead`, and GitHub reports the commit as unsigned
- Source archive: `pi-1.4.0-source.tar.gz`, verified against the release's published `SHA256SUMS`
- npm tarball: `pi-coding-agent-1.4.0.tgz`, pinned by SHA-256 and registry integrity
- License declared by the package: MIT

[`pi-overlay/versions/1.4.0/integration.patch`](pi-overlay/versions/1.4.0/integration.patch) adapts the existing seam
against Pi 1.4.0's MIT-licensed TypeScript sources and documentation. The modified-code patch retains the same additions
and removals as 1.3.0; the interactive-mode hunk positions and blob indexes are refreshed. The generated
[`skills.patch`](patches/pi-1.4.0/skills.patch) changes the resource loader, slash-command list, CLI/interactive
dispatch, and skill documentation within the same 48-line generated-runtime seam budget. It adds this repository's
original skill-management modules unchanged, reusing Pi's package discovery, project trust, path, and locking APIs
rather than copying its skill implementation. The original CLI/RPC wrappers are reused byte-for-byte from 1.3.0 after
reviewing 1.4.0's unchanged entrypoint sources and setup. The unchanged compile-cache loader is checksum-pinned. The
build order follows 1.4.0's root build, with telemetry first. Pi's automatic activation of all discovered skills and
unrelated runtime changes are intentionally not adopted into the overlay; unrelated package files and bundled chunks are
left unchanged. No complete Pi source checkout is committed.

## Pi `/skills` TypeScript overlay

- Source: `@earendil-works/pi-coding-agent@1.0.3`, `@earendil-works/pi-coding-agent@1.0.4`,
  `@earendil-works/pi-coding-agent@1.1.0`, `@earendil-works/pi-coding-agent@1.3.0`, and
  `@earendil-works/pi-coding-agent@1.4.0`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revisions reviewed: `d78dc83d633229d12f8b79631384c4c2717c399f` (`v1.0.3`) and
  `7c10bd4337495ee613f2224843ecdf349b80d1df` (`v1.0.4`), taken from the npm registry's `gitHead`; and
  `abe508e1b89912adde45528136c3221eb69acdd7` (`v1.1.0`), `71023aec1546d6d677a65669c5665c0927ce0dd0` (`v1.3.0`), and
  `4a080252f06caf63a525d7873c5d94d3c23887e0` (`v1.4.0`), the commits the release tags point to, because the registry
  publishes no `gitHead` for those releases
- Source acquired from the 1.0.3, 1.0.4, 1.1.0, 1.3.0, and 1.4.0 release archives and verified against each release's
  published `SHA256SUMS`
- License declared by the package: MIT

[`pi-overlay`](pi-overlay) is the authored form of the `/skills` runtime patch; the artifacts under `patches/pi-1.0.3/`,
`patches/pi-1.0.4/`, `patches/pi-1.1.0/`, `patches/pi-1.3.0/`, and `patches/pi-1.4.0/` are generated from it.

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

`pi-overlay/versions/<version>/integration.patch` is a modified-code patch against Pi's MIT-licensed TypeScript sources:
`src/core/resource-loader.ts`, `src/core/slash-commands.ts`, `src/main.ts`, `src/modes/interactive/interactive-mode.ts`,
and `docs/skills.md`. Its unchanged context and modified lines derive from the MIT-licensed Pi package.

`pi-overlay/versions/<version>/replacements/dist/bundle/cli-runtime.js` and `rpc-entry.js` are original hand-written
wrappers, not derived from upstream's generated bundle output. They replace Pi's esbuild-produced bundled entrypoints so
the patched unbundled runtime handles CLI and RPC execution.

`scripts/skills-patch-103.test.mjs` pins the unchanged `dist/bundle/cli.js` loader with a byte-identical five-line
stand-in based on that MIT-licensed loader, and asserts it against each release's checksum manifest.

The overlay intentionally does not adopt Pi's automatic loading of every discovered skill, configured-path confinement,
new public resource-loader mutator APIs, or changes to Pi's unrelated extension, prompt, theme, package, trust, and
provider behavior.

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
- The versioned skills catalog reuses `DefaultPackageManager.resolve()` and its resolved-resource metadata to discover
  package and settings skills with upstream manifest, filtering, scope, and precedence behavior. The catalog merge and
  opt-in activation logic remain original code; Pi's automatic skill loading is intentionally not adopted.
- The skills patches adapt the synchronous `proper-lockfile` acquisition/retry and `finally` release pattern from Pi's
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

## Nigel-upstart pi-buildout maintenance patterns

- Source: `nigel-upstart/pi-buildout`
- Canonical repository: <https://github.com/nigel-upstart/pi-buildout>
- Revision reviewed: `107f1c7418fe9e3a4de739615c3cde0360f04903`
- License: MIT, copyright (c) 2026 Nigel Stuke (same notice as this repository's `LICENSE`)

Conceptual inspiration from `scripts/skills-patch-packages.mjs` and `scripts/skills-patch-dispatch.test.mjs`: discover
supported versions from the overlay directories and exercise dispatch assertions for each retained patch. This
repository reuses its existing `overlayVersions()` discovery instead of copying the fork's package-discovery
implementation. That version-discovery work copied no fork code.

The shell-safe patch helpers in `scripts/build-pi-patch.mjs` are a modified adaptation of the same author's fork code
introduced in `4508faacb4781207cf31de06fecfbe566a525497` and reviewed at the revision above: pass patch text on stdin,
keep directory paths in direct arguments, propagate patch failures, and use Node filesystem copying. The existing MIT
notice is preserved in `LICENSE`. The fork's artifact-staging changes and pinned-version/`--all` CLI were not adopted;
this repository keeps its default all-overlay build and existing generated artifacts and migrations.

The fork's package publishing, router, telemetry extensions, additional baseline aliases, and newer development-version
floor were not adopted by this maintenance adaptation; the development baseline here is Pi 1.0.3.
