import assert from "node:assert/strict";
import test from "node:test";
import { buildClassifierPrompt, formatModelCatalog } from "./helpers.ts";
import { ESCALATION_EVAL_CASES, ROUTING_EVAL_CASES } from "./routing-eval-cases.mjs";
import { EVAL_CANDIDATES, evaluateRouting, formatEvalReport, scoreDecision, tierOf } from "./routing-eval.mjs";

const ALL_CASES = [...ROUTING_EVAL_CASES, ...ESCALATION_EVAL_CASES];

/**
 * Pick the cheapest model in a tier the case permits.
 *
 * @param {import("./routing-eval-cases.mjs").RoutingEvalCase} evalCase
 */
function firstAllowedModel(evalCase) {
  const model = EVAL_CANDIDATES.find((candidate) => evalCase.allow.includes(tierOf(candidate)));
  assert.ok(model, `no eval candidate satisfies case ${evalCase.id}`);
  return `${model.provider}/${model.id}`;
}

test("the eval corpus is well formed and exercises the full difficulty range", () => {
  const ids = ALL_CASES.map((evalCase) => evalCase.id);
  assert.equal(new Set(ids).size, ids.length, "case ids must be unique");
  for (const evalCase of ALL_CASES) {
    assert.ok(evalCase.task.trim().length > 0, `${evalCase.id} needs a task`);
    assert.ok(evalCase.allow.length > 0, `${evalCase.id} needs at least one allowed tier`);
    assert.ok(evalCase.why.trim().length > 0, `${evalCase.id} needs a documented rationale`);
  }
  // The corpus must span trivial through frontier work, otherwise it cannot
  // distinguish a ladder-respecting router from one that always picks one tier.
  assert.ok(ROUTING_EVAL_CASES.some((evalCase) => evalCase.allow.includes("economy")));
  assert.ok(ROUTING_EVAL_CASES.some((evalCase) => evalCase.allow.includes("premium")));
  assert.ok(ESCALATION_EVAL_CASES.some((evalCase) => evalCase.allowEscalation));
});

test("tier banding places gpt-5.4-mini below the economy tier", () => {
  const byId = Object.fromEntries(EVAL_CANDIDATES.map((model) => [model.id, tierOf(model)]));
  assert.equal(byId["gpt-5.4-mini"], "substandard");
  assert.equal(byId["gpt-5.6-luna"], "economy");
  assert.equal(byId["gpt-5.6-terra"], "standard");
  assert.equal(byId["gpt-5.6-sol"], "premium");
  assert.equal(byId["gpt-6-astra"], "frontier");
});

test("a ladder-respecting router passes every case", async () => {
  const report = await evaluateRouting(
    (evalCase) => ({ model: firstAllowedModel(evalCase), effort: evalCase.maxEffort ?? "high" }),
    ALL_CASES,
  );
  assert.equal(report.passed, report.total, formatEvalReport(report));
});

// Negative controls. Without these the suite could pass while checking nothing.

test("a router that always reaches for the frontier tier fails the eval", async () => {
  const report = await evaluateRouting(() => ({ model: "openai-codex/gpt-6-astra", effort: "high" }), ALL_CASES);
  assert.ok(report.failures.length > 0, "always-frontier routing must fail");
  // It must fail precisely on the cases where the ceiling tier suffices.
  const overreach = report.failures.filter((failure) =>
    failure.failures.some((message) => message.includes("frontier tier")),
  );
  assert.equal(overreach.length, ROUTING_EVAL_CASES.length);
});

test("a router that always picks the dominated gpt-5.4-mini fails the eval", async () => {
  const report = await evaluateRouting(() => ({ model: "openai-codex/gpt-5.4-mini", effort: "medium" }), ALL_CASES);
  assert.equal(report.passed, 0, formatEvalReport(report));
  assert.ok(report.failures.every((failure) => failure.failures.some((message) => message.includes("substandard"))));
});

test("overspending effort on a trivial handshake fails the eval", async () => {
  const handshake = ROUTING_EVAL_CASES.find((evalCase) => evalCase.id === "handshake-waitok");
  assert.ok(handshake, "handshake case must exist");
  const result = scoreDecision(handshake, { model: "openai-codex/gpt-5.6-luna", effort: "max" });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((message) => message.includes("above the low ceiling")));
});

test("a hallucinated or out-of-scope model fails instead of scoring", async () => {
  const report = await evaluateRouting(() => ({ model: "openai/gpt-9-imaginary", effort: "high" }), ALL_CASES);
  assert.equal(report.passed, 0);
  assert.ok(report.failures.every((failure) => failure.failures.some((message) => /scope|not found/i.test(message))));
  const firstCase = ROUTING_EVAL_CASES[0];
  assert.ok(firstCase, "corpus must not be empty");
  const missing = await evaluateRouting(() => undefined, [firstCase]);
  assert.equal(missing.passed, 0);
});

test("the evaluated prompt is the prompt the extension actually ships", () => {
  // Guards against the eval drifting onto a private copy of the instructions.
  const shipped = ROUTING_EVAL_CASES[0];
  assert.ok(shipped, "corpus must not be empty");
  const prompt = buildClassifierPrompt({
    task: shipped.task,
    contextSummary: "",
    catalog: formatModelCatalog([...EVAL_CANDIDATES]),
  });
  assert.match(prompt, /cheapest model and effort/i);
  assert.match(prompt, /gpt-5\.4-mini/);
  assert.match(prompt, /hallucinat/i);
  assert.match(prompt, /openai-codex\/gpt-6-astra/);
  assert.match(prompt, /Return one JSON object only/);
  assert.ok(prompt.includes(shipped.task));
});
