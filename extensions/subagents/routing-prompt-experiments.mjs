#!/usr/bin/env node
/**
 * Opt-in live experiments for the subagent routing prompt.
 *
 * This is intentionally excluded from the normal test suite: it makes paid,
 * credential- and network-dependent model calls, and classifier output is not
 * deterministic. Run it explicitly with:
 *
 *   npm run eval:routing-prompts -- --live
 *
 * The committed JSON result files record the exact variants, cases, raw
 * decisions, and scores from the reviewed runs. A missing model in the benchmark evidence
 * means "not evaluated", never "inferior".
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildClassifierPrompt,
  formatModelCatalog,
  parseClassifierDecision,
  ROUTING_LADDER_GUIDANCE,
} from "./helpers.ts";
import { ESCALATION_EVAL_CASES, ROUTING_EVAL_CASES } from "./routing-eval-cases.mjs";
import { EVAL_CANDIDATES, execFileClosedStdin, scoreDecision } from "./routing-eval.mjs";

const MODEL = "openai-codex/gpt-5.6-luna";
const DEFAULT_OUTPUT_PATH = "extensions/subagents/routing-prompt-experiment-results.json";
const CLASSIFICATION_CLAUSE = {
  from: "simple lookups and mechanical edits do not.",
  to: "simple lookups, classifications, and mechanical edits do not.",
};

// Frozen here so the committed first-round artifact remains reproducible after
// the winning prompt becomes the production ROUTING_LADDER_GUIDANCE.
const PRE_TUNING_BASELINE_GUIDANCE = `Choose the cheapest model and effort that clears the task's required intelligence; do not buy capability the task does not need. Within the GPT-5.6 family, capability and cost both rise Luna -> Terra -> Sol, and raising effort on a cheaper model is usually a better trade than moving to a pricier one at low effort.
- Trivial, mechanical, or lookup work: the cheapest family (Luna) at low or medium effort.
- Ordinary implementation, focused debugging, or review: Luna at high or max effort.
- Broad multi-file implementation, subtle debugging, security, or architecture: Terra, then Sol, raising effort before tier.
- Prefer Luna over gpt-5.4-mini whenever both are eligible: measured head-to-head, gpt-5.4-mini is dominated on intelligence, cost, and latency (index 24 at $0.41 and 261s per task, against Luna's 32 at $0.04 and 98s). Route to gpt-5.4-mini only when no GPT-5.6 model is eligible.

The frontier escalation tier (GPT-6 Astra) requires separate user approval, so request it only when one of these actually applies:
- The task needs coding-agent capability above the ceiling tier. On Artificial Analysis' Coding Agent Index, Astra (max) scores ~62 against Sol (max) at ~55 for $7.08 against $6.24 per task, so on agentic coding work the premium is modest even though Astra's per-token price is far higher; the approval gate, not cost, is the reason to be selective.
- Hallucination or factual reliability is a material risk for this task. Astra hallucinates about half as often as the ceiling tier, which is the clearest reason to prefer it.
Do not request escalation for work the ceiling tier can complete.`;

/**
 * @typedef {object} PromptVariant
 * @property {string} id
 * @property {string} hypothesis
 * @property {string} guidance
 * @property {string[]} caseIds
 * @property {boolean} [addClassificationClause]
 * @property {string[]} [repeatCaseIds]
 */

const EFFICIENT_FRONTIER_GUIDANCE = `Choose the cheapest model and effort that clears the task's required intelligence; do not buy capability the task does not need. Treat model and effort as one combined choice rather than choosing a family first.
- Trivial, mechanical, classification, or lookup work: Luna at low or medium effort.
- Ordinary implementation, focused debugging, or review: Luna at high effort.
- Work that needs more reasoning but still fits the cheapest family: Luna at xhigh effort.
- Never choose Terra at low or medium effort; prefer Luna high.
- Never choose Terra at high effort; prefer Luna xhigh.
- Never choose Terra at xhigh effort; prefer Sol medium.
- Terra is eligible only at max effort and only for a task-specific measured strength. If max is absent from Terra's catalog entry, do not choose Terra.
- Prefer Luna xhigh over Sol low. When Luna xhigh is insufficient, move to Sol medium, then Sol high or xhigh as needed.
- Prefer Luna over gpt-5.4-mini whenever both are eligible: measured head-to-head, gpt-5.4-mini is dominated on intelligence, cost, and latency. Route to gpt-5.4-mini only when no GPT-5.6 model is eligible.

The frontier escalation tier (GPT-6 Astra) requires separate user approval. Request it only when the strongest eligible Sol configuration is materially insufficient or when hallucination/factual reliability is a material task risk. Do not request escalation merely because the task is broad or expensive.`;

const DIFFICULTY_BOUNDARY_GUIDANCE = `${EFFICIENT_FRONTIER_GUIDANCE}

Scope and difficulty are separate. "Focused", "read-only", an existing regression test, or a narrow expected diff reduces work volume but does not by itself make the reasoning ordinary. Treat these as subtle/high-consequence signals that normally warrant Sol medium rather than Luna: cross-layer failure semantics; retry and idempotency boundaries; security or authorization; externally shipped contracts; serialization or omitted-versus-default behavior; and production fixes where a locally plausible change can silently lose or corrupt data. Existing tests reduce implementation uncertainty, but they do not remove semantic difficulty. Use Luna high or xhigh when the task is genuinely local and mistakes are easy to detect; use Sol medium when one of those subtle boundaries is central to the task.`;

const BENCHMARK_EVIDENCE = `Artificial Analysis' general Intelligence Index is a comparative benchmark score where higher is better. It is not a percentage, probability, or score out of 100, and differences must not be assumed linear. Approximate score / benchmark-cost-per-task observations from the supplied chart are:
- Luna: low 33 / $0.04; medium 38 / $0.05; high 46 / $0.09; xhigh 49 / $0.13.
- Terra: low 40 / $0.10; medium 46 / $0.13; high 49 / $0.24; xhigh 52 / $0.34; max 55 / $0.57.
- Sol: low 49 / $0.20; medium 54 / $0.32; high 56 / $0.45; xhigh 58 / $0.68; max 59 / $1.03.
These benchmark costs are not the live token prices in the catalog. They support the efficient-frontier preferences above; they are not hard thresholds. Dimension-specific benchmark charts may justify Terra max for a particular task only when Terra max is eligible and the relevant alternatives were actually evaluated on that dimension. A missing model or effort means "not evaluated", not "worse".

On the separate Coding Agent Index, Astra max is about 62 versus Sol max about 55, while average task cost is $7.08 versus $6.24 (about 13.5% more). That index is also comparative, not a percentage or linear scale. Use this only as evidence that approved Astra escalation can buy additional agentic capability; it does not show that every seven-point gap matters to a task.`;

const BENCHMARK_CALIBRATED_GUIDANCE = `${DIFFICULTY_BOUNDARY_GUIDANCE}

${BENCHMARK_EVIDENCE}`;

const PRECISE_DIFFICULTY_GUIDANCE = `${EFFICIENT_FRONTIER_GUIDANCE}

Scope and difficulty are separate. "Focused", "read-only", an existing regression test, or a narrow expected diff reduces work volume but does not by itself make the reasoning ordinary. Use Sol medium when the task's core deliverable requires resolving ambiguous, high-consequence semantics: cross-layer failure behavior; retry and idempotency boundaries; security exploitability or authorization; externally shipped contracts; serialization or omitted-versus-default behavior; or production changes where a locally plausible answer can silently lose or corrupt data. Existing tests reduce implementation uncertainty, but they do not remove semantic difficulty.

Apply that rule to the task's required judgment, not to incidental nouns. A bounded checklist or review that merely enumerates known OAuth, security, pagination, or integration concerns remains Luna high or xhigh. A review that must decide an ambiguous failure boundary or produce concrete exploitable security findings is Sol medium. Ordinary contract-preserving implementation with a clear local solution remains Luna high or xhigh; resolving subtle omitted-versus-default or compatibility semantics is Sol medium.

${BENCHMARK_EVIDENCE}`;

/** @type {PromptVariant[]} */
const VARIANTS = [
  {
    id: "baseline",
    hypothesis: "Reproduce the shipped prompt before changing its ladder.",
    guidance: PRE_TUNING_BASELINE_GUIDANCE,
    caseIds: [...ROUTING_EVAL_CASES, ...ESCALATION_EVAL_CASES].map(({ id }) => id),
  },
  {
    id: "classification-clause-only",
    hypothesis: "Naming classifications as simple work keeps the classification sentinel on Luna.",
    guidance: PRE_TUNING_BASELINE_GUIDANCE,
    addClassificationClause: true,
    caseIds: ["classify-task-difficulty"],
  },
  {
    id: "efficient-frontier",
    hypothesis:
      "Explicit effort-level dominance rules remove low/medium/high/xhigh Terra choices without task-specific hints.",
    guidance: EFFICIENT_FRONTIER_GUIDANCE,
    addClassificationClause: true,
    caseIds: [...ROUTING_EVAL_CASES, ...ESCALATION_EVAL_CASES].map(({ id }) => id),
  },
  {
    id: "difficulty-boundaries",
    hypothesis:
      "Separating work volume from semantic difficulty moves cross-layer and contract-sensitive work above Luna.",
    guidance: DIFFICULTY_BOUNDARY_GUIDANCE,
    addClassificationClause: true,
    caseIds: [...ROUTING_EVAL_CASES, ...ESCALATION_EVAL_CASES].map(({ id }) => id),
    repeatCaseIds: ["debug-sentry-504", "implement-issue-427"],
  },
  {
    id: "benchmark-calibrated",
    hypothesis:
      "Approximate benchmark scores and their interpretation reinforce the frontier without treating scores as linear.",
    guidance: BENCHMARK_CALIBRATED_GUIDANCE,
    addClassificationClause: true,
    caseIds: [...ROUTING_EVAL_CASES, ...ESCALATION_EVAL_CASES].map(({ id }) => id),
    repeatCaseIds: ["debug-sentry-504", "implement-issue-427"],
  },
  {
    id: "precise-difficulty-boundaries",
    hypothesis:
      "Requiring difficult semantics to be the core judgment avoids escalating bounded reviews that merely mention security-sensitive topics.",
    guidance: PRECISE_DIFFICULTY_GUIDANCE,
    addClassificationClause: true,
    caseIds: [...ROUTING_EVAL_CASES, ...ESCALATION_EVAL_CASES].map(({ id }) => id),
    repeatCaseIds: ["debug-sentry-504", "implement-issue-427"],
  },
];

const CASES = new Map([...ROUTING_EVAL_CASES, ...ESCALATION_EVAL_CASES].map((evalCase) => [evalCase.id, evalCase]));
const catalog = formatModelCatalog([...EVAL_CANDIDATES]);

/**
 * @param {import("./routing-eval-cases.mjs").RoutingEvalCase} evalCase
 * @param {PromptVariant} variant
 */
function promptFor(evalCase, variant) {
  let prompt = buildClassifierPrompt({ task: evalCase.task, contextSummary: "", catalog });
  prompt = prompt.replace(ROUTING_LADDER_GUIDANCE, variant.guidance);
  prompt = variant.addClassificationClause
    ? prompt.replace(CLASSIFICATION_CLAUSE.from, CLASSIFICATION_CLAUSE.to)
    : prompt.replace(CLASSIFICATION_CLAUSE.to, CLASSIFICATION_CLAUSE.from);
  return prompt;
}

/** @param {string} prompt */
async function classify(prompt) {
  const { stdout } = await execFileClosedStdin(
    "pi",
    ["-ne", "-ns", "-nt", "--no-session", "--model", MODEL, "--thinking", "low", "-p", prompt],
    { maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
  );
  const text = stdout.toString();
  const decision = parseClassifierDecision(text);
  if (!decision) throw new Error(`Classifier did not return a valid decision: ${text}`);
  return decision;
}

function outputPath() {
  const argument = process.argv.find((value) => value.startsWith("--output="));
  return resolve(argument?.slice("--output=".length) || DEFAULT_OUTPUT_PATH);
}

function requestedVariants() {
  const requested = process.argv
    .filter((argument) => argument.startsWith("--variant="))
    .map((argument) => argument.slice("--variant=".length));
  if (requested.length === 0) return VARIANTS;
  const selected = VARIANTS.filter(({ id }) => requested.includes(id));
  const missing = requested.filter((id) => !selected.some((variant) => variant.id === id));
  if (missing.length > 0) throw new Error(`Unknown prompt variant(s): ${missing.join(", ")}`);
  return selected;
}

/**
 * @param {PromptVariant} variant
 * @param {import("./routing-eval-cases.mjs").RoutingEvalCase} evalCase
 * @param {number} attempt
 */
async function evaluateAttempt(variant, evalCase, attempt) {
  const started = Date.now();
  try {
    const decision = await classify(promptFor(evalCase, variant));
    const score = scoreDecision(evalCase, decision);
    console.error(
      `${variant.id} ${evalCase.id} #${String(attempt)}: ${score.ok ? "PASS" : "FAIL"} ${JSON.stringify(decision)}`,
    );
    return { variant: variant.id, caseId: evalCase.id, attempt, elapsedMs: Date.now() - started, decision, score };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${variant.id} ${evalCase.id} #${String(attempt)}: ERROR ${message}`);
    return { variant: variant.id, caseId: evalCase.id, attempt, elapsedMs: Date.now() - started, error: message };
  }
}

/**
 * @param {PromptVariant} variant
 * @param {string} id
 */
async function evaluateCase(variant, id) {
  const evalCase = CASES.get(id);
  if (!evalCase) throw new Error(`Unknown eval case '${id}'.`);
  const attempts = variant.repeatCaseIds?.includes(id) ? 2 : 1;
  const results = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    results.push(await evaluateAttempt(variant, evalCase, attempt));
  }
  return results;
}

async function run() {
  if (!process.argv.includes("--live")) {
    throw new Error(
      "Live routing prompt evaluations are disabled by default because they make paid, nondeterministic network calls. Pass --live explicitly.",
    );
  }

  const selected = requestedVariants();
  const runStarted = Date.now();
  const results = [];
  for (const variant of selected) {
    for (const id of variant.caseIds) results.push(...(await evaluateCase(variant, id)));
  }

  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - runStarted,
    classifier: {
      model: MODEL,
      effort: "low",
      commandArgumentsBeforePrompt: ["-ne", "-ns", "-nt", "--no-session", "--model", MODEL, "--thinking", "low", "-p"],
      contextSummary: "",
      note: "Pi CLI default system/context behavior remains active; extensions, skills, tools, and session persistence are disabled.",
    },
    candidates: EVAL_CANDIDATES,
    variants: selected,
    cases: selected
      .flatMap(({ caseIds }) => caseIds)
      .filter((id, index, ids) => ids.indexOf(id) === index)
      .map((id) => CASES.get(id)),
    results,
  };
  const destination = outputPath();
  await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`);
  console.error(`Wrote ${destination}`);
}

await run();
