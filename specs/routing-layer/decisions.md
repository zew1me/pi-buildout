# Routing layer — architecture decisions

Companion to [`SPEC.md`](SPEC.md) (the functional spec), [`eval.md`](eval.md) (the evaluation harness), and
[`source-basis.md`](source-basis.md) (design provenance and public references). This document records _how_ it will be
built and why — language, framework, tooling — plus the implementation-time findings that resolve the original open
items. The extension is implemented and remains in its intended shadow-first rollout.

## Decision: TypeScript, in-process, as a pi extension

The workload is **LLM-I/O-bound**, not compute-bound: the deterministic core (eligibility filter, ranking, lease state
machine, prompt compiler) runs once per task boundary over kilobytes of data — microseconds to low milliseconds of work
— while every classifier call and model turn is a multi-second network round trip. A faster core language buys
effectively zero wall-clock; there is no hot loop to justify one.

What _is_ recurring cost is the **per-turn integration boundary**: the router is consulted on every user turn. Running
the discarded historical Python prototype out-of-process as a sidecar would mean IPC plus full harness-state
serialization (session, tokens, tool inventory, builder identity, cache stats) on every turn. Running in-process in pi's
own runtime avoids that entirely.

pi's `ExtensionAPI` (`@earendil-works/pi-coding-agent`, verified against v0.80.7's `dist/core/extensions/types.d.ts`)
already exposes every hook this spec's pipeline needs:

| Spec requirement                                         | pi `ExtensionAPI` primitive                               |
| -------------------------------------------------------- | --------------------------------------------------------- |
| Only a user-input turn triggers boundary evaluation      | `on("input", …)`                                          |
| Hard boundaries: new window / post-compaction / subagent | `session_start`, `session_compact`, `session_before_fork` |
| Estimated token counts & context-window feasibility      | `ctx.getContextUsage()` plus provider-reported usage      |
| Model eligibility, context window, cost, API keys        | `ctx.modelRegistry` / `ModelRegistry`                     |
| Builder identity (for independent review routing)        | `ctx.model`                                               |
| Apply the lease (model + effort)                         | `setModel(model)`, `setThinkingLevel(level)`              |
| Inject the compiled model-specific prompt profile        | `before_agent_start` → `systemPrompt` result              |
| Resolve exact policy IDs against live endpoints          | `ctx.modelRegistry.getAll()` / `.getAvailable()`          |
| Persist/reevaluate the lease across turns                | `appendEntry` + re-check on `input`                       |

The existing extensions in this repo (`extensions/{clear,effort,markdown-backlinks}`, each `index.ts` + `helpers.ts` +
`index.test.mjs`) already demonstrate the shape this layer should take.

**The prose functional spec (`SPEC.md`) is the implementation authority — not the historical Python prototype described
in `source-basis.md`.** That prototype was untested and untrialed; its output shapes, schemas, and behavior were not
imported. Tests are authored directly from `SPEC.md`'s invariants and the checked-in TypeScript contracts.

## Why not an agent framework

Not LangChain, CrewAI, LangGraph, or the Anthropic/OpenAI Agents SDKs. What we're building is a **router** — a
classifier plus a deterministic decision engine plus a prompt compiler — not an agent: there is no agentic loop, tool
orchestration, or multi-agent coordination to own, because pi already is the agent and owns the loop. Dropping an agent
framework in would fight the in-process integration described above and add a heavy abstraction around what is, on the
LLM side, a single low-temperature structured-output classification call. The repository therefore uses no agent
framework.

## Dependency set

pi's bundled packages already cover nearly the entire runtime surface. Reuse them; do not add equivalents:

| Need                         | Reuse (already available)                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schema/validation            | **TypeBox** through its canonical `typebox` / `typebox/value` exports. Not Zod — TypeBox is a first-class pi dependency and matches pi's own `ToolDefinition` model.                                         |
| Structured classifier output | forced **tool call** with TypeBox parameters, validated via pi-ai's `validateToolCall`/`validateToolArguments` (+ `parseJsonWithRepair` for recovery). There is no `response_format`-style enforcement path. |
| One-shot LLM call            | pi-ai's public `complete()` compatibility export, with registry-resolved auth (verified live).                                                                                                               |
| Provider access              | **[Bifrost](https://github.com/maximhq/bifrost)** where configured — see the Provider access section below.                                                                                                  |
| Token/context sizing         | `ctx.getContextUsage()` + pi-ai's `estimateContextTokens`/`calculateCost` helpers. No tiktoken — pi has no real tokenizer, and estimation is the norm here.                                                  |
| Eligibility/ranking inputs   | `ctx.modelRegistry.getAvailable()`/`.find()`, `Model.{cost,contextWindow,maxTokens,reasoning}`, pi-ai's `calculateCost()`.                                                                                   |
| Lease/state persistence      | `pi.appendEntry()` (per-session custom entries) + `getAgentDir()`.                                                                                                                                           |
| Telemetry store              | append-only **JSONL** (pi's own `JsonlSessionStorage` idiom) — not sqlite; nothing in pi's dependency tree uses sqlite.                                                                                      |
| OTel spans                   | Optional **`pi-telemetry-otel`** Symbol registries — see the Telemetry section below.                                                                                                                        |

There are **no new extension runtime dependencies**. `pi-telemetry-otel` remains a separately installed companion: the
router consumes its global Symbol registries when present and no-ops when absent. Everything else above is exported by
pi's bundled packages. This removes extension-local `node_modules` installation without reducing schema validation,
inference, or tracing behavior.

## Framework

No web framework — this is a library plus a thin pi-extension adapter, not a service.

- **Integration surface:** `@earendil-works/pi-coding-agent`'s `ExtensionAPI`.
- **UI:** `@earendil-works/pi-tui`, for a `/route` status command modeled on the existing `extensions/effort`.
- **Classifier / continuity LLM calls:** `ExtensionAPI` itself has no one-shot inference method, but pi v0.80.7 exports
  `complete()` from `@earendil-works/pi-ai/compat`; pi's own `qna.ts` and `custom-compaction.ts` examples call it from
  extensions using a model plus `ctx.modelRegistry.getApiKeyAndHeaders()`. Use that proven path. The classifier exposes
  a tiny transport interface for deterministic tests, but production always uses `complete()` with one TypeBox schema
  tool, low temperature where supported, and validated tool arguments.
- **Provider access — registry-resolved, with Bifrost preferred where configured.** Production calls use the selected
  model's `baseUrl` and `ModelRegistry`-resolved auth. Deployments exposing models through Bifrost configure credentials
  in environment/settings and never hardcode them. Local pi installations may use an already-configured direct or OAuth
  endpoint. The eval harness is stricter: real eval calls require explicit `BIFROST_BASE_URL` and `BIFROST_VIRTUAL_KEY`
  so an evaluation cannot silently hit another endpoint.
- **Deterministic core** (eligibility, ranking, lease, compiler): a standalone TS module tree with **zero pi imports**,
  so it stays unit-testable in isolation and portable if the router is ever needed outside pi.

## Tooling

- **Runtime:** Node.js / ESM, matching pi's own `"type": "module"`. pi loads `.ts` extensions directly — no build step
  for the extension itself.
- **Tests:** `node --test` over `*.test.mjs`, matching this repo's existing convention.
- **Schema/validation:** **TypeBox**, reused from pi's dependency tree through its canonical `typebox` / `typebox/value`
  exports — not Zod. One definition yields runtime validation (fail closed on malformed classifier output), static TS
  types, and the schema used for the required classifier tool call. No separate extension-local install is needed.
- **Telemetry — local JSONL store, plus OTel spans via `pi-telemetry-otel`:**
  - pi itself has **no OpenTelemetry plumbing to build on**. Its only telemetry is an install-ping toggle
    (`isInstallTelemetryEnabled`, gated by env `PI_TELEMETRY`); it reads no `OTEL_*` environment variables and
    instruments no spans, metrics, or logs itself. (Verified against pi v0.80.7's `dist/core/telemetry.d.ts` and its
    dependency tree — `@opentelemetry/api` is present only as a transitive dependency of an unrelated package, not one
    pi itself uses.)
  - There is, however, a dedicated companion extension for this:
    **[`pi-telemetry-otel`](https://www.npmjs.com/package/pi-telemetry-otel)** (`pi install npm:pi-telemetry-otel`,
    v0.1.1). It emits OpenTelemetry spans for pi's own session/ agent/turn/tool lifecycle to an OTLP/HTTP collector, and
    — the behavior we specifically want to fit to — its helper **automatically parents new spans under pi's
    currently-active span**, so our routing-decision spans nest into the live session/agent/turn trace rather than
    starting a disconnected trace. It honors the standard `OTEL_EXPORTER_OTLP_ENDPOINT`/`_HEADERS`, `OTEL_SERVICE_NAME`,
    `OTEL_RESOURCE_ATTRIBUTES` env vars (plus `PI_AGENT_TRACE_ID`/ `PI_AGENT_SPAN_ID` for subprocess linking), so it
    composes with a standard OTLP collector without router-specific exporter configuration.
  - **One resolution-decoupled integration path:** `pi-telemetry-otel` exposes
    `Symbol.for("pi.telemetry-otel.runtimeRegistry.v1")` (tracer/export pipeline) and
    `Symbol.for("pi.telemetry-otel.activeSpanContextRegistry.v1")` (active span context), keyed by
    `ctx.sessionManager.getSessionId()`. This needs no static import or copied dependency. A static `withPiSpan` import
    adds a second integration path with no additional capability, so it is intentionally omitted.
  - **Local JSONL remains the source of truth regardless of OTel configuration:** the spec's telemetry-promoted cost
    ranking requires the router to read its own history back in-process, and an OTel export is fire-and-forget to an
    external backend — it cannot be queried back for that purpose. No sqlite: nothing in pi's dependency tree uses it,
    and the retained history is small enough (one row per task boundary) that in-memory percentile computation over
    JSONL is sufficient.
  - Signal mapping: one **span** per routing decision (route key, archetype, model, effort, provider, confidence,
    boundary type, cache estimate), with child spans around each classifier LLM call (where the latency actually lives —
    this workload is I/O-bound, not compute-bound); span events for the audit ledger (every boundary signal, exclusion,
    score, fallback).
- **Lint/format:** use the repository-wide Prettier formatter and ESLint rules. Biome was removed after the repository
  adopted this toolchain so formatting and linting have one authority each.
- **Packaging:** install via the existing `scripts/install-extensions.sh`; `/reload` after reinstalling. Use the repo's
  `patches/` snapshot mechanism only if some required hook turns out not to be reachable through the public
  `ExtensionAPI` — unlikely, per the table above.

## Implemented directory layout

```text
extensions/router/
  core/                 # pure TS, zero pi imports — unit-testable, portable
    features.ts         # TypeBox semantic-feature schema
    synopsis.ts         # deterministic bounded context synopsis
    archetype.ts        # feature object -> route key
    routing.ts          # eligibility, headroom, review selection, and mature ranking
    fallback.ts         # bounded ordinary/review fallback state machines
    lease.ts            # task lease and boundary gate
    planning.ts         # typed PR-DAG validation
    profiles.ts         # versioned model-specific prompt profiles
    compiler.ts         # provider-aware prompt compiler
  eval/                 # offline corpus and explicit-Bifrost real-call suites
  classifier.ts         # semantic classification and conservative reconciliation
  pi-classifier.ts      # pi registry/auth transport via pi-ai complete()
  pi-state.ts           # persisted-state validation and pi metadata adapters
  telemetry.ts          # JSONL aggregates plus optional parented OTel spans
  index.ts              # pi lifecycle adapter, tools, and /route command
```

## Build sequence (completed)

1. `core/` first, with no pi imports — the deterministic spine, unit-tested directly against `SPEC.md`'s invariants.
2. `classifier.ts` — primary + provider-diverse secondary structured-output calls via pi-ai's `complete()` and
   registry-resolved auth; conservative reconciliation; fail-closed fallback route.
3. `index.ts` — the pi adapter: wire `input`/session boundary events to lease decisions; apply via
   `setModel`/`setThinkingLevel`; inject the compiled profile via `before_agent_start.systemPrompt`; map bootstrap
   aliases via `registerProvider`; add the `/route` status command.
4. `telemetry.ts` — local JSONL store (router reads this back in-process for ranking), plus `pi-telemetry-otel` spans
   via the Symbol-registry (falling back to no-op if that package isn't present/configured).
5. Ship in **shadow mode** first (log decisions without acting on them), per `SPEC.md`'s implementation sequence.

## Deferred follow-up: evidence-aware synopsis compaction

The synopsis keeps bounded, newest-first items and now removes excess recent outcomes, goals, and prior decisions in
round-robin order while retaining one item from each category. This is the appropriate deterministic policy today: it
prevents one category from being exhausted first without pretending that recency alone measures semantic value.

A priority queue or A* search is deliberately deferred. Neither has a trustworthy per-entry utility function yet, and
searching candidate summaries would add cost and nondeterminism without evidence of better routing or agent outcomes. A
future implementation must retain entry provenance and task linkage, evaluate progressive compaction candidates against
a fixed corpus (classifier/continuity agreement, downstream task success, and token cost), and promote a utility-scored
semantic summary only if it outperforms the deterministic round-robin baseline.

## Implementation-time findings (resolved)

1. **Classifier entrypoint:** use `complete()` from `@earendil-works/pi-ai/compat` with `ModelRegistry`-resolved auth.
   This is the same supported extension pattern used by pi's bundled examples; no private `Models` handle or direct
   provider SDK is needed.
2. **Telemetry resolution:** use the companion extension's Symbol registries only. This preserves parented spans when
   installed and deterministic no-op behavior otherwise, without another module root or runtime install step.
3. **Provider endpoint:** production classification uses the endpoint already resolved on the chosen pi model. A
   Bifrost-configured model therefore uses Bifrost; direct-provider configurations keep working. The real-call eval
   runner requires explicit `BIFROST_*` configuration and never silently changes endpoints.
4. **Concrete registry mapping:** policy v2 uses exact IDs present in pi v0.80.7's live registry
   (`gpt-5.6-{luna,terra,sol}`, `claude-{haiku-4-5,sonnet-5,opus-4-8,fable-5}`, `gemini-3.5-flash`) plus the configured
   `bifrost/bedrock/anthropic.claude-sonnet-5` endpoint as a Sonnet 5 availability alternative. These have version-aware
   profile families and deterministic lower-tier fallback resolution when a preferred exact ID is unavailable. Bifrost
   evaluation found its advertised Vertex 3.5 route unavailable in-region, so policy also lists exact
   `google-vertex/gemini-2.5-flash` behind 3.5 with a separate generation-specific profile.
