# Router real-provider evaluation — 2026-07-17

## Environment

- Transport: Bifrost OpenAI-compatible `/v1` endpoint with a local, evaluation-scoped virtual key.
- Credentials: loaded from exported `BIFROST_*` variables or the gitignored `.env`; no credential values are recorded
  here.
- Classifier pair: `gpt-5.5` primary and `claude-sonnet-5` provider-diverse secondary.
- Profile treatments: all 11 routing archetypes, each compiled with its selected model-specific profile and effort.
  Planning treatments completed the validated tool-result/final-response loop.
- Judges: a different model vendor from the worker (`claude-sonnet-5` or `gpt-5.5`).

## Accepted full run

Command:

```bash
npm run test:eval:real
```

Results:

| Metric                                      |                                      Result |
| ------------------------------------------- | ------------------------------------------: |
| Classifier axis accuracy                    |                                      0.8167 |
| Archetype accuracy                          |                                      0.8182 |
| Confidence calibration error                |                                      0.3564 |
| False review-intent rate                    |                                           0 |
| Missed review-intent rate                   |                                           0 |
| Hard-policy violations                      |                                           0 |
| Failed-closed classifications               |                                           0 |
| Provider disagreement among escalated cases |                                         1.0 |
| Aggregate classifier latency                |                                    41.567 s |
| Reported classifier cost                    | 0 (gateway response did not expose billing) |
| Paired-treatment pass rate                  |                                 1.0 (11/11) |
| Output-schema validity                      |                                         1.0 |
| Tool-selection accuracy                     |                                         1.0 |
| Progress-claim accuracy                     |                                         1.0 |
| Unnecessary-clarification rate              |                                           0 |
| Premature-stop rate                         |                                           0 |

Both real-eval tests passed. The full run took approximately 271 seconds.

## Findings incorporated before acceptance

1. Bifrost did not reliably return structured tool calls for the `gpt-5.6-*` classifier routes; `gpt-5.5` and
   `claude-sonnet-5` did. The real harness therefore defaults to that provider-diverse classifier pair while production
   pi continues to resolve its configured exact classifier IDs from the live registry.
2. Bifrost listed `vertex/gemini-3.5-flash`, but calls returned a Vertex model-not-found/access 404 in the configured
   region. `vertex/gemini-2.5-flash` was available, so the policy gained an exact lower-tier Google fallback with its
   own generation-specific prompt profile; the preferred live `gemini-3.5-flash` candidate remains first.
3. Generic completion receipts conflicted with exact-schema and one-sentence requests. The compiler now emits
   archetype-specific output contracts while retaining model-generation profiles.
4. Planning evaluation originally judged only the first tool call. It now validates the submitted DAG, returns
   deterministic tool evidence, runs the post-tool final turn, and judges the complete treatment.
5. Provider reasoning tokens could consume a small output cap. The harness now applies the declared effort and budgets
   enough output for the paired treatment, with bounded request timeouts.

## Remaining calibration work

The accepted classifier clears the starting 0.80 accuracy floors and has no hard-policy or review intent violations, but
its calibration error (0.3564) and disagreement on the escalated critical-risk fixture remain useful optimization
targets. They do not authorize changing the shadow-first default.
