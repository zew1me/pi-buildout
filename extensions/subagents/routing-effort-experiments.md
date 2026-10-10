# Review and architecture effort tuning

This is a separate, opt-in, **paid** live classifier experiment stacked on the GPT-6 pricing work. It changes only
routing guidance, not the Astra approval gate or the model scope. The historical GPT-6 run selected Luna/high for an
adversarial review and Sol/medium for a broad multi-repository architecture task. The requested targets are Sol
medium/high (Sol low also acceptable, Terra high+ acceptable) for a review that must adjudicate a disputed code-change
recommendation, and Sol high/xhigh (or **gated** Astra low/medium) for coupled cross-repository architecture. The other
nine cases must stay within their existing tier and effort limits.

`routing-target-eval.mjs` enforces these stricter targets alongside `scoreDecision`'s original checks. The
`review-coderabbit-thread` case's tier allowance changed from economy/standard to standard/premium to reflect the new
requirement; every other case retains its prior bounds. Synthetic unit tests verify both acceptance and rejection. The
11-case live corpus uses `openai-codex/gpt-6-luna:low` as classifier and `GPT6_EVAL_CANDIDATES`; it does **not** run the
subagent task. The Pi CLI print-mode system environment differs from the extension's direct `completeSimple` call. Each
observed decision is one nondeterministic sample, not a stability guarantee.

## Iterations and learnings

Three read-only subagents worked concurrently: one ran CodeRabbit probes, one ran architecture probes, and one reviewed
potential overfitting without making paid calls. No subagent edited tracked files. There were six prompt variants in
all, stopping after the full corpus passed; trials 1–4 used the same unchanged shipped guidance and catalog with the
exact additional text shown below. All invocations used
`pi -ne -ns -nt --no-session --model openai-codex/gpt-6-luna --thinking low -p <prompt>`, with stdin closed and a
timeout.

1. **Code recommendation adjudication:** “For a review that asks you to verify a recommendation, independently test its
   factual premise and decide whether to accept or reject it; that evidence-based adjudication can warrant Sol at medium
   effort. Do not equate it with a bounded checklist that merely enumerates known concerns, which remains Luna at high
   or xhigh effort.” **Observed:** CodeRabbit → Sol/medium; integration checklist control → Luna/high. **Learning:**
   review size alone obscures the difference between adjudicating a proposed change and listing concerns.
2. **Disputed-claim verification:** “Treat adversarial verification as decision work: when the task requires gathering
   evidence about a disputed claim and reaching a defensible conclusion about correctness, impact, or regression risk,
   prefer Sol at medium effort even if the review scope is narrow. Use Luna high or xhigh for reviews that only
   enumerate concerns or apply a known checklist.” **Observed:** CodeRabbit → Sol/medium. **Learning:** narrowness does
   not imply low-consequence judgment, but a universal `adversarial` keyword would overroute unrelated reviews.
3. **Counterargument emphasis:** “Route by the judgment required, not by review size: a request to challenge a
   recommendation and resolve whether its premise holds requires evidence, counterargument, and a decision, so use Sol
   medium. A request to list likely pitfalls without resolving a contested claim is enumeration and stays on Luna high
   or xhigh.” **Observed:** CodeRabbit → Sol/medium. **Learning:** the decision-vs-enumeration distinction survives
   paraphrase in isolated prompts; it still needed testing when combined with architecture guidance.
4. **Coupled architecture constraints:** “For architecture work that spans system boundaries, data ownership, and
   rollout strategy, treat the reasoning as exceptionally demanding; choose a stronger eligible model and high or xhigh
   effort when justified.” **Observed:** architecture → Sol/xhigh; subtle single-boundary Sentry diagnosis control →
   Sol/medium. **Learning:** breadth and interacting design/rollout constraints justify more effort than narrow
   high-consequence debugging. This does not automatically authorize Astra.
5. **First combined variant:** combined the exact deltas from trials 1 and 4. On the **full 11-case corpus**
   architecture → Sol/xhigh, but CodeRabbit → GPT-5.6 Luna/high. All nine other cases remained within bounds.
   **Learning:** isolated success does not guarantee success once guidance is composed; the classifier still interpreted
   a disputed code recommendation as a merely focused review. Full raw decisions, scored failures, and guidance are
   committed in [`routing-effort-eval-results-trial-5.json`](routing-effort-eval-results-trial-5.json); the suffix is in
   [`routing-effort-guidance-trial-5.txt`](routing-effort-guidance-trial-5.txt).
6. **Explicit contested-refactor boundary:** rewrote the first paragraph to distinguish an evidence-based decision about
   a disputed change from a routine bounded review, while retaining trial 4's architecture paragraph. First checked both
   targets and two controls (4/4), then independently reran the complete 11-case corpus: **11/11**; CodeRabbit → GPT-6
   Sol/medium, architecture → GPT-6 Sol/xhigh, and the bounded integration checklist stayed on GPT-6 Luna/xhigh. See the
   [exact suffix](routing-effort-guidance-trial-6.txt),
   [target/control outputs](routing-effort-eval-results-trial-6.json) and
   [full-run raw outputs](routing-effort-eval-results-trial-6-full.json). **Learning:** explicit decision criteria plus
   a non-trigger for ordinary checklists survived composition without overspending on the other tasks.

The exact shipped `ROUTING_LADDER_GUIDANCE` matches the `guidance` field in the full-run artifact byte-for-byte at the
point of adoption. It does not mention individual eval IDs, GitHub issues, or specific model identifiers from the tasks.
GPT-5.6 Terra high/xhigh remains tolerated by the requested target scorer, but the general policy still advises against
Terra below max; no prompt experiment selected Terra.

Run only with deliberate opt-in; **do not** place live calls in `npm test`:

```bash
npm run eval:routing-effort -- --live \
  --guidance-artifact=extensions/subagents/routing-effort-eval-results-trial-6-full.json \
  --output=/tmp/routing-effort-replay.json
```

The `--guidance-artifact` option replays the exact saved guidance even after the shipped guidance has changed. For a new
variant, use `--suffix-file=<path>` instead of `--guidance-artifact`; `--cases=id1,id2` limits paid calls to specified
cases. This is only a measurement of the classifier, not a test of the interactive 30-second Astra approval dialog.
