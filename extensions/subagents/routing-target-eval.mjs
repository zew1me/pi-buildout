/**
 * Extra acceptance criteria for the two previously under-routed tasks.
 * The old tier corpus stays intact so existing bounds remain independently
 * checked and historical result files remain reproducible.
 */
import { scoreDecision, GPT6_EVAL_CANDIDATES } from "./routing-eval.mjs";

/**
 * @param {import("./routing-eval-cases.mjs").RoutingEvalCase} evalCase
 * @param {{model: string, effort?: import("./helpers.ts").ThinkingLevel} | undefined} decision
 */
export function scoreTunedDecision(evalCase, decision) {
  const base = scoreDecision(evalCase, decision, GPT6_EVAL_CANDIDATES);
  if (!base.ok || !base.model || !base.effort) return { ...base, preferred: false };
  const { model, effort } = base;
  if (evalCase.id === "review-coderabbit-thread") {
    const terra = model.endsWith("/gpt-5.6-terra") && ["high", "xhigh", "max"].includes(effort);
    const sol = model.endsWith("/gpt-6-sol") && ["low", "medium", "high", "xhigh"].includes(effort);
    const preferred = sol && ["medium", "high"].includes(effort);
    return terra || sol
      ? { ...base, preferred }
      : { ...base, ok: false, failures: ["review needs Terra high+ or GPT-6 Sol low+"], preferred: false };
  }
  if (evalCase.id === "frontier-architecture") {
    const sol = model.endsWith("/gpt-6-sol") && ["high", "xhigh"].includes(effort);
    const astra = model.endsWith("/gpt-6-astra") && ["low", "medium"].includes(effort);
    return sol || astra
      ? { ...base, preferred: sol }
      : {
          ...base,
          ok: false,
          failures: ["architecture needs GPT-6 Sol high/xhigh or gated Astra low/medium"],
          preferred: false,
        };
  }
  return { ...base, preferred: true };
}
