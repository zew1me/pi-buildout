# Routing layer — evaluation harness

Companion to [`SPEC.md`](SPEC.md) (the functional spec — see its own "Evaluation" section for the
metrics this harness reports) and [`decisions.md`](decisions.md) (architecture). The deterministic
corpus and explicit-Bifrost real-call harness are implemented under `extensions/router/eval/`.
Invoke real calls explicitly with `npm run test:eval:real`; ordinary tests skip them.

## Decision: TS-native harness, real provider calls via Bifrost — no mocks

There is no TypeScript eval framework in use anywhere across the user's reference repos, and no
single company-mandated eval tool even in Python — Upstart's own eval-platform choice is explicitly
still open (`ai-acceleration#136` weighs Arize Phoenix vs LangSmith vs Logfire). The two most
institutionalized internal options, Arize/Phoenix (chosen over promptfoo/DeepEval per SRE's
ADR-0032) and pydantic-evals + Logfire, are both Python-only, and every existing TS repo that touches
an LLM **mocks the provider in tests** rather than calling it for real.

Given that, and that the router itself is TypeScript, in-process, and the workload is
LLM-I/O-bound (see `decisions.md`), the harness for this component is a small **TS-native suite that
makes real calls** rather than reaching into an external Python eval platform:

- One language, living next to the code it evaluates, runnable the same way as the router's own
  unit tests (`node --test`).
- **Real calls, no mocks** — through Bifrost, the sanctioned gateway required for evaluation (see
  `decisions.md`'s Provider access section). It exercises the same pi-ai OpenAI-compatible transport
  and schemas as production while deliberately refusing to fall back to a locally configured direct
  provider.
- Adds no new institutional platform dependency; if a future company-wide eval platform decision
  lands, this harness's real-call, no-mock discipline transfers directly — only the runner/scoring
  glue would move, not the philosophy.

This is deliberately narrower than Arize/Phoenix or pydantic-evals: no experiment-tracking UI, no
hosted dataset store, no trace-based regression dashboard. If the router's evaluation needs grow
past what a golden-corpus `node --test` suite can hold, revisit adopting one of Upstart's Python
eval platforms rather than growing a bespoke one here — but that is out of scope until there's
evidence this harness can't keep up.

## What gets evaluated

Two separate things, per `SPEC.md`'s "Evaluation" section — always scored **as a paired
(model, prompt profile) treatment**, never one without the other:

### 1. Classifier accuracy

Real calls to the configured primary (and, for ambiguous/high-risk fixtures, secondary)
classifier through Bifrost, using pi-ai's public `complete()` compatibility export, scored against a
golden corpus of (prompt, context synopsis) fixtures with hand-authored expected feature objects.

Metrics (mirroring `SPEC.md`'s classifier-metrics list):
- exact-match and per-axis accuracy across the required classification axes (intent, action mode,
  archetype, planning horizon, risk, review intent, …);
- confidence calibration (does stated confidence track actual correctness);
- false and missed review-intent rate;
- hard-policy violation rate (a fixture whose expected output the classifier must never contradict —
  e.g. a review request classified as anything but `review_intent: true`);
- primary/secondary disagreement rate, for fixtures that force escalation;
- latency and token cost per classification call.

### 2. Prompt-profile quality

For a small set of representative tasks (one per archetype in the bootstrap priors table), run the
compiled prompt through the archetype's bootstrap model via Bifrost, then score the response with an
**LLM-as-judge** (also a real Bifrost call, from a model different than the one being judged) against
the profile's own stated goals from `SPEC.md`'s model-specific-profile expectations:

- instruction adherence (did the response follow the compiled contract, not just the raw user ask);
- output-schema validity, where the archetype specifies structured/rigid output;
- unnecessary-clarification / premature-stop signals in the raw transcript;
- a judge-assigned pass/fail plus short rationale, not just a score, so failures are diagnosable.

## Golden corpus

`extensions/router/eval/corpus/routes.json` — one bounded fixture row per archetype in a single
versioned corpus file:

```json
{
  "id": "median-repo-impl-001",
  "prompt": "Add input validation to the /users endpoint",
  "contextSynopsis": { "...": "deterministically-shaped synopsis, matching SPEC.md's schema" },
  "expected": {
    "intent": "implement",
    "archetype": "median_repository_implementation",
    "risk": "medium",
    "review_intent": false
  }
}
```

Corpus composition: one fixture per archetype row in `SPEC.md`'s bootstrap priors table. Separate
lease and classifier tests target every hard boundary (new window, post-compaction, post-push,
subagent) and the confidence-escalation paths (low confidence, high risk, disagreement), because
boundary state is deterministic input to the classifier rather than an archetype fixture. Fixtures
are sourced from this repo's own spec and real, anonymized task shapes — never copied from the
external reference document's examples.

## Harness shape

```
extensions/router/eval/
  corpus/routes.json     # golden fixtures (see above)
  golden.test.mjs        # offline archetype/route/profile regression entry point
  real.test.mjs          # real Bifrost classifier and paired-treatment judge calls
  score.ts               # per-axis accuracy and confidence-calibration scoring
```

- Runs explicitly via `npm run test:eval:real`. Exported `BIFROST_BASE_URL` plus
  `BIFROST_VIRTUAL_KEY` take precedence; missing values are filled from the gitignored
  `.env.bifrost.local`, if present. The explicit command skips cleanly when
  credentials remain absent, while ordinary `npm test` always excludes provider calls. Start from
  `.env.example`; never commit the populated local file.
- Never mocks the provider. If Bifrost is unreachable or the key is invalid, the run fails loudly
  rather than silently falling back to a stub.
- Reports axis/archetype accuracy, confidence calibration, false/missed review rates, hard-policy
  violations, provider disagreement, latency, cost, and per-fixture attempts. Runtime route telemetry
  separately computes stratified p50/p75/p90 distributions.

## When this runs

- **Locally**, on demand, while iterating on `classifier.ts` or a specific prompt profile.
- **In CI**, on PRs touching `extensions/router/**`, using a CI-scoped Bifrost virtual key
  (one key per use case per environment, per Upstart's ADR-005) — never the same key as production
  routing traffic.
- **Before making active mode the default**: a full corpus run with no hard-policy violations and no
  regression against the last accepted baseline is a precondition. Explicit active canaries may run
  earlier, while normal installation remains shadow-first.

## Non-goals

- No experiment-tracking dashboard or hosted dataset store (see Decision above) — reconsider only if
  this harness's scope outgrows a golden-corpus `node --test` suite.
- No synthetic-only corpus — fixtures should be traceable to a real archetype or boundary case in
  `SPEC.md`, not invented to pad coverage numbers.
- No mocking, ever, for this harness specifically — that is the entire point of building it
  TS-native instead of reusing an existing mocked test pattern from elsewhere in the org.
