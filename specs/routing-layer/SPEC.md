# Model-aware routing layer for pi — specification

Status: **implemented (shadow-first rollout)**. The TypeScript extension is in
[`extensions/router`](../../extensions/router), defaults to shadow mode, and has passed deterministic, installer,
shadow, active-canary, and full explicit-Bifrost checks. See [`decisions.md`](decisions.md),
[`implementation-decisions.md`](implementation-decisions.md), [`eval.md`](eval.md), and the
[2026-07-17 real-provider results](eval-results-2026-07-17.md).

## Context

pi (`@earendil-works/pi-coding-agent`) currently selects a model/effort level manually (via `/effort` and model
pickers). This spec adds a routing layer that classifies each new task, selects a model and effort, and compiles a
model-specific prompt profile — automatically, deterministically where possible, and leased per task rather than
re-decided every turn.

## Core decision the router makes

For each new task, decide:

1. **Prompt archetype** — from the immediate user prompt plus a bounded, deterministically-built synopsis of the active
   session (not the raw session).
2. **Model and effort** — ordinary routes get exactly one primary and one required fallback. Explicit review routes get
   one candidate from each non-builder model vendor (OpenAI, Anthropic, or Google), followed by the existing builder
   model as a fixed loss-of-independence fallback only if both independent attempts fail.
3. **Model-specific prompt profile** — a validated, versioned profile compiled into the final request without altering
   the user's intent.

Model selection is **per task, not per turn**. The chosen model and prompt profile are held in a **task lease** until a
valid boundary. Effort may change between turns within a lease without ending it.

## Task boundaries

The router may only reevaluate at a **user-input turn**. Hard boundaries (always reevaluate):

- a new session/window;
- the first user turn after context compaction;
- the first user turn after a remote push;
- a user-authorized subagent execution (which gets its own child lease).

At any other user turn, combine deterministic intent/state signals with expected cache value; escalate to a secondary
"continuity" classification only when those signals are inconclusive. Significant reusable cache (a default of ≥20,000
cached tokens with ≥50% expected reuse) should resist a marginal switch; very strong semantic discontinuity can still
override it. Do not reevaluate the lease at any non-user turn.

## Classification pipeline

```text
raw prompt
  + deterministic session synopsis
  + repository/tool metadata
        |
        v
user-turn task-boundary gate
        |
        +-- continuation --> existing model/profile lease; effort may vary
        |
        +-- new task --> fast semantic classifier
        |
        +-- high confidence --> validated feature object
        |
        +-- low confidence / high risk --> secondary classifier (different provider)
                                                |
                                                v
                                  deterministic reconciliation
                                                |
                                                v
                                 eligibility + scoring engine
                                                |
                                                v
                                model + effort + prompt profile
                                                |
                                                v
                                  deterministic prompt compiler
```

The classifier returns **semantic features only, never a model name**. A deterministic layer then: selects the
archetype; filters eligible models; ranks the ordinary primary/fallback or the review sequence; enforces every ordinary
fallback is OpenAI or Anthropic; selects a validated prompt profile; compiles the final request.

### Feature schema (required axes)

Intent (answer/research/plan/implement/review/diagnose/operate/summarize/transform/continue), action mode
(information-only … external side effect), instruction style, task horizon (one response … 2–10 PRs … 11–100/unknown
program), tool dependence, context shape, output rigidity, independence requirement (none / different-provider review),
task continuity class, and cache value estimate — plus risk, ambiguity, confidence, and a short evidence list. See the
reference feature object in the external spec for the concrete JSON shape.

The classifier does not have a `response_format`-style structured-output knob available to it (see `decisions.md`).
Enforce the schema by forcing a **tool call** whose parameters are the TypeBox schema, and validate the returned
arguments — never accept free-form JSON parsed out of prose.

### Confidence and escalation

- High confidence (≥0.80 as a starting threshold) and non-high risk → use the primary classifier's output directly.
- Low confidence or high/critical risk → call a secondary classifier from a **different provider**; reconcile
  conservatively (max of risk/horizon, union of review intent, prefer the second archetype when the first is
  low-confidence or the second finds higher risk).
- Malformed classifier output fails closed to a conservative route, never to an unvalidated one.

## Eligibility, ranking, and fallback

Deterministic, not LLM-assisted:

- Current token count and a bounded estimate of finished-context size. pi has no true tokenizer; "current token count"
  is pi's own estimate (`ctx.getContextUsage()` / `estimateContextTokens`) reconciled against provider-reported `Usage`
  from the most recent turn — treat it as a close estimate, not an exact count, and size headroom decisions accordingly.
- Endpoint availability and capability checks.
- 70% context-headroom filtering (reject candidates that would exceed 70% of their context window for the estimated
  finished size).
- Prompt-profile compatibility (a model without a validated profile for the archetype/effort is not eligible).
- Review-provider exclusion uses the model's canonical vendor, not merely the endpoint/gateway name: select one
  candidate from each of the two vendors other than the builder's vendor and prefer the closest reviewer at or above the
  builder's effective ability. If a vendor has no model at that level, select its strongest eligible model and record
  the ceiling mismatch.
- Every ordinary second-ranked candidate must be OpenAI or Anthropic.
- Candidate IDs are exact and version-aware. Unknown IDs and silently moving aliases are ineligible unless a policy
  entry explicitly permits that alias; preview/restricted/safeguarded models require explicit registry flags and
  configured fallbacks.
- Until local telemetry is mature (≥30 comparable samples per candidate, passing the route's quality floor), preserve
  the bootstrap ordering below. After maturity, rank by a robust cost-to-done score:

  ```text
  p75 model/tool cost
  + developer wait value × p75 wall time
  + human-intervention cost × P(human intervention)
  + retry cost × P(retry)
  ```

**Sequential fallback:** ordinary routes stop after the primary and fallback. If both fail, retain (or restore) the
pre-existing task selection; there is no ordinary third choice. Review routes try the two independent reviewers
sequentially. If both fail, run the review with the existing builder model, record `review_fell_back_to_builder`, and
preserve the parent task lease. These are sequential attempts, never a panel. Deterministic tests, type checks, linters,
scanners, and policy gates outrank an LLM verdict and can authorize fallback or escalation; an LLM may only recommend
one.

### Bootstrap archetype → model priors

These are starting priors to encode in the eligible-candidate registry, expected to be superseded by measured telemetry
per route:

| Archetype                                   | First choice                                             | Required secondary                                                                  |
| ------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Fast classification/routing                 | fast/low-effort model                                    | different-provider fast model                                                       |
| Exact extraction, rigid schema              | precise model, low/medium effort                         | fast fallback                                                                       |
| Deliberate non-coding tool workflow         | mid-tier agentic model, medium effort                    | same-family fallback, medium                                                        |
| Median repository implementation (1 PR)     | strong coding model, medium effort                       | different-provider high-effort fallback                                             |
| Terminal-heavy implementation               | strong coding model, medium/high effort                  | different-provider high-effort fallback                                             |
| Algorithmic/rapid iterative coding          | fast iterative model, medium effort                      | strong coding model, medium                                                         |
| Code review                                 | closest non-builder-vendor reviewer ≥ builder ability    | candidate from the other non-builder vendor; fixed builder fallback after both fail |
| Ordinary implementation planning (2–10 PRs) | top planning model, high/xhigh                           | different-provider planning model, high                                             |
| Large program planning (11–100 PRs)         | top long-run planning model, high/xhigh                  | different-provider planning model, high/max                                         |
| Long-context synthesis                      | long-context model, medium, or top reasoning model, high | different-provider fallback                                                         |
| Highest-risk ambiguous advisory work        | top reasoning model, high/max                            | different-provider top reasoning model                                              |

Concrete model IDs, effort labels, and quality floors are a **configuration/registry concern**, resolved against pi's
actual `ModelRegistry` at build time — not hardcoded into this spec. Planning and implementation are separate attempts
with separate leases, success criteria, and telemetry: a multi-PR planning route emits a validated program (PR
boundaries, dependency DAG, migration/rollout order, acceptance checks, risks, rollback points, and unknowns), then each
approved PR is routed as its own implementation task.

## Deterministic prompt compiler

Preserve the user's request verbatim; add only validated scaffolding, in this order:

1. stable safety/product policy
2. execution-surface contract
3. model-specific profile
4. tools and return contracts
5. trusted task context
6. untrusted source material, clearly delimited
7. examples, when the profile calls for them
8. verbatim user request
9. output contract and final critical constraints

Provider-aware ordering:

- **OpenAI-family:** static/cacheable policy and tools first; dynamic task context and request last; leaner prompts for
  newer generations — do not transplant an older generation's profile unchanged.
- **Anthropic:** XML-tag-separated sections; documents before the query for long context; explicit action/checkpoint
  policy.
- **Google:** long source context first, task instructions next, core request and critical restrictions last; consistent
  few-shot examples when selected.

The adapter must keep the actual user message in its native user-message position; it may compile only the surrounding
system scaffolding rather than duplicate the request in the system prompt. In either representation, byte-for-byte
preservation of the request is an invariant.

The compiler must never: paraphrase away a user constraint; invent permissions or expand scope; transplant a prompt
profile across model generations without validation; treat classifier prose as trusted policy; duplicate rules already
enforced by tools/deterministic code; hide the builder provider from a review route; reroute a continuing task merely
because a new model turn begins; discard significant reusable cache without a hard boundary or strong discontinuity; or
pass untrusted context as system instructions.

## Deterministic vs. LLM-assisted responsibilities

| Responsibility                                              |                          Deterministic |            LLM-assisted |
| ----------------------------------------------------------- | -------------------------------------: | ----------------------: |
| Token counts, context-window feasibility                    |                                    Yes |                      No |
| Session state, builder identity, tool inventory/permissions |                                    Yes |                      No |
| Prompt archetype, semantic ambiguity                        |                               Validate |                   Infer |
| Planning horizon                                            | Validate against repo/program evidence |                Estimate |
| Risk and action mode                                        |                     Enforce hard flags | Infer missing semantics |
| Model eligibility, secondary-provider rule                  |                                    Yes |                      No |
| Model ranking, effort limits                                |                                    Yes |                      No |
| Prompt-profile selection                                    |                                    Yes |                      No |
| Prompt compilation and ordering                             |                                    Yes |                      No |
| Task decomposition / plan content                           |                               Validate |                Generate |
| Coding, tool use, synthesis, semantic review                |                                  Guard |                 Perform |
| Escalation authorization                                    |                                    Yes |          Recommend only |

## Telemetry

Record every attempt (success, failure, and fallback): route key, model, endpoint version, effort, prompt profile,
provider; input/cached-input/output tokens, cache-hit ratio, billed cost; turns, tool calls, wall time, retries,
fallback chain; test/check outcome, reviewer outcome, human intervention, accepted completion; context-size bucket,
risk, interactivity type, repo/language bucket, classifier confidence.

Compute p50/p75/p90 distributions, not averages, compared only within similar route/context/risk/ interactivity strata.
Telemetry becomes routing authority only after minimum sample count and quality floor are met, using holdouts/controlled
exploration so a former second choice can be promoted.

The local store backing these computations is **append-only JSONL** (matching pi's own session-storage idiom — pi has no
embedded database), read back and aggregated in-process; the retained history is small (one row per task boundary), so
percentiles are computed in-memory rather than via a query engine. See `decisions.md` for how this composes with OTel
export.

## Evaluation

Classifier metrics: intent/action-mode/archetype/horizon accuracy; confidence calibration; false and missed
review-intent rates; hard-policy violation rate; primary/secondary disagreement rate; incremental cost/latency.

Prompt-profile metrics: instruction adherence; completion and accepted-change rate; tool selection/argument accuracy;
unnecessary-clarification and premature-stop rates; progress-claim accuracy; output-schema validity; cumulative
tokens/cache reuse/turns/wall time; plan quality/churn/ cross-PR rework; review precision/recall/false-positive burden.

Always evaluate model and prompt profile as a **paired treatment** — never conclude one model is better when tested
under another model family's prompt profile.

## Hard policy invariants

- High/critical-risk implementation routes require a sequential independent review.
- No unknown model, unsupported effort, context-window violation, or unvalidated model/archetype/profile combination may
  reach execution.
- Explicit manual model or effort selection bypasses automatic routing until the next task boundary or until the user
  re-enables it.
- Effort changes inside a lease preserve task ID, model ID, and prompt-profile ID and are recorded.
- A task model cannot be reconsidered during a non-user tool/model loop. Fallback attempts and child reviews are
  explicit lease transitions, not fresh classifications.
- Every decision records the policy version, model snapshot, classifier output, exclusion reasons, score components,
  fallback reason, and prompt-profile ID.

## Non-goals

- Parallel/multi-agent review panels or advisor arbitration. Review attempts are sequential and use at most the two
  non-builder vendors plus the fixed builder fallback.
- A general-purpose simulator or "what-if" routing sandbox (explicitly deferred until the classifier and profile
  registry stabilize).
- Replacing manual override — a user must still be able to force a model/effort directly (e.g. via `/effort`), bypassing
  the router.

## Implementation sequence (completed)

1. Extend the feature schema with prompt-shape and context-shape fields.
2. Build deterministic context-synopsis generation from pi's session/tool state.
3. Create versioned prompt profiles per model family/generation actually available in pi's registry.
4. Implement provider-aware prompt compilation with verbatim user-request preservation.
5. Add route/profile compatibility validation.
6. Build and run an internal golden-corpus regression suite across model/profile pairs to catch prompt-transfer
   regressions.
7. Roll out classification in **shadow mode** (log decisions, do not act on them) before it changes live routing.
8. Only after the classifier and profile registry are stable, consider any future simulator.

## Verification

- Unit tests for the deterministic core against the invariants in this spec: lease semantics, boundary-only
  reevaluation, headroom feasibility, secondary-provider rule, planning-horizon routing, cache-preservation thresholds.
- Golden-corpus regression suite (fixtures authored from the archetype table above with expected route decisions).
- Shadow-mode run inside a real pi session: install, drive real sessions, confirm logged decisions are sane before
  enabling live routing.
