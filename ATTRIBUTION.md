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

## Subagent delegation design (`specs/subagents/modern-layer-design.md`, DRAFT)

The draft manager-first router delegation design studied the sources below. Operator design decisions select one shared
tintinweb-compatible signaling subset, then classifier-found builder-steered delegation, then SDK fallback. This remains
a design document; P0/P2/P3/P4 implementation is now authorized on separate branches/draft PRs. This section records
research and intended reuse, not a claim that code has landed. No upstream code was copied into this document.

- `nicobailon/pi-subagents` — <https://github.com/nicobailon/pi-subagents>, revision
  `d48d580954086a426d31f1c7b8d793a1d26ad184` (`0.79.2`), MIT. Conceptual inspiration only: the structured delegation
  API's exact-tuple attempt identity, single terminal response, cancel-before-start, explicit text vs structured result
  mode, and usage with effective model/thinking; `context: "fresh"` defaulting. Its ordinary tool remains a possible
  builder-steered target only. Neither its signaling nor structured-delegation API is supported, deferred, or planned.
  Not adopted: workflows, missions, schedules, agent frontmatter, management APIs, watchdog/intercom, Herdr/fleet UI,
  worktrees.
- `tintinweb/pi-subagents` — <https://github.com/tintinweb/pi-subagents>, revision
  `ca93a5247e72e7053fcd10bea7125d6c4205f949` (reviewed source snapshot, package version `0.22.0`) and released `v0.22.0`
  source `85a704cb8f35c96c0cabfa665b572bab296942e5`, MIT. Release/package `0.22.0` and ping protocol `2` are distinct.
  This is the minimum verified release baseline; earlier compatibility is unverified. Conceptual inspiration only:
  final-result-by-default with verbose opt-in, `inherit_context: false` as the fresh default, per-call model/thinking,
  and consuming a result to suppress redundant notifications. Proposed compatibility adoption: the documented protocol-2
  ping/spawn/stop/consume request/reply subset and completed/failed events, as documented in `docs/rpc.md` and
  implemented in `src/cross-extension-rpc.ts` and `src/index.ts`. Our manager would answer that generic subset; one
  router adapter would serve both. This is a planned compatible reimplementation, not copied code or a new review
  protocol. Not adopted: steer, global `Symbol.for` registry, compiled `structuredOutput`, scheduling, workflows,
  FleetView, memory, worktree isolation, protocol dialect shims, or competing-manager arbitration. The approved
  final-only wait uses our existing action and bounds; no third-party result rewriting is proposed. The parent
  separately owns any factual upstream discovery/generic-compatibility feature request; none is filed by this design
  task.
- `elpapi42/pi-minimal-subagent` — revision `4c847a37b7d675470a8c5eb50d736d11ceac910a`; `package.json` declares MIT, the
  repository has no LICENSE file. Re-reviewed; no new ideas adopted.
- `earendil-works/pi` — <https://github.com/earendil-works/pi>, MIT; v1.2.0 `06a466935536f8c9bcacb2d5efc0fc021be1bdff`,
  v1.3.0 `71023aec1546d6d677a65669c5665c0927ce0dd0`, main `16f5f0af4d85ca583d045ceb5ed6d646fcaf7761`. Studied
  `packages/coding-agent` extension/SDK declarations and docs (API-boundary evidence) and `packages/durable` README and
  `test/examples/22`, `23`, `26`, `28` at release `71023aec1546d6d677a65669c5665c0927ce0dd0`, plus associated
  `src/harness/types.ts`, `src/types.ts` submission records, and `src/tools/index.ts`. The actual durable-based coding
  agent is a forward-looking conceptual reference, not a runtime-adoption request or evidence of a future Pi roadmap.
  Concrete comparisons: foreground versus background child ownership, accepted submission versus settled answer handle,
  cancellation of a wait versus child termination, explicit tools/configuration versus transcript construction,
  model/structured/UI result channels, and application-owned model selection. The examples return prose; their tool
  types support structured results separately. Their extension-removal recursion shortcut and prose-sentinel reviewer
  continuation are not substitutes for our no-router isolation and bounded parent review-attempt scheduling. The draft
  strengthens tests in existing PRs without copying code or adding a new framework. Not adopted: durable `Harness`,
  storage, task runtime, replay/restart/idempotency guarantees, background reporters, example review loop, or any
  durable dependency. The private `ModelRegistry.runtime` access is accepted in the draft with a runtime guard and
  proposed floor/latest-released contract canary; pinned Pi remains in normal CI. The router/subagents supported host
  range `>=1.2.0 <2.0.0` is operator-approved, with metadata/tests coordinator-owned and floor execution checks required
  before release. This is not npm runtime enforcement or a new installer upper gate; future latest 2.x must flag an
  unsupported-upgrade investigation rather than imply support. The draft audits SDK imports, extension/auth APIs, CLI
  flags, and RPC operations against recorded 1.2.0 sources; no live floor-runtime execution is claimed. Pi session
  custom entries support parent scheduling state; explicit resource loading supports router-free children. Child-task
  classification/model-effort selection runs in the parent before spawn, reusing existing routing and explicit override
  precedence without switching the builder. No child lineage, opaque startup metadata API, or child-router factory is
  adopted. These are API references and original design, not copied upstream implementation. Stale-while-refresh
  discovery and delta-scaled review budgets are operator-directed original design, not attributed upstream behavior.
  Workflow layout draws from this repository’s `.github/workflows/patch-drift.yml`; new action versions and org
  allowlist compatibility remain implementation-time checks. No networked pre-commit hook is proposed.

## Generic compatible subagent signaling

The implementation in `extensions/subagents/signaling.ts` is an original compatible implementation of the documented
`tintinweb/pi-subagents` protocol-2 subset (MIT), not copied code. Sources: <https://github.com/tintinweb/pi-subagents>,
release `v0.22.0` (`85a704cb8f35c96c0cabfa665b572bab296942e5`) and documentation/source snapshot
`ca93a5247e72e7053fcd10bea7125d6c4205f949`, `docs/rpc.md`, `src/cross-extension-rpc.ts`, and terminal emission in
`src/index.ts`. Used: ping/spawn/consume/stop names, reply envelopes, generic task/model/thinking options, final
results, and synchronous consumption. Not adopted: steer, workflow/profile systems, registry singleton, scheduling,
worktrees, proactive parent notifications, or protocol dialect shims. Pi 1.2.0 source
`06a466935536f8c9bcacb2d5efc0fc021be1bdff` and installed 1.3.0 CLI resource suppression flags establish the isolated
launch behavior, including empty `--system-prompt` and `--append-system-prompt` overrides to exclude ambient prompt
files independently of context files; no Pi code was copied. Pi 1.3.0's published `pi-ai/providers/all` catalog getters
and provider documentation informed the fail-closed isolated-model validation: only bundled provider/model/API/endpoint
entries are accepted, because the auth bridge does not reproduce parent extension registrations or endpoint overrides.
This is conceptual API use, not copied code; custom model/provider configuration transport and ambient extension loading
remain intentionally excluded. Child cleanup precedes terminal delivery as an original integration safeguard against
overlapping fallback work. Cancellation is rechecked after cleanup and committed synchronously with terminal
publication; this lifecycle safeguard is original, not an upstream state machine or lock implementation. Pi's installed
1.5.0 `docs/extensions.md` and `examples/extensions/event-bus.ts` were consulted as API references for `pi.events`
([canonical repository](https://github.com/earendil-works/pi), MIT); no example code was copied or adapted.

The router's caller side, `extensions/router/signaling-runner.ts`, is also original code written against the same
tintinweb sources. It was checked against release `v0.22.0` (`85a704cb8f35c96c0cabfa665b572bab296942e5`, MIT):
`src/cross-extension-rpc.ts` (`handleRpc` microtask replies, omitted void `data`, error envelopes), `src/index.ts`
(`buildEventData` terminal payloads and emit-before-notify consumption), `src/usage.ts` (`toReportedUsage`), and
`docs/rpc.md`. Used: per-request reply channels, ping protocol 2, generic `general-purpose` spawn fields, description
correlation, synchronous consume, and stop. Test fixtures reproduce those released envelope shapes, including terminal
usage before or without spawn acceptance. Malformed acceptance retains already observed terminal usage without accepting
advice or permitting replacement. Bounded cancellation/deadline usage drainage, generation-guarded telemetry error
handling after shutdown, and cleanup-before-fallback regressions are original implementation work, not copied upstream
code. Pi's installed 1.3.0 SDK and extension docs (canonical repository and MIT license recorded above) informed
listener lifetimes, disposal, and persisted lease history; no Pi code was copied. Not adopted: steer, `subagents:ready`,
the `Symbol.for` registry, compiled `structuredOutput`, workflows, scheduling, worktrees, resume, or any multi-manager
election.

Builder-steered discovery (`extensions/router/discovery.ts`, `builder-runner.ts`) is original code. Its test fixture
reproduces the parameter shape and the published `isolated` description of tintinweb's normal `Agent` tool from the same
`v0.22.0` release `src/index.ts` (MIT). Nothing tintinweb-specific is in the runtime: any tool qualifies only through
its own published schema and documentation. Stale-while-refresh generations, declarative call plans, and candidate
quarantine follow the approved design. No upstream code was copied. Installed Pi 1.3.0 `docs/sdk.md`,
`docs/extensions.md`, `docs/session-format.md`, and `examples/sdk/13-session-runtime.ts` (canonical Pi repository,
release revision and MIT license above) informed the session-replacement integration: capture plain session identity,
invalidate discovery before contexts expire, and discard late publication/telemetry failure effects across generations.
The reset retains an abort-ignoring flight until settlement rather than adopting a new session runtime or copying
upstream lifecycle code; private context revival and eager discovery retries remain intentionally excluded. Installed Pi
1.3.0 `ToolResultEventBase`, `AgentSession._afterToolCall`, `NestedToolCallRunner`, and the agent-core
finalization/event sequence were also inspected as API evidence: executed-input observation precedes execution-end
mutation accounting, and tool-result usage is execution-local while nested totals are merged later into transcript
messages. The original router now exempts only revalidated orchestration from implementation evidence and counts only
reported, correlated call usage once. No upstream code was copied; tool-result rewriting, usage estimates from prose or
details, and accounting of unrelated/outer-wrapper totals were not adopted. Follow-up accounting separates observed call
IDs from single-verdict ownership, excludes native nested descendants, and drains stale usage for one second without
admitting new call IDs after the delegation run settles; the run-overlap guard remains independent. This and eager
synchronous-classifier rejection cleanup are original repository safeguards using the same documented API boundaries,
not copied Pi lifecycle/usage code. No manager adapter, new transport, estimated usage, or post-grace accounting
recovery was adopted.

## Routing layer (`extensions/router`)

Full design provenance, including the historical conversation export the router's spec derives from and the public
prompting/benchmark references consulted for background, is recorded in
[`specs/routing-layer/source-basis.md`](specs/routing-layer/source-basis.md) and
[`specs/routing-layer/decisions.md`](specs/routing-layer/decisions.md). The two external, runnable/integrable projects
referenced by the implementation are recorded here as well, per this file's role as the repository's attribution record
of first resort.

### Pi extension event semantics

- Sources: [`earendil-works/pi` issue #5581](https://github.com/earendil-works/pi/issues/5581), including
  [our reproduction comment](https://github.com/earendil-works/pi/issues/5581#issuecomment-6009314962), and its fix
  [PR #10739](https://github.com/earendil-works/pi/pull/10739) (merge `a447ba11f3e7760fcff91e924bda8c20033953ea`); the
  `ToolExecutionMode` declaration in `@earendil-works/pi-agent-core` (`dist/types.d.ts`); and the "Events and
  concurrency" section of `@earendil-works/pi-coding-agent` `docs/extensions.md`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`, `packages/agent-core`)
- Minimum supported router host: published Pi `1.2.0` changelog identifies PR #10739 as the release that introduced
  custom-start preparation and busy-start semantics.

Published Pi `1.3.0` (MIT; canonical repository above) was also inspected for async router correction boundaries:
`dist/core/agent-session.js` tool hooks, next-turn refresh, forced-prompt projection, run preparation, and model/effort
setters; and `docs/extensions.md` event and prompt/tool-delta contracts. This conceptual inspection established that
model/effort can refresh between requests but the router's forced prompt has no public mid-run setter. The original
router implementation therefore defers the whole tuple until idle or a new run start. Private setters, mutation of
retained prompt event objects, abort/resume handoffs, and secondary safety latches were not adopted.

The same published `1.3.0` model/effort setters and `ThinkingLevelSelectEvent` declaration were inspected for
operator-effort recovery races. The original router guards distinguish its own effort echoes and the model switch's
post-authentication default-effort echo from operator effort changes during authentication; no upstream setter
implementation or private API was adopted. The published `1.3.0` `AgentSession.setThinkingLevel` and
`ExtensionRunner.emit` were also inspected: the event is emitted without being awaited and each earlier handler is
awaited, so the router records each expected effort echo, including the model switch's default-effort change, by its
observed level transition and consumes it on arrival instead of relying on a synchronous flag window.

No Pi code, issue prose, or documentation prose was copied or modified.

### Pi host contract canary

- Sources: published `@earendil-works/pi-coding-agent` (with lockstep `pi-ai`, `pi-agent-core`, `pi-tui`, `pi-codemode`,
  `pi-mcp`, and `pi-telemetry`) `1.2.0` (tag `v1.2.0`, commit `06a466935536f8c9bcacb2d5efc0fc021be1bdff`) and `1.3.0`
  (tag `v1.3.0`, commit `71023aec1546d6d677a65669c5665c0927ce0dd0`); `docs/sdk.md`, `docs/extensions.md`,
  `docs/custom-provider.md`, `docs/models.md`, and `examples/sdk/06-extensions.ts` and `12-full-control.ts` from the
  installed `1.3.0` package
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`, `packages/ai`,
  `packages/agent-core`)
- License declared by the repository and packages: MIT

Use: `extensions/router/pi-contract.test.mjs`, the shared offline fixture `extensions/router/fixtures/pi-sdk.mjs`, and
`scripts/pi-contract-canary.mjs` assert Pi behavior the router depends on, as documented by those docs and declared in
the packages' `dist/core/extensions/types.d.ts`, `dist/core/model-runtime.d.ts`, `dist/core/event-bus.js`, and
`dist/core/extensions/loader.js` at both versions: the private `ModelRegistry.runtime` field behind
`ExtensionContext.modelRegistry`; runtime API-key resolution through a registered `ProviderConfig.streamSimple` custom
API (used as the no-network fake provider, following the custom-provider stream contract); `ToolInfo` fields from
`getAllTools()` and active-tool membership by exposure; `before_agent_start` `messageType: "custom"` for
`sendMessage(..., { triggerTurn: true })`; `tool_result` fields for direct and `ctx.executeTool()` nested calls; and the
event bus's synchronous `EventEmitter` delivery and reload-time listener invalidation. The full-control example's
empty-resource `ResourceLoader` shape was already adopted by `review-runner.ts`; inline `extensionFactories` follow the
extensions example. The merged separate-session reviewer's provider-error, aborted-usage, and pending-auth cancellation
tests also use this shared custom API fixture rather than replacing the parent runtime's stream method.

Only behavior was used: no Pi code, tests, or documentation prose was copied or modified. Intentionally not adopted: a
public `ctx.modelRegistry.streamSimple()`-backed agent loop replacing the accepted private runtime field, Pi's own
provider test suites, `RpcClient`, a historical version matrix, and any upstream `main` (unreleased) lane.

### Pi tool-argument validation and coercion contract

- Sources: published `@earendil-works/pi-ai` `1.5.0` (tag `v1.5.0`, commit `f9a26365568127461c47a07a37dcb42c140a3ac5`)
  `dist/utils/validation.js` and `@earendil-works/pi-schema` `1.5.0` `dist/coerce.js` (whose coercion rules are declared
  as ported from TypeBox 1.3.27 `Value.Convert`, MIT, with `LICENSES/typebox-LICENSE`); `pi-ai` `1.2.0` and `1.3.0`
  `dist/utils/validation.js` (TypeBox `Value.Convert` for TypeBox-authored schemas, primitive coercion for plain JSON
  Schema)
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/ai`, `packages/schema`)
- License declared by the repository and packages: MIT

Use: `extensions/router/pi-tool-arguments.test.mjs` asserts the observed behavior of the public `validateToolArguments`
at the floor, pinned, and latest Pi: which classifier, planning, reviewer, and subagent arguments are normalized or
rejected, that the result is a copy that leaves the transcript's arguments unchanged, and the documented pre-1.5
difference for plain JSON Schema. Only behavior was used: no Pi, pi-schema, or TypeBox code, tests, or prose was copied
or modified. Intentionally not adopted: pi-schema as a local validator, coercing local validation of persisted or
restored data, assertions on host error wording, and Pi's own validation test suites. Review follow-up also inspected Pi
`1.3.0`'s published `dist/compat.js` and `dist/providers/faux.js` to capture the actual post-clone classifier response
through the public API-provider stream, rather than testing the untouched input fixture. Pi `1.5.0`'s `docs/sdk.md`,
`docs/custom-provider.md`, and `examples/sdk/{06-extensions,12-full-control}.ts` informed the real in-memory router
session that verifies emitted telemetry. These are conceptual API uses, not copied implementation; production
transports, live inference, and persistent session storage are intentionally excluded.

### Pi model catalog: GPT-6.1 Sol pricing

- Source: bundled `@earendil-works/pi-ai` provider catalog shipped with `@earendil-works/pi-coding-agent`
  (`dist/providers/data/openai-codex.json`, model `gpt-6.1-sol`)
- Canonical repository: <https://github.com/earendil-works/pi>
- Revision reviewed: published `1.1.0`, read 2026-10-13; no Git commit was pinned
- License declared by the package: MIT

Use: the router's `gpt-6.1-sol` generation proxy (`extensions/router/core/evidence.ts` and
`specs/routing-layer/generation-evidence-2026-09-22.json`) takes its list rates from that catalog entry (input 2, cache
read 0.1, output 10 USD per million tokens). Only those numeric facts were used; no catalog file or Pi code was copied.
The behavioral prior is intentionally not taken from Pi: it remains a temporary proxy from the router's existing
measured GPT-5.6/6.0 Sol evidence until GPT-6.1 Sol has rollout evidence of its own.

### OpenAI GPT-6.2 model catalog

- Sources: [GPT-6.2 Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol) and
  [GPT-6.2 Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra), reviewed 2026-11-19
- The pages have no pinned revision and declare no separate source license.

The router uses the published model IDs and token rates to add Sol and Astra to their respective routing ladders. Sol
retains the GPT-6.1 Sol price prior. Astra uses the previous Astra rollout cost as a conservative estimate. The router
uses its own existing evidence and resolves endpoints through Pi's scoped registry. The integration adopts the catalog
facts and leaves out provider-specific configuration, prompting examples, and API client code.

### `maximhq/bifrost`

- Repository: <https://github.com/maximhq/bifrost>
- Revision reviewed: not pinned; the router calls Bifrost only as a configured OpenAI-compatible HTTP gateway
  (`BIFROST_BASE_URL` / `BIFROST_VIRTUAL_KEY`) and vendors no Bifrost code
- License: not verified in this repository; see the upstream repository for its declared license

Use: Bifrost is the required real-provider transport for the opt-in explicit-provider evaluation harness
(`extensions/router/eval/real.test.mjs`, `npm run test:eval:real`) and an optional production gateway when a deployment
configures models through it. No Bifrost source was copied; the router only depends on its OpenAI-compatible request
contract and its Bedrock model-path naming, documented in
[`specs/routing-layer/decisions.md`](specs/routing-layer/decisions.md).

### Amazon Bedrock pricing and prompt caching

- Sources: [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/),
  [Bedrock prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html), and
  [the January 2026 one-hour caching announcement](https://aws.amazon.com/about-aws/whats-new/2026/01/amazon-bedrock-one-hour-duration-prompt-caching/)
- Revision reviewed: live documentation on 2026-08-11
- License: no documentation license was identified; no source code or documentation text was copied

Use: published per-token input and output list rates now drive cost-first endpoint ordering.

### Amazon Bedrock Converse tool choice and extended thinking

- Sources:
  [Bedrock Converse `ToolChoice`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolChoice.html)
  and
  [Claude extended thinking](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html)
- Revision reviewed: live documentation and live Converse probes against Bedrock models on 2026-09-29
- License: no documentation license was identified; no source code or documentation text was copied

Use: `extensions/router/core/tool-choice.ts` forces the classifier's named tool via `toolConfig.toolChoice` and, because
Claude rejects budget-style extended thinking alongside a forced tool choice, drops the `thinking` budget form and the
interleaved-thinking beta from `additionalModelRequestFields`. Adaptive thinking and other request fields and betas are
preserved. Providers other than Bedrock Converse, and models that ignore a named tool choice, were intentionally not
adopted.

### Provider model catalogs (Amazon Bedrock and GitHub Copilot)

- Sources: the Amazon Bedrock
  [`ListFoundationModels`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html) and
  [`ListInferenceProfiles`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListInferenceProfiles.html) APIs
  (us-east-1, us-east-2, us-west-2) and the GitHub Copilot `/models` endpoint, whose catalog is documented in
  [Supported AI models in GitHub Copilot](https://docs.github.com/en/copilot/reference/ai-models/supported-models), plus
  live classifier-shaped probes (forced tool call at low reasoning effort) against the listed endpoints
- Revision reviewed: live catalog responses and probes on 2026-09-29
- License: catalog data only; no source code or documentation text was copied

Use: `canonicalVendor` in `extensions/router/core/routing.ts` recognizes the model-ID spellings those catalogs publish
for xAI (`grok-`, `xai.grok-`), Z.ai (`glm-`, `zai.glm-`), Qwen (`qwen`, `qwen.qwen`), NVIDIA (`nemotron-`,
`nvidia.nemotron-`), and Microsoft (`mai-`), and strips Bedrock region prefixes before those vendor segments. The
classifier tiers in `extensions/router/pi-classifier.ts` add `mai-code-1.1-flash`, the only Microsoft model the Copilot
catalog served that returned the forced tool call. Models that failed the probe (Meta Llama tool use, Gemma named-tool
choice, `mai-code-1-flash-picker`, DeepSeek R1) were intentionally not adopted, and no prompt profile or route was
derived from the probes.

### Anthropic prompt caching

- Source: [Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Revision reviewed: live documentation on 2026-08-11
- License: no documentation license was identified; no source code or documentation text was copied

Use: Claude's 5-minute cache-write and cache-read multipliers, TTL refresh behavior, 1-hour write multiplier, and the
models/providers for which the 1-hour option is documented. Only behavioral and pricing facts were consulted; no SDK,
example code, or prose was copied.

### OpenAI prompt caching

- Source: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- Revision reviewed: live documentation on 2026-08-11
- License: no documentation license was identified; no source code or documentation text was copied

Use: GPT-5.6 implicit and explicit breakpoints, its 30-minute minimum TTL, automatic caching for earlier models,
in-memory inactivity/maximum retention, extended retention, and minimum-prefix behavior. The comparison preserves the
documented GPT-5.6 TTL parity with Bedrock and treats any provider hit-rate difference as unmeasured; none of these
facts is used as a token-price claim. No SDK or example code was copied.

## LLM effectiveness research corpus and its upstream benchmark sources

The router's bootstrap priors in [`extensions/router/core/evidence.ts`](extensions/router/core/evidence.ts) and
[`specs/routing-layer/model-evidence-2026-07-25.json`](specs/routing-layer/model-evidence-2026-07-25.json) are derived
from a local research corpus and the public benchmark captures it aggregates.

- Source: local `llm-effectiveness` research corpus (`~/outputs/llm-effectiveness`), normalization version `2.0`
- Initial revision reviewed: capture dated 2026-07-25, spend data through 2026-07-19
- Latest revision reviewed:
  [`teamupstart/ai-acceleration` PR #650](https://github.com/teamupstart/ai-acceleration/pull/650) at
  `a99c2d0145952f99ad92f6d786ef0aa19fa15c97`, report data through 2026-09-22; latest remote `main` reviewed at
  [`392b967c5ec3ea8d63078ddbc31a8b16a1f22836`](https://github.com/teamupstart/ai-acceleration/commit/392b967c5ec3ea8d63078ddbc31a8b16a1f22836)
- License: internal working data; not redistributed by this repository

Use: numeric priors (deterministic pass rate, hard-task pass rate, regression-breakage rate, partial credit on failure,
repeat reliability, wall time, agent steps, p90 peak context, cost per pass) were derived from the initial corpus's
`analysis/router_capability_slices.py` output and its `ROUTING_LEARNINGS.md` interpretation, then transcribed as typed
data with per-row provenance. The refreshed report contributes GPT-6 Astra's direct DeepSWE pass, hard-task,
repeatability, latency, steps, cost (as corrected by DataCurve's 2026-09-22 recapture), and language-slice observations
plus its two-source max-tier corroboration; Gemini 3.8 Flash's effort-specific consensus band, CursorBench score, and
DeepSWE observations; and current Artificial Analysis intelligence and speed context. GPT-6 Luna/Sol deliberately
inherit the corresponding GPT-5.6 Luna/Sol priors, and Claude Opus 5.5 inherits Opus 5, as operator-requested generation
proxies. Their cost per pass is repriced from the report's verified vendor list rates
(`artificialanalysis.ai/pricing-source-data.csv`) applied to each source row's measured DeepSWE token totals
(`datacurve_deepswe_v1.1/derived/rollout_metrics_by_config.csv`); only those numbers and Astra's direct row were
transcribed, into
[`specs/routing-layer/generation-evidence-2026-09-22.json`](specs/routing-layer/generation-evidence-2026-09-22.json).
The single-source CursorBench 4.0 and Artificial Analysis observations for GPT-6 Sol/Luna and Opus 5.5 were
intentionally not adopted as priors, because they supply no regression, repeatability, or latency-tail fields. Astra
high retains Sol-high regression, failed-trial partial-credit, and p90-peak-context fields only where the Astra source
has no observation, and is confined to high-intelligence planning/advisory/review ladders. No corpus or `ai_usage` code,
prose, or raw benchmark records were copied. The report's Sonnet experiment proposal, frontend task heuristics, and
automatic cross-model percentile ranking were intentionally not adopted; the router preserves its existing consequence
gates and requires local acceptance telemetry before automatic promotion.

Upstream sources that corpus aggregates, all consumed as published measurements rather than code:

- **DataCurve DeepSWE v1.1** — <https://deepswe.datacurve.ai/data/v1.1>; artifacts `trials.json` and `tasks.json`,
  22,586 rollouts over 113 tasks on the `mini-swe-agent` harness. License not declared on the data page. Used for pass
  rate, regression breakage, reliability, wall time, steps, peak context, and cost-per-pass priors, including the
  language buckets.
- **CursorBench 3.2** — <https://cursor.com/cursorbench>; captured 2026-07-24. License not declared. Used only as
  independent corroboration of candidate ordering. Cursor's Grok 4.5 training-contamination disclosure is preserved.
- **Artificial Analysis** — <https://artificialanalysis.ai>; captured 2026-07-24 from a logged-in non-Pro session.
  License not declared; task cost/time are absent from that capture. Used for capability and list-price context only.
- **CloudZero observed spend** — <https://app.cloudzero.com>; 30-day AWS Marketplace Claude window ending 2026-07-24.
  Internal billing observations. Used only to distinguish observed route rates from published list prices.

Two sources were added to that corpus on 2026-07-25 and inform the per-language routing policy without contributing
numeric priors:

- **SWE-bench Multilingual leaderboard** — <https://www.swebench.com/multilingual-leaderboard.html>; captured
  2026-07-25; 300 tasks across 8 language labels, single-attempt `mini-swe-agent`. License not declared on the
  leaderboard page; the SWE-bench project is MIT-licensed and the dataset is published as
  `SWE-bench/SWE-bench_Multilingual`. Used only for language difficulty ordering, which is what survives the corpus's
  generation-currency rule. Its per-vendor per-language comparisons were **deliberately not adopted**: all three OpenAI
  submissions are GPT-5.2-era and excluded, so those comparisons were cross-generation rather than cross-vendor.
- **OskarsEzerins `llm-benchmarks`** — <https://github.com/OskarsEzerins/llm-benchmarks>; revision `c5ad31674aeb`;
  captured 2026-07-25; declared license MIT (© Oskars Ezerins). The only retained source that evaluates
  current-generation router candidates on Ruby. Used as a weak near-tie preference and as the basis for requiring a
  RuboCop gate on Ruby routes. Its four-task Minitest pass ratios were **deliberately not adopted** as pass-rate priors,
  because they measure a different construct than the rollout verifier outcomes and have very low statistical power. No
  upstream code was copied.

Intentionally not adopted: no raw benchmark score is copied into runtime policy, no arithmetic is performed across
incompatible benchmarks, no Artificial Analysis GitHub Copilot price is treated as a real cost, and no
unsupported-vendor model (Kimi, Grok, GLM, Muse) is made a routing candidate. Benchmark pass rates are treated strictly
as pre-telemetry ordering priors and never as the router's acceptance signal.

### Scoped-model analysis refresh

- Source: local `llm-effectiveness` research corpus (`/Users/nigel.stuke/outputs/llm-effectiveness`), with data through
  2026-08-13
- Registry source: `@earendil-works/pi-ai@0.80.7` generated model registry
- Upstream measurement and pricing sources: [DataCurve DeepSWE v1.1](https://deepswe.datacurve.ai/data/v1.1),
  [SWE-bench Verified and SWE-bench Multilingual](https://www.swebench.com/), [CursorBench](https://cursor.com/evals),
  [Artificial Analysis](https://artificialanalysis.ai/),
  [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/), and CloudZero authenticated AWS cost data
- Revision reviewed: corpus capture with source data through 2026-08-13 and the pinned pi-ai registry above; no
  independent public-page revisions were pinned
- Licenses: pi-ai and the SWE-bench project declare MIT; the local corpus and CloudZero observations are internal; no
  license was identified for the DataCurve data, CursorBench, Artificial Analysis, or AWS documentation

Use: endpoint-rate observations, the CloudZero token mix, benchmark outcomes, and derived break-even and
cost-per-resolved comparisons were transcribed as numeric data into
[`specs/routing-layer/scoped-model-analysis-2026-08-13.md`](specs/routing-layer/scoped-model-analysis-2026-08-13.md).
The completion-cost, cache-sensitivity, generation-currency, and reachable-versus-measured interpretations were used as
conceptual analysis. No upstream prose or code was copied or modified.

Intentionally not adopted: the analysis makes no runtime policy change, transfers no evidence between unmatched model
versions, does not treat single-attempt verifier outcomes as human acceptance, and does not infer unverified Bedrock
cache or tool-call behavior.

### Single-attempt evidence class

- Sources: the same [SWE-bench Verified and SWE-bench Multilingual](https://www.swebench.com/) leaderboard captures
  recorded above, taken from the local `llm-effectiveness` corpus capture with source data through 2026-08-13
- Revision reviewed: that corpus capture; no independent public-page revision was pinned
- License: the SWE-bench project declares MIT; the local derivation is internal

Use: single-attempt resolve rates, each submission's own reported cost per attempted task, median API-call counts, and
per-language resolve and cost-per-resolved slices for ten submissions were derived into
[`specs/routing-layer/single-attempt-evidence-2026-08-13.json`](specs/routing-layer/single-attempt-evidence-2026-08-13.json)
by [`scripts/generate-single-attempt-evidence.mjs`](scripts/generate-single-attempt-evidence.mjs) and mirrored into
[`extensions/router/core/single-attempt-data.ts`](extensions/router/core/single-attempt-data.ts). This is the first
runtime use of these numbers; the earlier entry above described a documentation-only record. No upstream prose or code
was copied or modified.

Intentionally not adopted: the leaderboard's own ranking and any percentile derived from it are not used as an ability
scale, because the cost-bearing Verified population tops out at a prior-generation frontier model. The five terms the
router's cost-to-done model requires and single-attempt submissions cannot measure were not estimated or defaulted, and
the data is structurally barred from that model rather than down-weighted within it. No model became routable.

## Pi 0.85.1 `/skills` runtime patch (retired)

Historical attribution retained for the shared overlay. Its versioned artifacts were removed in #109.

- Source: `@earendil-works/pi-coding-agent@0.85.1`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `d981de1229ef899957bbe968bc8dcda02a21f477` (`v0.85.1`)
- License declared by the package: MIT

`patches/pi-0.85.1/skills.patch` is a modified-code patch against Pi's published, generated runtime and documentation.
It modifies upstream `dist/bundle/cli.js`, `dist/bundle/rpc-entry.js`, `dist/core/resource-loader.js`,
`dist/core/slash-commands.js`, `dist/main.js`, `dist/modes/interactive/interactive-mode.js`, and `docs/skills.md`; their
unchanged context and modified lines derive from the MIT-licensed Pi package. The bundled entrypoints become thin
wrappers so the patched unbundled runtime handles CLI and RPC execution. The added `dist/core/skill-management.js` is
primarily an original implementation for this repository, informed by Pi's resource-loading and command conventions.

The persisted-skill locking helpers are modified adaptations of the synchronous `proper-lockfile` retry and guaranteed
release pattern in Pi's MIT-licensed `dist/core/trust-manager.js`; the integration around the complete skill
read-modify-write transaction is original to this repository. The patch adopts explicit global, repository, and session
skill activation; a discoverable-but-inactive catalog; normalized repository identity; shared CLI and interactive
command semantics; diagnostics for invalid configuration; concurrent-update locking; and checksum-guarded installation.
Its catalog reuses Pi's package manager to include enabled package and settings skill sources while preserving Pi's
precedence and project-trust behavior. It intentionally does not adopt automatic loading of every discovered skill,
configured-path confinement, new public resource-loader mutator APIs, or changes to Pi's unrelated extension, prompt,
theme, package, trust, and provider behavior.

## Pi 0.87.1 `/skills` runtime patch (retired)

Historical attribution retained for the shared overlay. Its versioned artifacts were removed in #109.

- Source: `@earendil-works/pi-coding-agent@0.87.1`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `f07218c4d4bbc12bef056a7058c3dd49dfe41abe` (`v0.87.1`)
- License declared by the package: MIT

`patches/pi-0.87.1/skills.patch` is a modified-code patch against Pi's published, generated runtime and documentation,
generated from the TypeScript overlay below. It modifies upstream `dist/bundle/cli-runtime.js`,
`dist/bundle/rpc-entry.js`, `dist/core/resource-loader.js`, `dist/core/slash-commands.js`, `dist/main.js`,
`dist/modes/interactive/interactive-mode.js`, and `docs/skills.md`; their unchanged context and modified lines derive
from the MIT-licensed Pi package. The bundled runtime and RPC entrypoints become thin wrappers so the patched unbundled
runtime handles CLI and RPC execution; upstream's `dist/bundle/cli.js` compile-cache loader is left unchanged and is
only pinned by checksum in both manifests. The added `dist/core/skill-management.js` and
`dist/core/skill-management-core.js` are compiled from this repository's original overlay code and are byte-identical to
the 0.85.1 patch's copies.

The patch adopts the same behavior as the 0.85.1 patch: explicit global, repository, and session skill activation; a
discoverable-but-inactive catalog built on Pi's package manager; normalized repository identity with non-default ports
preserved; shared CLI and interactive command semantics; strict configuration validation; concurrent-update locking of
persisted skill configuration; and checksum-guarded installation. The locking helpers adapt the same `proper-lockfile`
pattern from Pi 0.87.1's MIT-licensed `dist/core/trust-manager.js`, which is unchanged in shape from 0.85.1. It
intentionally does not adopt Pi 0.87.1's automatic loading of every discovered skill, and does not change Pi's unrelated
extension, prompt, theme, package, trust, provider, compile-cache, or bundled-chunk behavior. The `docs/skills.md`
changes were rewritten against 0.87.1's restructured skills page rather than carried over from 0.85.1.

The retired 0.87.1 entrypoint test wrote a five-line stand-in for upstream 0.87.1's `dist/bundle/cli.js`
(`enableCompileCache()` followed by `createRequire(import.meta.url)("./cli-runtime.js")`). That shape is adapted from
the MIT-licensed Pi package so the test can exercise the same `require()` dispatch the published loader performs.

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
previously attributed above. It keeps discovered skills catalog-only, enables explicit global, repository, and session
activation, preserves explicit `--skill` paths with `--no-skills`, and leaves Pi's unrelated extensions, prompts,
themes, packages, providers, trust behavior, and bundled chunks unchanged. It does not copy Pi's automatic skill-loading
behavior or its runtime implementation into the overlay.

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
- Upstream revision reviewed: `4a080252f06caf63a525d7873c5d94d3c23887e0` (`v1.4.0`)
- Source archive: `pi-1.4.0-source.tar.gz`, verified against the release's published `SHA256SUMS`
- npm tarball: `pi-coding-agent-1.4.0.tgz`, pinned by SHA-256 and registry integrity
- License declared by the package: MIT

[`pi-overlay/versions/1.4.0/integration.patch`](pi-overlay/versions/1.4.0/integration.patch) adapts the existing opt-in
skills seam to Pi 1.4.0's MIT-licensed TypeScript sources and documentation. The generated
[`skills.patch`](patches/pi-1.4.0/skills.patch) modifies the resource loader, slash-command list, CLI and interactive
entry points, and skill documentation. These are modified-code patches containing upstream context, not merely
conceptual inspiration. The skill-management modules remain this repository's original implementation, reusing Pi's
package/resource discovery, project-trust, and locking APIs. Catalog skills remain inactive until explicitly enabled;
explicit `--skill` paths still load with `--no-skills`. Original hand-written entrypoint wrappers route CLI and RPC
execution through the patched unbundled runtime while preserving process setup; the published CLI loader stays unchanged
and checksum-pinned. Pi's automatic loading of all discovered skills, generated bundle chunks, and unrelated 1.4.0
behavior are not adopted into this overlay. No complete upstream source checkout is committed; the upstream MIT notice
is retained in the root `LICENSE`, which also ships with the standalone patch package.

## Pi 1.5.0 `/skills` runtime patch

- Source: `@earendil-works/pi-coding-agent@1.5.0`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `f9a26365568127461c47a07a37dcb42c140a3ac5` (`v1.5.0`), the commit the lightweight release
  tag points to; the npm registry publishes no `gitHead` for this release, and the commit is unsigned
- Source archive: `pi-1.5.0-source.tar.gz`, verified against the release's published `SHA256SUMS`
- npm tarball: `pi-coding-agent-1.5.0.tgz`, pinned by SHA-256 and registry integrity
- License declared by the package: MIT

[`pi-overlay/versions/1.5.0/integration.patch`](pi-overlay/versions/1.5.0/integration.patch) is the 1.3.0 seam rebased
onto Pi 1.5.0's MIT-licensed TypeScript sources and documentation. The only changed line is the `utils/paths.ts` import
in `interactive-mode.ts`, which keeps upstream's new `shortenHomePath` import beside the seam's `resolvePath`; other
differences are hunk positions, context lines, and blob indexes. The generated
[`skills.patch`](patches/pi-1.5.0/skills.patch) modifies the published resource loader, slash-command list, CLI and
interactive entry points, and skill documentation, within the same 48-line seam budget. It adds this repository's
original skill-management modules, which compile byte-identically to the 1.3.0 output, and reuses Pi's package/resource
discovery, project-trust, and `proper-lockfile` APIs. It keeps catalog skills inactive until explicitly enabled,
preserves explicit `--skill` paths with `--no-skills`, and does not copy Pi's automatic skill loading or its skill
implementation. The original `cli-runtime.js` and `rpc-entry.js` wrappers are reused byte-for-byte from 1.3.0 because Pi
1.5.0's `src/cli.ts`, `src/rpc-entry.ts`, and `src/cli/setup.ts` are unchanged. The published `dist/bundle/cli.js`
loader remains unchanged and checksum-pinned. Upstream changes elsewhere in 1.5.0, including those near the seams, were
not adopted. No complete Pi source checkout is committed.

## Pi 1.5.2 `/skills` runtime patch

- Source: `@earendil-works/pi-coding-agent@1.5.2`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `b4afdddf44e059c67ccf5097e5317d913521b470` (`v1.5.2`), the release tag's commit; the npm
  registry publishes no `gitHead` for this release
- Source archive: `pi-1.5.2-source.tar.gz`, verified against the release's published `SHA256SUMS`
- npm tarball: `pi-coding-agent-1.5.2.tgz`, pinned by SHA-256 and registry integrity
- License declared by the package: MIT

[`pi-overlay/versions/1.5.2/integration.patch`](pi-overlay/versions/1.5.2/integration.patch) rebases the 1.5.0 seam onto
Pi 1.5.2's MIT-licensed TypeScript sources and documentation. Only hunk positions and blob indexes change. The generated
[`skills.patch`](patches/pi-1.5.2/skills.patch) modifies the published resource loader, slash-command list, CLI and
interactive dispatch, and skill documentation within the same 48-line seam budget. These are modified-code patches
containing upstream context, not merely conceptual inspiration. The shared skill-management modules remain this
repository's original implementation and reuse Pi's resource discovery, project-trust, and locking APIs; they compile
byte-identically to 1.5.0. The original CLI/RPC wrappers are reused byte-for-byte because upstream's entrypoint sources
and setup are unchanged. The published CLI loader stays unchanged and checksum-pinned. Pi's automatic activation of
catalog skills, generated bundle chunks, and unrelated auth, session-fork, and UI changes are not copied into the
overlay; those features remain upstream's implementation in the host package. No complete upstream checkout is
committed. The upstream MIT notice remains in root `LICENSE` and ships with the standalone patch package.

## Pi `/skills` TypeScript overlay

- Source: `@earendil-works/pi-coding-agent@0.85.1`, `@earendil-works/pi-coding-agent@0.87.1`,
  `@earendil-works/pi-coding-agent@1.0.3`, `@earendil-works/pi-coding-agent@1.0.4`,
  `@earendil-works/pi-coding-agent@1.1.0`, `@earendil-works/pi-coding-agent@1.3.0`, and
  `@earendil-works/pi-coding-agent@1.4.0`, `@earendil-works/pi-coding-agent@1.5.0`, and
  `@earendil-works/pi-coding-agent@1.5.2`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revisions reviewed: `d981de1229ef899957bbe968bc8dcda02a21f477` (`v0.85.1`),
  `f07218c4d4bbc12bef056a7058c3dd49dfe41abe` (`v0.87.1`), `d78dc83d633229d12f8b79631384c4c2717c399f` (`v1.0.3`),
  `7c10bd4337495ee613f2224843ecdf349b80d1df` (`v1.0.4`), and `abe508e1b89912adde45528136c3221eb69acdd7` (`v1.1.0`),
  taken from the corresponding signed release tag, and `71023aec1546d6d677a65669c5665c0927ce0dd0` (`v1.3.0`), taken from
  its lightweight, unsigned release tag; the 1.4.0, 1.5.0, and 1.5.2 revisions are recorded above
- Source acquired from the release assets `pi-0.85.1-source.tar.gz`, `pi-0.87.1-source.tar.gz`,
  `pi-1.0.3-source.tar.gz`, `pi-1.0.4-source.tar.gz`, `pi-1.1.0-source.tar.gz`, `pi-1.3.0-source.tar.gz`, and
  `pi-1.4.0-source.tar.gz`, `pi-1.5.0-source.tar.gz`, and `pi-1.5.2-source.tar.gz`, each verified against upstream's
  published `SHA256SUMS` for that release
- License declared by the package: MIT

[`pi-overlay`](pi-overlay) is the authored form of the `/skills` runtime patch; the artifacts under
`patches/pi-0.85.1/`, `patches/pi-0.87.1/`, `patches/pi-1.0.3/`, `patches/pi-1.0.4/`, `patches/pi-1.1.0/`,
`patches/pi-1.3.0/`, `patches/pi-1.4.0/`, `patches/pi-1.5.0/`, and `patches/pi-1.5.2/` are generated from it.

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
Pi's existing `proper-lockfile` dependency, which both 0.85.1 and 0.87.1 ship; no new upstream dependency is introduced.

`pi-overlay/versions/0.85.1/integration.patch` and `pi-overlay/versions/0.87.1/integration.patch` are modified-code
patches against Pi's MIT-licensed TypeScript sources for those releases: `src/core/resource-loader.ts`,
`src/core/slash-commands.ts`, `src/main.ts`, `src/modes/interactive/interactive-mode.ts`, and `docs/skills.md`. Their
unchanged context and modified lines derive from the MIT-licensed Pi package. The 0.87.1 seam was rebased by re-reading
the 0.87.1 sources: the code call sites are unchanged, its interactive-mode import extends the existing `utils/paths.ts`
import, and its documentation hunk targets the rewritten skills page.

`pi-overlay/versions/0.85.1/replacements/dist/bundle/cli.js` and `rpc-entry.js`, and
`pi-overlay/versions/0.87.1/replacements/dist/bundle/cli-runtime.js` and `rpc-entry.js`, are original hand-written
wrappers, not derived from upstream's generated bundle output. They replace Pi's esbuild-produced bundled entrypoints so
the patched unbundled runtime handles CLI and RPC execution. The 0.87.1 wrappers have the same content as the 0.85.1
ones, because 0.87.1's `src/cli.ts`, `src/cli/setup.ts`, and `src/rpc-entry.ts` are unchanged from 0.85.1.

This repository vendors no upstream source and maintains no fork. Upstream source is fetched per generation run against
pinned, checksum-verified inputs, and is not committed here.

## Pi documentation and examples

- Source: `@earendil-works/pi-coding-agent`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Releases reviewed: `0.80.6`, `0.80.7`, `0.82.0`, `0.82.1`, `0.83.0`, `0.84.0`, `0.84.1`, `0.84.2`, `0.84.4`, and
  `0.85.1`
- Latest documentation and example revision reviewed: `d981de1229ef899957bbe968bc8dcda02a21f477`
- License declared by the package: MIT

Ideas and API patterns used:

- Extension tool registration, lifecycle shutdown hooks, resource discovery, and TUI tool rendering.
- Runtime active-tool selection through `getActiveTools()` / `setActiveTools()`, used to expose safety validators only
  at valid builder lifecycle phases; stale calls retain execution-time guards.
- The Pi 0.85.1 and 0.87.1 versioned skills catalogs reuse `DefaultPackageManager.resolve()` and its resolved-resource
  metadata to discover package and settings skills with upstream manifest, filtering, scope, and precedence behavior.
  The catalog merge and opt-in activation logic remain original code; Pi's automatic skill loading is intentionally not
  adopted.
- The Pi 0.85.1 and 0.87.1 patches adapt the synchronous `proper-lockfile` acquisition/retry and `finally` release
  pattern from Pi's trust manager so skill configuration updates serialize across processes.
- SDK `AgentSession.compact()` with custom instructions and in-memory sessions.
- Pi `1.3.0`'s `docs/sdk.md`, `examples/sdk/12-full-control.ts`, and published
  `dist/core/{sdk,model-registry,model-runtime,agent-session}.js` informed the router's independent reviewer runner.
  Canonical source: <https://github.com/earendil-works/pi/tree/v1.3.0/packages/coding-agent> (MIT). Conceptual API use:
  in-memory sessions/settings, an empty ResourceLoader, native read-only tool selection, a custom verdict tool,
  abort/dispose, and usage events. The runner uses a guarded, operator-approved read of ModelRegistry's private runtime
  field to reuse model/auth access; no Pi implementation was copied. We intentionally exclude normal resource
  inheritance, persistent reviewer transcripts, RPC subprocesses, and any subagents-extension dependency. Published Pi
  `1.4.0`'s `docs/sdk.md`, `docs/extensions.md`, `docs/packages.md`, `docs/configuration.md`, and
  `examples/sdk/06-extensions.ts` were also reviewed, and the runner's nine offline SDK tests were executed against the
  installed `1.4.0` package to verify runtime reuse, isolation, cancellation, and usage. Canonical source:
  <https://github.com/earendil-works/pi/tree/v1.4.0/packages/coding-agent> (MIT). This is API compatibility
  verification, not copied implementation. Durable bounded review-attempt identities are original router scheduling
  logic, not upstream session replay or persistence machinery.
- Pi `1.3.0`'s SDK/codemode documentation and `examples/sdk/06-extensions.ts` and `14-codemode-mcp.ts` informed the
  advisory-router regression fixture: in-memory `AgentSession`, explicit resource factories, deterministic model
  responses, and real nested tool dispatch. This is conceptual API use, not copied Pi code; live providers, MCP
  connections, user resources, and persistent sessions are intentionally excluded.
- Pi `1.3.0`'s `docs/security.md`, `containerization.md`, `cli.md`, and `settings.md` informed the router's documented
  separation between advisory prompts, native tool selection, and whole-process isolation. No documentation text or
  isolation implementation was copied; the router does not implement a sandbox.
- RPC JSONL framing and the `prompt`, `steer`, `follow_up`, `abort`, state, and event protocols.
- Pi `1.3.0`'s published `dist/core/agent-session.js`, `dist/modes/rpc/rpc-mode.js`, and
  `@earendil-works/pi-agent-core`'s `dist/agent-loop.js` informed the interrupted-child queue recovery: queued user
  messages emit `message_start` before their assistant response, including steering within an existing run. The subagent
  tracks that boundary to restore final-answer eligibility only when newly queued work begins. Recovery markers are
  owned per request so handled or rejected duplicate input cannot retain a stale marker or remove another request's
  accepted marker; transformed queue text replaces only its owner's raw marker. This is protocol compatibility
  implemented independently; no Pi code was copied, and queue scheduling was not adopted.
- Pi `1.1.0`'s published package layout (the `.` export resolving under `dist/`, with the `pi` bin at
  `dist/bundle/cli.js`), its `--mode rpc` CLI flags, and the `registerProvider()` API documented in
  `dist/core/extensions/types.d.ts`. `extensions/subagents/rpc.integration.test.mjs` uses these to launch the pinned Pi
  CLI in RPC mode, and `rpc.integration-provider.mjs` registers a test-only `openai-completions` provider that points at
  a local deterministic fixture. The test asserts Pi's observable `prompt`, `follow_up` (queued while streaming),
  `get_state`, `get_session_stats`, and shutdown behavior. No Pi code was copied.
- Model-registry authentication, fuzzy CLI-equivalent model resolution, thinking-level capability maps, and normal child
  resource inheritance.
- The `@earendil-works/pi-ai@0.80.7` generated registry's endpoint rates and capabilities, plus its `calculateCost`
  cache-accounting behavior, as versioned evidence for the offline endpoint survey and routing evidence document. No
  registry generator or cost-calculation code was copied or adopted into the router runtime.
- Pi's thinking-level clamp policy (prefer the nearest supported level above the request, fall back downward only when
  necessary) is a conceptual adaptation, reimplemented in `extensions/subagents/helpers.ts`; no Pi code was copied.
  `supportedThinkingLevels` additionally narrows OpenAI's direct GPT-5.6 levels beyond what Pi's generated model
  metadata declares, because the live endpoint rejects `minimal` and `max`. Pi's own permissive handling of those two
  levels is intentionally not adopted.
- Pi's bundled subagent and custom-compaction examples as reference implementations for process invocation, output
  bounds, and compaction setup.

Major pieces intentionally not adopted include Pi's full interactive mode, session-replacement runtime, prompt-template
workflows, custom provider implementations (beyond the test-only integration fixture above), and bundled role-based
subagent profiles. No Pi source file or example was copied verbatim; the extension is original code using Pi's published
APIs and adapting the documented architectural patterns.

### Router start-mode scoping (`extensions/router/core/start-mode.ts`)

The router's start-mode configuration reuses the repository-identity scoping mechanism introduced by this repository's
version-pinned pi skills patch (`patches/pi-0.83.0/skills.patch`, applied to `@earendil-works/pi-coding-agent@0.83.0`,
MIT), which itself extends pi's skills configuration.

- Adopted as **modified code**: the git-remote normalization and repository-key resolution algorithm — remote preference
  order `upstream`, `origin`, then the first configured remote; normalization of SCP-style, HTTPS, `git+`, and `ssh://`
  URLs to `host:path`; and the `local:~/<path-relative-to-$HOME>` fallback for a repository with no usable remote. The
  router's copy is retyped for TypeScript, split into a pure module with the git calls kept in the extension's I/O
  layer, and hardened against prototype-polluting keys. Keeping the algorithm identical is deliberate so
  `repo-skills.json` and `repo-router-config.json` use one key format.
- Adopted as **conceptual pattern**: a global JSON configuration file plus a repository-keyed file in the agent
  directory, where the repository entry overrides the global value.
- **Intentionally not adopted**: the skills catalog/activation model, session-scoped (`--session`) entries, the
  `/skills` command surface, and the enabled-entry list shape. Router start mode is a single scalar preference per
  scope, not a list, and it is not settable from a slash command.

## `pi-web-access` (removed local OpenAI auth patch)

- Source: `pi-web-access`
- Canonical repository: <https://github.com/nicobailon/pi-web-access>
- Revision reviewed: published npm package `0.14.0`
- License declared by the package: MIT (© 2025 Nico Bailon)

No derived material from this package remains in the repository. A one-hunk modification to that release's
`openai-search.ts` was tracked briefly and then deleted once the installed package moved to `0.22.0`, where the patched
construct no longer exists and the hunk no longer applies. It was never vendored: no upstream source file was copied
here, and the package retains its own `LICENSE`.

The entry is kept because the modification did exist and was applied to an installed package tree.
`patches/pi-web-access-0.14.0/REMOVED.md` records what the patch changed, what it deliberately left in place, why it was
removed, and the commit plus baseline and patched SHA-256 values needed to recover or verify it. Do not reapply that
diff to another version; derive a fresh one from the clean package of the version actually installed.

## `pi-otel` (vendored OpenTelemetry extension fork)

- Source: `pi-otel`
- Canonical repository: <https://github.com/NikiforovAll/pi-otel>
- Revision vendored: `bf00f530d3667375a5317a0f425d0918e6cfac7e` (release `0.3.0`)
- License declared by the source: Apache-2.0 (© 2026 Oleksii Nikiforov)

`extensions/otel` is a vendored fork, not conceptual inspiration: the extension source under `extensions/otel/src` and
its test suite under `extensions/otel/test` are copied from that revision. The upstream `LICENSE` is retained verbatim
at `extensions/otel/LICENSE`, and every file modified after the import carries a prominent notice naming the change, as
Apache-2.0 §4(b) requires.

What was adopted: the pi lifecycle wiring, the GenAI span tree (`invoke_agent` / `chat` / `execute_tool`), provider-name
normalization, content-capture modes, token and cost attributes, the OTLP SDK bootstrap across the traces, metrics, and
logs signals, shell trace propagation, and the `/otel` dashboard command.

What was intentionally not adopted: the upstream VitePress documentation site, the Biome configuration, the Husky hooks,
and the npm publication workflow. The upstream directory layout (`src/`, `test/`) is preserved so later upstream
revisions remain diffable, which is also why the root project's formatter, linter, and typechecker exclude this
directory rather than restyling the vendored source.

Owned modifications at import: the package manifest declares the OpenTelemetry packages the source imports but upstream
only obtained transitively through `@opentelemetry/sdk-node`, so the vendored tree installs and typechecks standalone.
Subsequent owned changes are recorded in `extensions/otel/README.md` and in the per-file notices: a configurable
`otel.maxAttributeBytes` cap replacing upstream's module-private 60 KiB `MAX_ATTR_BYTES` constant (keeping 60 KiB as the
default and making truncation exact and character-safe), migration of the whole OpenTelemetry dependency train to the
2.x / 0.2xx line with the three API changes it required, GenAI registry spellings for the cache and reasoning token keys
replacing the pre-1.44 spellings rather than dual-writing them, and corrections to the `/otel` command so status probes
the configured endpoint's own host (rejecting non-HTTP schemes and unbracketing IPv6 literals) and start announces only
a dashboard that actually came up. It also resets the session-start bookkeeping across session transitions and marks a
failed LLM request's span, both of which upstream omits.

### Provider-scoped OpenTelemetry ownership

- Source: `pi-otel-telemetry`
- Canonical repository: <https://github.com/mprokopov/pi-otel-telemetry>
- Revision reviewed: `d9714929da0cff692dc7b7dece8d643a231aed51`
- License declared by the source: MIT

Conceptual use: that revision demonstrates the provider-scoped tracer pattern — obtain a tracer directly from an owned
provider instead of registering it globally — and documents why global one-time registration loses spans after reload.
The same ownership principle informed `extensions/otel/src/otel/sdk.ts`, generalized independently across trace, metric,
and log providers so the owned Pi extension can coexist with a foreign SDK.

No source code was copied or modified from `pi-otel-telemetry`. Its implementation's signal scope, data model, and
reload mechanics were not adopted. This repository retains its existing Pi GenAI span tree, constructs its own scoped
providers/exporters, explicitly preserves shell trace context, separates metric resources for cardinality control, and
records exporter delivery health.

## Internal npm release packaging

- Source: `teamupstart/umt`, <https://github.com/teamupstart/umt>, `internal/artifacts/roles.go` and
  `internal/artifacts/dotfile/npm.go` at revision `139ea84b36fd550fb29ba91649975d39e3734817`; license not established
  from the reviewed files.
- Source: Upstart CodeArtifact guide, <https://upstartnetwork.atlassian.net/wiki/spaces/DEL/pages/6780387430>.
- Source: Pi package documentation,
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>, MIT.

Conceptual use only: the manual release instructions use UMT's production CodeArtifact domain/repository, publish SSO
role, and full-path npm token scoping. The Pi manifest and peer-dependency design follow Pi's package documentation. No
UMT or Pi code was copied into the release scripts; UMT's automatic dotfile/profile changes and CI publishing action
were intentionally not adopted. The router/OTel runtime companions share a package, while independent extensions and the
standalone patch are separate packages. The OTel source is redistributed with its Apache-2.0 license intact.

## `zew1me/pi-buildout` (upstream of this fork)

- Source: `zew1me/pi-buildout`
- Canonical repository: <https://github.com/zew1me/pi-buildout>
- Revision last selectively synced: `7965f313e6c2219a9e88310e202c6f97e0b2d431` (2026-11-11)
- Sync dispositions and intentional deferrals: [`UPSTREAM_SYNC.md`](UPSTREAM_SYNC.md#2026-11-12-selective-sync-7965f313)
- License declared by the source: MIT (© 2026 Nigel Stuke)

This repository is a fork of `zew1me/pi-buildout`. Upstream changes are ported by cherry-picking commits rather than by
merging, so each ported commit records its upstream SHA in a `(cherry picked from commit …)` trailer, and
[`UPSTREAM_SYNC.md`](UPSTREAM_SYNC.md) records the last synced revision and the status of each upstream commit.

What was adopted, as copied code: the pi 0.84.4 and 0.85.1 `/skills` patch sets under `patches/` (the 0.84.4 set, like
0.84.2's, was later removed at `867d931e`), including the recognized-state upgrade manifests for installs patched by
this repository's earlier 0.85.1 patch; the package and settings skill catalog for the pi 0.84.2 patch; the
manifest-driven patch file set, recognized-state upgrade path, Homebrew package lookup, and legacy top-level entrypoint
cleanup in `scripts/install-extensions.sh`; and the tests that cover them (`scripts/skills-catalog.test.mjs`,
`scripts/skills-patch-entrypoint.test.mjs`, `scripts/install-extensions.test.mjs`). The sync at `502c13a0` adds, as
copied code, the `pi-overlay/` TypeScript source for the 0.85.1 `/skills` patch, the `scripts/build-pi-patch.mjs`
generation pipeline and its tests, and the `patch-drift` CI workflow. The sync at `867d931e` adds, as copied code, the
serialized persisted-skill updates, bare-name and relative-path normalization, the `pre-lock` 0.85.1 upgrade manifest,
and their tests; it also removes the pi 0.84.2 and 0.84.4 patch sets, as upstream does. This fork regenerates the 0.85.1
artifacts from its own overlay, which keeps the fork's `commandNeedsProjectTrust` change, and applies the same overlay
change to its fork-only 0.87.1 patch.

What was intentionally not adopted: upstream's removal of the router and vendored OpenTelemetry extensions from the
installer and documentation; upstream's dependency overrides and scripts where this fork carries its own; and upstream's
subagent fallback effort handling, where this fork keeps its own explicit model and effort resolution. From `867d931e`,
the fork did not adopt upstream's regenerated 0.85.1 artifact bytes, which its overlay does not reproduce, or its
single-version catalog-test layout with hard-coded `pre-validation-` and `pre-lock-` blocks; the fork's test keeps its
per-version loop and upgrades every recorded state.

The upstream pi 0.84.4 and 0.85.1 development package bumps were held back from the sync at `bc127ebf` because the
router's cost tests pin the model registry. Issue #64 later matched upstream's 0.85.1 versions after a separate router
evidence review; only the version numbers are shared with upstream.

### Shell-free patch application regressions (`c541ff594`)

Copied regression tests from MIT-licensed `zew1me/pi-buildout`, <https://github.com/zew1me/pi-buildout>, revision
`c541ff5945fba2facf7946a979c36ac620493d72`, in `scripts/build-pi-patch.test.mjs`. The fork already applies patch data
through stdin with argument arrays; two existing verification helpers are exported for tests covering hostile directory
names, literal patch contents, forward/reverse failures, missing inputs, and migration round trips. Upstream's older
generation pipeline and single-version artifact tests were not substituted for this fork's generation checks.

### Managed-install discovery (`f594d8305`)

Modified code and copied regression tests from MIT-licensed `zew1me/pi-buildout`,
<https://github.com/zew1me/pi-buildout>, revision `f594d83056dc61913145833f0e5a2ff395586925`:
`scripts/install-extensions.sh` positively recognizes managed launchers or metadata, verifies the pointer against the
active package version, and fails closed when a recognized install is broken. `scripts/install-discovery.test.mjs`
covers managed layouts, unrelated sibling installs, exact package identity, Homebrew, and shim fallback. Existing
fixture launchers now identify themselves explicitly. Unlike upstream, extension-only installation still discovers Pi
and checks the fork's router host-version floor; upstream's discovery bypass was intentionally not adopted.

### Legacy ownership regression coverage (`c5cb5cb44`)

Adapted copied tests from MIT-licensed `zew1me/pi-buildout`, <https://github.com/zew1me/pi-buildout>, revision
`c5cb5cb446f2666d5c9d4892abcf1c24c0bc1a5a`. `scripts/install-ownership.test.mjs` checks unknown legacy files, symlinks,
directories, and ownership changes during extension replacement. The fork already implements preflight and deletion-time
ownership checks; the tests retain its Pi discovery requirement, router installation, and optional OTel packaging.
Upstream's extension-only discovery bypass and installer replacement were not adopted.

### Compatible release-safety port (`dabb54b1d`, npm publication #79)

- Source: `zew1me/pi-buildout`, <https://github.com/zew1me/pi-buildout>
- Revision reviewed: `dabb54b1d753ffb60f5fe36da48828bb77a08028`
- Declared license: MIT (© 2026 Nigel Stuke); the root `LICENSE` retains its copyright and permission notice.

Copied and modified code, not conceptual inspiration alone: `scripts/release-packages.mjs` adapts upstream's strict
release-manifest/version validation, explicit lifecycle-script enabling for packing, SHA-512 archive integrity helpers,
release receipts, and validation of every selected archive before publication. The guard in
`scripts/check-release-registry.mjs` shares this fork's selected-package identity and alpha-only validation. The port
retains manual `--package` selection, explicit `--publish` approval, `@upstart` identities, and the fixed internal
CodeArtifact endpoint. Tarball publication adds explicit CLI policy checks and embedded-manifest validation because npm
cannot be relied on to execute the checkout's `prepublishOnly` hook for a tarball. Receipts bind the packed bytes within
one publish invocation; earlier dry runs remain previews, not persistent approvals.

`scripts/release-package.test.mjs` and `scripts/release-publish.test.mjs` adapt upstream's extracted consumer-archive,
minimal-payload, import-closure, Pi-loader, and modified-archive regression-test patterns. The fork extends coverage to
all six packages, including the combined router/OTel package, vendored Apache notices, NodeNext `.js` imports resolving
to shipped `.ts` sources, isolated disposable checkouts, and equivalent CLI/lifecycle guards. Pi's MIT-licensed SDK,
extension, and package documentation and SDK extension example from `@earendil-works/pi-coding-agent@1.5.2`
(<https://github.com/earendil-works/pi>) were reviewed for loader behavior and host-provided dependencies; no Pi loader
or SDK implementation code was copied.

Intentionally not adopted: public npm publishing, public-access metadata, trusted-publishing/OIDC or provenance CI,
automatic main-branch releases, Git-base/version-bump release selection, stable/beta/rc channels, or recursive staging
of router evaluation/test trees. Registry version preflight, conflict reconciliation, identical-version recovery, and
backward-dist-tag network policy are deferred rather than imported into this manual CodeArtifact workflow. Consumer
setup, human checkpoints, and independent package versions remain unchanged; `packages/README.md` documents the local
archive safeguards and temporary receipt lifecycle.

## Pi 1.1.0 supported-install discovery and registry refresh

- Source: [Pi installer](https://pi.dev/install.sh) and `@earendil-works/pi-coding-agent@1.1.0` /
  `@earendil-works/pi-ai@1.1.0`
- Canonical repository: <https://github.com/earendil-works/pi>
- Package revision reviewed: `abe508e1b89912adde45528136c3221eb69acdd7` (`v1.1.0`); installer fetched 2026-10-08
- Declared package license: MIT; the fetched standalone installer does not declare a separate license

Conceptual use: `scripts/install-extensions.sh` independently follows the managed launcher's `install/current-version`
and `install/releases/<version>/node_modules/@earendil-works/pi-coding-agent` layout. The layout was checked against Pi
1.1.0's published `dist/package-manager-cli.js`. Package identity and the minimum supported version are checked before
installation. No installer code was copied; Pi's downloads, installation, self-update, release retention, runtime
marker, and shell-profile machinery were not adopted.

The router registry tests use the published 1.1.0 catalog's Azure Sol absence and existing cache-write rates as
observations, without copying generated registry code or changing routing policy. The entrypoint test's five-line
compile-cache loader is adapted from Pi 1.1.0's MIT-licensed `dist/bundle/cli.js` and verified byte-for-byte against its
baseline checksum; the runtime and RPC behavior exercised comes from this repository's existing wrappers. Pre-1.0.1
patch artifacts and overlays were removed; historical attribution above remains for shared ideas and code.

## XState v5 and fast-check (router lease ownership and race testing)

- XState: <https://github.com/statelyai/xstate>, npm `xstate@5.33.2`, MIT; reviewed the installed package's declarations
  and [actor](https://stately.ai/docs/actors) / [invocation](https://stately.ai/docs/invoke) documentation on
  2026-10-07. Consumed as an ordinary runtime dependency, with no upstream source copied or modified.
- fast-check: <https://github.com/dubzzz/fast-check>, npm `fast-check@4.10.2`, MIT; reviewed installed scheduler/model
  runner declarations and [race testing documentation](https://fast-check.dev/docs/advanced/race-conditions/) on
  2026-10-07. Consumed as a development dependency, with no upstream source copied or modified.

Conceptual use: XState's synchronous actor transitions, guarded statecharts, and cancellable promise children provide
one builder lease owner and a secondary classifier scoped to that task. fast-check generates state-transition sequences
and adversarial schedules for actual router handlers and their ledger/model waits. The machine, adapter integration, and
properties are original code. We did not adopt XState's persisted snapshot format, v6 alpha APIs, a global asynchronous
handler queue, or make the telemetry ledger a state source. We did not copy fast-check examples or its implementation;
the existing Node test runner remains in place.

## Upstream RPC integration test hardening and fixture isolation

- Source: `zew1me/pi-buildout` commit `cd2ea61a5c73ee266821cfd292b36faca3b55a49` (`#85`)
- Canonical repository: <https://github.com/zew1me/pi-buildout>
- License: MIT (© 2026 Nigel Stuke)

The RPC integration test in `extensions/subagents/rpc.integration.test.mjs` was enhanced with test-hardening
improvements ported from upstream. Changes include pinned Pi version assertion (respecting the canary
`PI_TEST_PACKAGE_ENTRY` override), early cleanup registration before resource acquisition, timeout and abort-signal
awareness in the `waitFor` polling function, explicit server connection cleanup with `closeAllConnections()`, and
expanded test options for longer timeouts. Both the main RPC protocol test and the isolation regression test receive
these robustness improvements. The real-RPC integration test exercises the documented RPC patterns against the pinned Pi
CLI with a test-only provider registered through `ExtensionAPI.registerProvider` and a deterministic loopback streaming
endpoint; no Pi provider or RPC client code was copied. The isolation test fixture with ambient extension/context
loading, control, and isolated verification remains original code.

The port retains the fork's `isolatedChildArgs`/auth-bridge launch path in both protocol and isolation coverage; Pi's
pinned runtime is asserted unless the contract canary supplies an explicit package override.

## Upstream `/skills` path expansion and portable persistence

- Source: `zew1me/pi-buildout`, <https://github.com/zew1me/pi-buildout>
- Revisions reviewed: `c543eeaa071c973b09bfaed19c012a06b804a9b2` (`#74`) and `59d2979a0a7832e435c8a5db7a3dd35067244610`
  (`#78`)
- Declared license: MIT (© 2026 Nigel Stuke); the repository's MIT license notice is retained.

Copied and adapted code, not conceptual inspiration alone: the shared skill-management overlay and focused tests now
expand `$NAME`/`${NAME}` path references, preserve portable configuration spellings for load-time expansion, persist
checkout-local repository paths relative to the checkout root, match equivalent real paths, and diagnose unresolved
variables and legacy relative entries. The upstream skill guidance, documentation seam, and catalog regression fixtures
were adapted to this fork's per-version test loop. The second revision supplies the Pi 1.3.0 documentation/migration
pattern; its Git-hook environment isolation was already implemented locally.

This fork preserves `commandNeedsProjectTrust`, catalog precedence, serialized configuration updates, and the local
Windows/path-identity regressions. It generates all artifacts and recognized `pre-expansion` migrations from this fork's
actual shipped trees for Pi 1.0.3, 1.0.4, 1.1.0, 1.3.0, 1.4.0, 1.5.0, and 1.5.2. Upstream's generated patch bytes and
old-state checksums were intentionally not copied, because they omit the fork's trust changes. No retired version,
dependency baseline change, installer policy change, or unrelated upstream feature was adopted in this behavior port.

Verification covers every retained version: clean-source builds reproduce the published baseline, regeneration reports
no artifact drift, all seven `pre-expansion` migrations round-trip to their exact shipped checksums, and the runtime
catalog/dispatch suites exercise recognized-state upgrades, variable expansion on reload, unset-variable diagnostics,
equivalent-path removal, cross-clone repository paths, catalog trust/precedence, saved distrust, and path aliases. The
shared core additionally checks portable versus `$PWD`/`$OLDPWD` persistence, literal dollar paths, session mutations,
and the retained Windows path regressions. Baselines and CLI/RPC wrappers are unchanged; the upstream seam stays at 48
edited runtime lines per version.

Review hardening is original fork code: checkout-relative activation now requires that checkout's project-trust
decision, resolved command targets are not expanded a second time, and Windows home-relative paths follow Pi's native
separator semantics. The latter behavior was checked against MIT-licensed Pi 1.5.2 `dist/utils/paths.js` at the already
recorded `b4afdddf44e059c67ccf5097e5317d913521b470` release, <https://github.com/earendil-works/pi>; no Pi path-helper
code was copied. CLI examples quote variable paths so shells preserve their portable spelling.
