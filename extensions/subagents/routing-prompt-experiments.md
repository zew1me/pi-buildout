# Routing prompt experiments

This document records the live classifier iterations used to tune `ROUTING_LADDER_GUIDANCE`. The exact prompt variants,
eval cases, raw decisions, rationales, elapsed times, and scores are retained in:

- [`routing-prompt-experiments.mjs`](routing-prompt-experiments.mjs)
- [`routing-prompt-experiment-results-round-1.json`](routing-prompt-experiment-results-round-1.json)
- [`routing-prompt-experiment-results-round-2.json`](routing-prompt-experiment-results-round-2.json)

The JSON is intentionally verbose so this conclusion does not depend on terminal output or chat history. These artifacts
freeze the _original_ ten-case corpus; the current corpus adds a tool-using cwd lookup, so rerunning the script from
today's checkout will exercise an additional case. The historical files were not rewritten.

## Method

Both rounds used `openai-codex/gpt-5.6-luna` at low effort to classify the existing ten-case routing corpus. Each call
received the exact session-eligible catalog from `routing-eval.mjs`, an empty task-context summary, and one prompt
variant. The Pi invocation disabled extensions, skills, tools, and session persistence. Pi's default CLI system/context
behavior remained active, which differs from the extension's direct `completeSimple` call and is a limitation of this
live harness.

Each corpus case was sampled once per variant. The two target cases, `debug-sentry-504` and `implement-issue-427`, were
sampled twice for the three variants that changed their outcome. These are small nondeterministic samples, not
statistical estimates.

The live evaluation is not part of `npm test`: it makes paid, network- and credential-dependent calls, and identical
prompts can produce different decisions. It requires explicit opt-in:

```bash
npm run eval:routing-prompts -- --live
```

Use `--variant=<id>` to run one retained variant and `--output=<path>` to avoid replacing another artifact.

## Evidence encoded in the variants

The supplied Artificial Analysis chart suggested this general efficient frontier:

1. Luna low/medium for trivial work.
2. Luna high instead of Terra low/medium.
3. Luna xhigh instead of Terra high or Sol low.
4. Sol medium instead of Terra xhigh.
5. Terra only at max, and only for a task-specific measured strength. If Terra max is unavailable, do not select Terra.
6. Sol high/xhigh after Sol medium when necessary.

Approximate Intelligence Index / benchmark-cost-per-task observations were included to explain that ordering, not to
create hard score thresholds. The prompt says explicitly that the index is comparative, is not a percentage,
probability, linear scale, or score out of 100, and that benchmark task cost is not live token pricing. A missing model
or effort in a dimension-specific chart means **not evaluated**, never **inferior**.

The separate Coding Agent Index comparison was rewritten as Astra max approximately 62 versus Sol max approximately 55,
with average task cost $7.08 versus $6.24 (about 13.5% more). The prompt also says that a seven-point difference is not
assumed to have a fixed or linear meaning.

## Results

| Variant                         | Passed decisions | Passed unique cases | Relevant observation                                                                                                   |
| ------------------------------- | ---------------: | ------------------: | ---------------------------------------------------------------------------------------------------------------------- |
| `baseline`                      |             7/10 |                7/10 | Both target cases stayed on Luna/high; the security audit over-escalated to Astra.                                     |
| `classification-clause-only`    |              1/1 |                 1/1 | Explicitly naming classifications as simple kept the sentinel on Luna/low.                                             |
| `efficient-frontier`            |             8/10 |                8/10 | Removed Terra selections and used Sol/medium for security and architecture, but both target cases stayed on Luna/high. |
| `difficulty-boundaries`         |            10/12 |                8/10 | Both target cases moved to Sol/medium twice, but two bounded reviews also over-escalated.                              |
| `benchmark-calibrated`          |            11/12 |                9/10 | Both target cases remained Sol/medium; the integration checklist still over-escalated.                                 |
| `precise-difficulty-boundaries` |            12/12 |               10/10 | Passed every unique case and both repeated attempts for each target case.                                              |

The formal baseline result differs from an earlier 8/10 live run because the security audit selected Astra in this
sample. That variance is another reason to retain raw output and avoid presenting one run as a deterministic guarantee.

### Target outcomes

The efficient-frontier rules alone did not move the target cases. Luna described both as focused work and chose high
effort. Separating _scope_ from _semantic difficulty_ moved both consistently:

- `debug-sentry-504`: Sol/medium in 2/2 attempts once retry/idempotency and cross-layer failure semantics were explicit
  difficulty signals.
- `implement-issue-427`: Sol/medium in 2/2 attempts once omitted-versus-default behavior and shipped contract semantics
  were explicit difficulty signals.

The first boundary wording was too broad: merely mentioning OAuth/security or asking for adversarial review caused
bounded review cases to move to Sol. The winning wording applies stronger routing only when ambiguous, high-consequence
semantics are the task's **core required judgment**. It expressly keeps a checklist that enumerates known concerns on
Luna, while moving a task that must resolve a failure boundary or produce concrete exploitable findings to Sol.

## Selected production variant

`precise-difficulty-boundaries` became the production guidance because it:

- implements the requested model/effort frontier;
- adds classifications to the explicitly cheap task shapes;
- explains benchmark scores and costs without treating them as absolute or linear;
- moves both original failures to Sol/medium in repeated attempts;
- keeps both bounded review cases on Luna;
- routes the security audit and broad migration to Sol rather than unnecessary Astra; and
- makes no claim about models missing from a benchmark.

This remains opinionated guidance rather than a universal benchmark truth. Explicit user model requests still take
precedence, and `PI_SUBAGENT_ROUTING_HINTS=off` still removes the ladder and escalation opinion entirely.
