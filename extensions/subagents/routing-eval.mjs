/**
 * Routing evaluation harness.
 *
 * Scores a routing decision function against the corpus in
 * `routing-eval-cases.mjs`, applying the same checks the live extension
 * applies: the choice must resolve strictly inside the session scope, it must
 * respect the cost ladder, and it must not reach the frontier tier without the
 * approval gate.
 *
 * The harness is deliberately decision-source agnostic. The same checks score
 * the built-in classifier, a registered routing plugin, or a fixed stub, so the
 * policy is verified once rather than per caller.
 */

import {
  clampThinkingLevel,
  escalationGate,
  isEscalationClassModel,
  modelStrengthRank,
  resolveCandidateModel,
  THINKING_LEVELS,
} from "./helpers.ts";

/**
 * The model scope these evaluations route within.
 *
 * Mirrors a realistic `openai-codex` scope from the logs. Note that the GPT-5.6
 * effort narrowing in `supportedThinkingLevels` applies to the direct `openai`
 * provider only, so `max` remains reachable here -- matching the logged
 * `openai-codex/gpt-5.6-sol` runs at `max`.
 */
export const EVAL_CANDIDATES = [
  { provider: "openai-codex", id: "gpt-5.4-mini", contextWindow: 400_000, cost: { input: 0.75, output: 4.5 } },
  { provider: "openai-codex", id: "gpt-5.6-luna", contextWindow: 1_000_000, cost: { input: 0.2, output: 1.2 } },
  { provider: "openai-codex", id: "gpt-5.6-terra", contextWindow: 1_000_000, cost: { input: 2, output: 12 } },
  { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 1_000_000, cost: { input: 4, output: 20 } },
  { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 1_000_000, cost: { input: 10, output: 50 } },
];

/**
 * Bucket a model into a spend tier.
 *
 * Bands follow `modelStrengthRank`, so `gpt-5.4-mini` lands in `substandard`:
 * it is dominated by Luna on intelligence, cost, and latency at once, which
 * makes selecting it a routing defect rather than a cheap choice.
 *
 * @param {import("./helpers.ts").ModelLike} model
 * @returns {import("./routing-eval-cases.mjs").RoutingTier}
 */
export function tierOf(model) {
  if (isEscalationClassModel(model)) return "frontier";
  const rank = modelStrengthRank(model);
  if (rank >= 60) return "premium";
  if (rank >= 50) return "standard";
  if (rank >= 40) return "economy";
  return "substandard";
}

/**
 * @param {import("./helpers.ts").ThinkingLevel} effort
 * @param {import("./helpers.ts").ThinkingLevel} limit
 */
function effortWithinLimit(effort, limit) {
  return THINKING_LEVELS.indexOf(effort) <= THINKING_LEVELS.indexOf(limit);
}

/**
 * Score one decision against one case.
 *
 * @param {import("./routing-eval-cases.mjs").RoutingEvalCase} evalCase
 * @param {{ model: string, effort?: import("./helpers.ts").ThinkingLevel } | undefined} decision
 * @param {readonly import("./helpers.ts").ModelLike[]} candidates
 * @returns {{ id: string, ok: boolean, failures: string[], model?: string, tier?: string, effort?: string }}
 */
export function scoreDecision(evalCase, decision, candidates = EVAL_CANDIDATES) {
  /** @type {string[]} */
  const failures = [];
  if (!decision?.model) {
    return { id: evalCase.id, ok: false, failures: ["no routing decision was produced"] };
  }

  // Exactly the strict path the extension uses, so an eval pass cannot come
  // from an identifier the real flow would have rejected.
  const resolved = resolveCandidateModel(decision.model, [...candidates], "openai-codex", true);
  if (!resolved.model) {
    return { id: evalCase.id, ok: false, failures: [resolved.error ?? `unresolvable model '${decision.model}'`] };
  }

  const model = resolved.model;
  const tier = tierOf(model);
  const effort = clampThinkingLevel(decision.effort ?? "medium", model);
  const reference = `${model.provider}/${model.id}`;

  if (!evalCase.allow.includes(tier)) {
    failures.push(`selected ${reference} (${tier}); allowed tiers are ${evalCase.allow.join(", ")}`);
  }
  if (evalCase.maxEffort && !effortWithinLimit(effort, evalCase.maxEffort)) {
    failures.push(`selected effort ${effort} above the ${evalCase.maxEffort} ceiling for this task`);
  }
  if (tier === "frontier" && !evalCase.allowEscalation) {
    failures.push(`reached the frontier tier ${reference} for work the ceiling tier can complete`);
  }
  if (tier === "frontier") {
    // Even a defensible escalation must still be gated rather than launched outright.
    const gate = escalationGate({
      escalation: true,
      hasCeiling: candidates.some((candidate) => !isEscalationClassModel(candidate)),
      depth: 0,
      hasUI: true,
    });
    if (gate.action !== "prompt") {
      failures.push(`frontier selection was not gated for approval (gate returned ${gate.action})`);
    }
  }

  return { id: evalCase.id, ok: failures.length === 0, failures, model: reference, tier, effort };
}

/**
 * Run a routing decision function across a corpus.
 *
 * @param {(evalCase: import("./routing-eval-cases.mjs").RoutingEvalCase) => Promise<{model: string, effort?: import("./helpers.ts").ThinkingLevel} | undefined> | {model: string, effort?: import("./helpers.ts").ThinkingLevel} | undefined} decide
 * @param {import("./routing-eval-cases.mjs").RoutingEvalCase[]} cases
 * @param {readonly import("./helpers.ts").ModelLike[]} [candidates]
 */
export async function evaluateRouting(decide, cases, candidates = EVAL_CANDIDATES) {
  const results = [];
  for (const evalCase of cases) {
    let decision;
    try {
      decision = await decide(evalCase);
    } catch (error) {
      results.push({
        id: evalCase.id,
        ok: false,
        failures: [`decision threw: ${error instanceof Error ? error.message : String(error)}`],
      });
      continue;
    }
    results.push(scoreDecision(evalCase, decision, candidates));
  }
  const passed = results.filter((result) => result.ok).length;
  return { passed, total: results.length, results, failures: results.filter((result) => !result.ok) };
}

/**
 * Render a report a human can read in CI output.
 *
 * @param {Awaited<ReturnType<typeof evaluateRouting>>} report
 */
export function formatEvalReport(report) {
  const lines = [`routing eval: ${String(report.passed)}/${String(report.total)} cases passed`];
  for (const result of report.results) {
    const detail = result.ok
      ? `${result.model ?? "?"} [${result.effort ?? "?"}] (${result.tier ?? "?"})`
      : result.failures.join("; ");
    lines.push(`  ${result.ok ? "PASS" : "FAIL"} ${result.id}: ${detail}`);
  }
  return lines.join("\n");
}
