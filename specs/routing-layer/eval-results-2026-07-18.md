# Router real-provider evaluation — 2026-07-18 (premium-route tuning)

Follow-up to [`eval-results-2026-07-17.md`](eval-results-2026-07-17.md). This run validates the change that reduces how
often the router selects the premium `gpt-5.6-sol/max` (highest-risk advisory) and `claude-fable-5/high` (large-program
planning) routes.

## Problem observed in live logs

Router telemetry from a ~2h window (`~/.pi/agent/router-telemetry/events.jsonl`) showed 14 root route decisions, 12 of
which were `failedClosed: true`, and 9 of those landed on a premium route:

- 6 × `large_program_planning → claude-fable-5/high`
- 3 × `highest_risk_advisory → gpt-5.6-sol/max`

Every premium decision shared the same root cause: the primary classifier call failed transport
(`Required tool calls are not configured for API openai-codex-responses`), the second attempt failed identically, and
the pipeline fell through to `conservativeFeatures()`, which hard-codes `risk: high`, `horizon: program_unknown_size`,
and `confidence: 0`. Those synthetic values steer `deriveArchetype()` straight to the two most expensive archetypes. The
underlying tasks were ordinary: "create a worktree", "are the OTEL env vars set", "commit these files", "bind the docs
to the repo".

## Fixes

1. **Forced-tool-call support for the Codex Responses API.** `requireToolCall` now handles `openai-codex-responses`
   (identical shape to `openai-responses`). This was the actual transport failure: the primary `openai-codex` classifier
   never returned structured features, so every classification silently escalated and then failed closed.
   ([`core/tool-choice.ts`](../../extensions/router/core/tool-choice.ts))
2. **Validated single-stage failover.** When the primary transport fails but the provider-diverse secondary returns a
   schema-valid result, the router now uses that validated result directly instead of merging it with synthetic
   conservative defaults (which manufactured high risk + program horizon).
   ([`classifier.ts`](../../extensions/router/classifier.ts))
3. **Fail-closed no longer means premium.** A genuinely failed-closed classification now blocks automatic routing and
   retains the current selection rather than selecting a premium route from fabricated evidence.
   (`automaticRoutingBlockReason` in [`index.ts`](../../extensions/router/index.ts))
4. **Sharper classifier guidance** for risk, horizon, and workflow type so ordinary multi-file/commit/worktree/env tasks
   are not over-escalated to high risk or a multi-PR/program horizon.
   ([`classifier.ts`](../../extensions/router/classifier.ts))
5. **Trace-derived regression fixtures + a premium false-positive gate** in the corpus and both eval harnesses.

## Deterministic suite

`npm test` (provider calls skipped): 102/102 pass, including the new premium false-positive assertion in the golden
corpus and the classifier failover/`automaticRoutingBlockReason` unit tests. `npm run typecheck`, `format:check`, and
`lint:eslint` are clean.

## Real Bifrost run

Command:

```bash
ROUTER_EVAL_PROFILE_LIMIT=1 npm run test:eval:real
```

The classifier corpus now includes six anonymized trace regressions drawn from the live window above.

| Metric                                |           Result |
| ------------------------------------- | ---------------: |
| Classifier axis accuracy              |           0.8353 |
| Archetype accuracy                    |           0.8824 |
| Confidence calibration error          |           0.3612 |
| False review-intent rate              |                0 |
| Missed review-intent rate             |                0 |
| Hard-policy violations                |                0 |
| Failed-closed classifications         |                0 |
| **Premium-route false-positive rate** |            **0** |
| Premium-route miss rate               |                0 |
| Paired-treatment pass rate            | 1.0 (1/1 canary) |

After a follow-up classifier prompt adjustment, all six trace fixtures resolve to their intended non-premium archetypes
(`terminal`/`deliberate_tool_workflow`/`median_repository_implementation`), and no non-premium fixture is routed to a
premium archetype. Residual mismatches are axis-level only (for example the release-checklist fixture's `actionMode`)
and do not change the selected route.

## Live shadow canary

An isolated `openai-codex` shadow canary (temporary `PI_CODING_AGENT_DIR`, copied auth, `PI_ROUTER_MODE=shadow`)
confirmed the transport fix: a single primary classifier attempt from `openai-codex/gpt-5.6-luna` now validates on the
first try (previously two failed attempts), `failedClosed: false`, and an ordinary extraction prompt routes to
`gpt-5.6-terra/medium` rather than a premium route.

## Remaining calibration work

Confidence calibration error (0.3612) and escalated-case disagreement are unchanged from the accepted baseline and
remain optimization targets. They do not authorize changing the shadow-first default.
