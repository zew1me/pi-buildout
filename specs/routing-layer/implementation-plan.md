# Routing layer — implementation plan

Status: **implemented and real-provider evaluated**. Deferred circuit-breaker and workflow-specific horizon work is
tracked in [`future-work.md`](future-work.md).

This is the execution plan for [`SPEC.md`](SPEC.md). It incorporates useful deltas from the external implementation plan
while treating that file as untrusted reference material and ignoring its Python implementation.

## Reconciliation completed before coding

The external plan contained four material updates that were missing from the local spec and have now been adopted:

1. Ordinary routes have exactly a primary and fallback; there is no availability-only third model.
2. Review is sequential across both non-builder model vendors, with the existing builder as a fixed final fallback when
   independence cannot be obtained. This is not a parallel review panel.
3. High-risk implementation requires review, deterministic verification outranks LLM judgment, and model IDs/profile
   compatibility are hard eligibility filters.
4. Multi-PR planning and implementation are separate attempts and leases with separate telemetry.

Concrete external model assignments remain bootstrap hints only. Policy v2 resolves exact IDs against pi's live
`ModelRegistry`, including the explicitly configured Bifrost Bedrock Sonnet availability endpoint, and rejects
unvalidated combinations.

## Delivery slices

Each slice is independently testable and should be committed before moving on.

### 0. Repository guardrails

- Install Lefthook pre-commit/pre-push hooks.
- Enforce staged-file size, secret, merge-marker, structured-data, whitespace, Prettier, ESLint, TypeScript, and test
  checks.
- Pin dependencies and audit them.

Exit: `npm run check`, `npm audit`, and both installed hooks pass.

### 1. Deterministic contracts and policy

- TypeBox semantic feature schema and fail-closed conservative feature object.
- Archetype derivation and provider-neutral effort selection.
- Exact-ID policy/model snapshot types, canonical vendor mapping, profile compatibility.
- 70% finished-context eligibility, ordinary and review topology validation.
- Bootstrap ordering plus telemetry-maturity gate for robust cost-to-done ranking.

Exit: synthetic features produce an explainable valid route without an LLM.

### 2. Synopsis, lease, and compiler

- Bounded deterministic session synopsis from active-branch entries and tool/model/repository metadata; never copy raw
  session/tool output wholesale.
- User-turn-only task-boundary state machine, hard boundaries, cache resistance, continuity signals, child leases,
  effort-only transitions, and manual override.
- Versioned OpenAI/Anthropic/Google prompt profiles and provider-aware compiler with verbatim-request preservation and
  explicit trusted/untrusted sections.

Exit: invariant unit tests and compiler golden tests pass.

### 3. Classification and adapter MVP

- Primary `complete()` call with one schema tool; validate the tool call.
- Different-vendor secondary classification for low-confidence/high-risk cases; conservative reconciliation; malformed
  output routes conservatively.
- Wire pi lifecycle hooks, apply model/effort only in active mode, inject profile scaffolding, persist lease snapshots,
  and expose `/route` status/mode/outcome controls.
- Start in shadow mode; a manual mode switch is required before decisions act.

Exit: install into a disposable `PI_AGENT_DIR`, load with pi, and observe a shadow route.

Adapter UX follow-up (completed): return from the `input` hook before repository I/O/telemetry so the native user
message appears immediately, and show pi's animated working indicator with `Routing...` while the deferred boundary,
classification, and route work runs.

### 4. Fallback, review topology, and telemetry

- Sequential fallback controller with reason codes and parent-lease restoration.
- Two non-builder review candidates plus fixed builder fallback.
- Append-only JSONL audit/attempt events; in-memory p50/p75/p90 and mature-route samples.
- Optional parented OTel spans through `pi-telemetry-otel` Symbol registries.

Exit: every decision has policy/model/profile/classifier/exclusion/score data and fallback invariants are covered by
tests.

### 5. Evaluation and rollout gates

- Golden corpus with at least one fixture per archetype plus boundary/escalation cases.
- Offline deterministic route/profile regressions on every normal test run.
- Real classifier/profile paired-treatment eval runner through explicit Bifrost configuration; cleanly skip only when
  credentials are absent.
- Shadow live test, then active canary test on a low-risk prompt. Keep active routing opt-in until classifier validity
  and route quality gates have evidence.

Exit: no hard-policy violations, deterministic corpus and explicit real-provider eval pass, and installation/live-load
smoke tests pass.

## Definition of done

- Public pi hooks only; no runtime patch.
- All SPEC hard invariants have direct tests.
- Unknown/unavailable/unprofiled models cannot be selected.
- The extension defaults to safe shadow mode and manual model/effort overrides win.
- Installer copies every router source/config file atomically and verifies runtime loading.
- `npm run check`, install smoke, deterministic evals, and Lefthook pre-push pass.

## Verification record

- 88 deterministic/unit/adapter/installer checks pass; ordinary checks explicitly skip provider calls even when local
  credentials exist.
- `npm audit --audit-level=high --registry=https://registry.npmjs.org/` reports zero vulnerabilities.
- Shadow and active live pi canaries passed, including actual-vs-proposed telemetry attribution and an active route from
  `gpt-5.5/medium` to `gpt-5.6-terra/medium`. After the final reinstall, the installed/source router entrypoint hashes
  matched and another isolated shadow canary completed with seven audit events.
- A live planning task routed to `anthropic/claude-opus-4-8` at high effort, called `submit_implementation_plan`, passed
  deterministic DAG validation, and made no file changes.
- The full Bifrost suite passed: classifier axis accuracy 0.8167, archetype accuracy 0.8182, zero
  review-intent/hard-policy violations, and 11/11 paired profile treatments accepted. See
  [`eval-results-2026-07-17.md`](eval-results-2026-07-17.md).
