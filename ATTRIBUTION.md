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

## Pi 0.84.2 `/skills` runtime patch

- Source: `@earendil-works/pi-coding-agent@0.84.2`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `914cf1472e715297caa30db4b9535d534a9eb718`
- License declared by the package: MIT

[`patches/pi-0.84.2/skills.patch`](patches/pi-0.84.2/skills.patch) is a modified-code patch against Pi's published,
generated runtime and documentation. It modifies upstream `dist/core/resource-loader.js`, `dist/core/slash-commands.js`,
`dist/main.js`, `dist/modes/interactive/interactive-mode.js`, and `docs/skills.md`; their unchanged context and modified
lines derive from the MIT-licensed Pi package. The added `dist/core/skill-management.js` is an original implementation
for this repository, informed by Pi's resource-loading and command conventions rather than copied from an upstream file.

The patch adopts explicit global, repository, and session skill activation; a discoverable-but-inactive catalog;
normalized repository identity; shared CLI and interactive command semantics; diagnostics for invalid configuration; and
checksum-guarded installation. It intentionally does not adopt automatic loading of every discovered skill,
concurrent-update locking, configured-path confinement, new public resource-loader mutator APIs, or changes to Pi's
unrelated extension, prompt, theme, package, trust, and provider behavior.

## Pi 0.84.4 `/skills` runtime patch

- Source: `@earendil-works/pi-coding-agent@0.84.4`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `b79e4cc834970cca69daebffab7df1da7d1e52c4`
- License declared by the package: MIT

[`patches/pi-0.84.4/skills.patch`](patches/pi-0.84.4/skills.patch) is a modified-code patch against Pi's published,
generated runtime and documentation. It modifies upstream `dist/bundle/cli.js`, `dist/bundle/rpc-entry.js`,
`dist/core/resource-loader.js`, `dist/core/slash-commands.js`, `dist/main.js`,
`dist/modes/interactive/interactive-mode.js`, and `docs/skills.md`; their unchanged context and modified lines derive
from the MIT-licensed Pi package. The bundled entrypoints become thin wrappers so the patched unbundled runtime handles
CLI and RPC execution. The added `dist/core/skill-management.js` is an original implementation for this repository,
informed by Pi's resource-loading and command conventions rather than copied from an upstream file.

The patch adopts explicit global, repository, and session skill activation; a discoverable-but-inactive catalog;
normalized repository identity; shared CLI and interactive command semantics; diagnostics for invalid configuration; and
checksum-guarded installation. It intentionally does not adopt automatic loading of every discovered skill,
concurrent-update locking, configured-path confinement, new public resource-loader mutator APIs, or changes to Pi's
unrelated extension, prompt, theme, package, trust, and provider behavior.

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
CLI and RPC execution. The added `dist/core/skill-management.js` is an original implementation for this repository,
informed by Pi's resource-loading and command conventions rather than copied from an upstream file.

The patch adopts explicit global, repository, and session skill activation; a discoverable-but-inactive catalog;
normalized repository identity; shared CLI and interactive command semantics; diagnostics for invalid configuration; and
checksum-guarded installation. Its catalog reuses Pi's package manager to include enabled package and settings skill
sources while preserving Pi's precedence and project-trust behavior. It intentionally does not adopt automatic loading
of every discovered skill, concurrent-update locking, configured-path confinement, new public resource-loader mutator
APIs, or changes to Pi's unrelated extension, prompt, theme, package, trust, and provider behavior.

## Pi documentation and examples

- Source: `@earendil-works/pi-coding-agent`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Releases reviewed: `0.80.6`, `0.82.0`, `0.82.1`, `0.83.0`, `0.84.0`, `0.84.1`, `0.84.2`, `0.84.4`, and `0.85.1`
- Latest documentation and example revision reviewed: `d981de1229ef899957bbe968bc8dcda02a21f477`
- License declared by the package: MIT

Ideas and API patterns used:

- Extension tool registration, lifecycle shutdown hooks, resource discovery, and TUI tool rendering.
- The Pi 0.84.2 and later versioned skills catalogs reuse `DefaultPackageManager.resolve()` and its resolved-resource
  metadata to discover package and settings skills with upstream manifest, filtering, scope, and precedence behavior.
  The catalog merge and opt-in activation logic remain original code; Pi's automatic skill loading is intentionally not
  adopted.
- SDK `AgentSession.compact()` with custom instructions and in-memory sessions.
- RPC JSONL framing and the `prompt`, `steer`, `follow_up`, `abort`, state, and event protocols.
- Model-registry authentication, fuzzy CLI-equivalent model resolution, thinking-level capability maps, and normal child
  resource inheritance.
- Pi's thinking-level clamp policy (prefer the nearest supported level above the request, fall back downward only when
  necessary) is a conceptual adaptation, reimplemented in `extensions/subagents/helpers.ts`; no Pi code was copied.
  `supportedThinkingLevels` additionally narrows OpenAI's direct GPT-5.6 levels beyond what Pi's generated model
  metadata declares, because the live endpoint rejects `minimal` and `max`. Pi's own permissive handling of those two
  levels is intentionally not adopted.
- Pi 0.85.1's resolved session model scope, initial-model precedence, scoped effort pins, and `--models` pattern grammar
  informed the scope-aware routing and recursive scope serialization in `extensions/subagents`. The extension uses Pi's
  published `ctx.scopedModels` API but reimplements routing, strict candidate validation, fallback, and serialization as
  original code. It intentionally freezes resolved wildcard matches instead of propagating and re-expanding raw
  patterns, and it rejects explicit out-of-scope subagent model requests even though Pi's own `--model` flag can select
  outside `--models`.
- Pi's bundled subagent and custom-compaction examples as reference implementations for process invocation, output
  bounds, and compaction setup.

Major pieces intentionally not adopted include Pi's full interactive mode, session-replacement runtime, prompt-template
workflows, custom provider implementations, and bundled role-based subagent profiles. No Pi source file or example was
copied verbatim; the extension is original code using Pi's published APIs and adapting the documented architectural
patterns.

## Artificial Analysis model benchmarks

- Source: Artificial Analysis, <https://artificialanalysis.ai>
- Material reviewed: the "Intelligence vs. Cost per Intelligence Index Task" chart for the GPT-5.6 family, the "Coding
  Agent Index vs. Cost per Task" chart, the multi-benchmark "Intelligence Evaluations" comparison grid, and the
  per-model comparison pages for GPT-5.6 Luna (low/high/max) against GPT-5.4 mini (xhigh), as supplied by the project
  owner in 2026-09.
- License: not declared to this project; no Artificial Analysis text, data file, or image is redistributed here.

Ideas and data used in `extensions/subagents/helpers.ts` and `extensions/subagents/routing-eval-cases.mjs`:

- The relative capability ordering of the GPT-5.6 family (Luna < Terra < Sol) and GPT-6 Astra above Sol, encoded as
  `modelStrengthRank` and as the cheapest-sufficient-tier policy in `ROUTING_LADDER_GUIDANCE`.
- The finding that GPT-5.4 mini is Pareto-dominated by GPT-5.6 Luna on intelligence, cost, and latency simultaneously
  (index 24 at $0.41 and 261s per task, against Luna's 32 at $0.04 and 98s). This is why the routing ladder ranks it
  below Luna even though it is the more expensive model per token, and why the eval suite bands it as `substandard`.
- The effort-level efficient frontier shown by the GPT-5.6 chart: Luna high is preferred over Terra low/medium; Luna
  xhigh over Terra high and Sol low; and Sol medium over Terra xhigh. Terra is retained in classifier guidance only at
  max effort and for task-specific measured evidence; when max is unavailable, automatic classification is told not to
  select Terra.
- Approximate Intelligence Index and benchmark-cost-per-task observations for Luna low through xhigh, Terra low through
  max, and Sol low through max are included as explanatory prompt context rather than executable thresholds. The prompt
  explicitly says the index is comparative, not a percentage, probability, linear scale, or score out of 100.
- The original escalation context for GPT-6 Astra compared its Coding Agent Index of roughly 62 at
  $7.08 per task
  against **GPT-5.6** Sol max's 55 at $6.24. The accompanying claim that Astra hallucinates roughly half
  as often was supplied directly by the project owner and is not drawn from the charts listed above. The current prompt
  instead compares Astra with GPT-6 Sol (see below).

Intentionally not adopted:

- The absolute Intelligence Index values, benchmark subscores, and cost-per-task figures are not used as thresholds
  anywhere in routing logic. They inform a documented ordering and the prompt's guidance text only, so routing does not
  silently depend on numbers that move between Artificial Analysis publication runs.
- No chart image or source data file is redistributed. The retained experiment artifacts contain only the prompt text,
  eval inputs, and model outputs needed to reproduce the routing decision.
- Live pricing and exact model availability still come from Pi's model catalog. Chart cost-per-task figures are labeled
  separately and are not treated as token prices.
- Placement of models absent from the reviewed charts is deliberately left to the ranking fallback rather than guessed.
  In dimension-specific evidence, absence is treated as "not evaluated", not as evidence that the shown model is best.

## GPT-6 Sol and Luna release and pricing (2026-09-22)

- Sources: OpenAI, [release announcement](https://openai.com/index/introducing-gpt-6-sol-and-luna/),
  [API pricing](https://developers.openai.com/api/docs/pricing), and
  [Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra); Artificial Analysis,
  [release benchmark analysis](https://artificialanalysis.ai/articles/gpt-6-sol-and-luna-push-the-cost-efficiency-frontier).
- Revision reviewed: public pages retrieved 2026-09-22 (no immutable revision published).
- Licenses: not declared to this project. No source code, images, or page text copied.

Adapted facts and decisions: GPT-6 Luna costs $0.10/$0.50 per million input/output tokens versus GPT-5.6 Luna's
$0.20/$1.20; GPT-6 Sol costs $2/$10 versus GPT-5.6 Sol's $4/$20. These figures inform the new classifier guidance and
mixed-scope eval catalog; the live model catalog still supplies the actual price and availability. GPT-6 Sol max scores
57 versus GPT-5.6 Sol max's 55 in Artificial Analysis' Coding Agent Index, but GPT-6 Luna max **regresses** (41 versus
43); both show knowledge-work regressions despite lower hallucination rates. Thus GPT-6 Luna and its predecessor retain
an equal strength rank, and the classifier may select the older one when the measured differences matter. The GPT-6 Sol
rank breaks a same-family ceiling tie in favor of the newer Sol when both are eligible. Astra's API price remains
$10/$50, five times GPT-6 Sol's token rate: no Astra price cut was found. The updated prompt compares published
max-effort Coding Agent Index values of roughly 62/$7.08 per task for Astra and 57/$2.99 for GPT-6 Sol; it does not
infer low- or medium-effort costs from those measurements. The escalation gate remains unchanged.

Intentionally not adopted: a blanket claim that every GPT-6 variant outperforms its predecessor; hardcoded per-token
prices as runtime billing authority; treating benchmark points as linear or equivalent to percentages; changing explicit
user requests, effort pins, model scope, or the user-approval requirement. The new live eval stores only our prompts,
cases, and classifier responses rather than redistributing upstream charts or publication text.
