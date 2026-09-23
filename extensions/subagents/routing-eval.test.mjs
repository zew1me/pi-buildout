import assert from "node:assert/strict";
import test from "node:test";
import { buildClassifierPrompt, formatModelCatalog } from "./helpers.ts";
import { ESCALATION_EVAL_CASES, INTENT_EVAL_CASES, ROUTING_EVAL_CASES } from "./routing-eval-cases.mjs";
import {
  EVAL_CANDIDATES,
  GPT6_EVAL_CANDIDATES,
  createLiveClassifier,
  evaluateIntent,
  evaluateRouting,
  execFileClosedStdin,
  formatEvalReport,
  scoreDecision,
  scoreIntent,
  tierOf,
} from "./routing-eval.mjs";

const ALL_CASES = [...ROUTING_EVAL_CASES, ...ESCALATION_EVAL_CASES];

test("the live classifier runner closes child stdin", async () => {
  assert.equal(typeof createLiveClassifier(), "function");
  const script = 'process.stdin.resume(); process.stdin.once("end", () => process.stdout.write("stdin closed\\n"));';
  const { stdout } = await execFileClosedStdin(process.execPath, ["-e", script], { timeout: 2_000 });
  assert.equal(stdout, "stdin closed\n");
});

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

test("a mixed GPT-6 catalog excludes mini by default without erasing historical or explicit mini tests", () => {
  assert.equal(
    GPT6_EVAL_CANDIDATES.some(({ id }) => id === "gpt-5.4-mini"),
    false,
  );
  assert.equal(
    EVAL_CANDIDATES.some(({ id }) => id === "gpt-5.4-mini"),
    true,
  );
});

test("a mixed GPT-6 catalog scores in the same bands without treating Astra as cheap", () => {
  const luna = GPT6_EVAL_CANDIDATES.find(({ id }) => id === "gpt-6-luna");
  const sol = GPT6_EVAL_CANDIDATES.find(({ id }) => id === "gpt-6-sol");
  assert.ok(luna && sol);
  assert.equal(luna.cost.output, 0.5);
  assert.equal(sol.cost.output, 10);
  assert.equal(tierOf(luna), "economy");
  assert.equal(tierOf(sol), "premium");
  const astra = GPT6_EVAL_CANDIDATES.find(({ id }) => id === "gpt-6-astra");
  assert.ok(astra);
  assert.equal(tierOf(astra), "frontier");
  const handshake = ROUTING_EVAL_CASES[0];
  assert.ok(handshake);
  assert.equal(
    scoreDecision(handshake, { model: "openai-codex/gpt-6-luna", effort: "low" }, GPT6_EVAL_CANDIDATES).ok,
    true,
  );
  assert.equal(
    scoreDecision(handshake, { model: "openai-codex/gpt-6-astra", effort: "low" }, GPT6_EVAL_CANDIDATES).ok,
    false,
  );
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
  // Every case except the ones that explicitly tolerate the substandard tier
  // must reject it, and each rejection must name that tier.
  const shouldFail = ALL_CASES.filter((evalCase) => !evalCase.allow.includes("substandard"));
  assert.ok(shouldFail.length > 0);
  for (const evalCase of shouldFail) {
    const result = report.results.find((entry) => entry.id === evalCase.id);
    assert.equal(result?.ok, false, `${evalCase.id} must reject gpt-5.4-mini`);
    assert.ok(result?.failures.some((message) => message.includes("substandard")));
  }
});

test("a tool-using cwd lookup stays economy at medium or high effort", () => {
  const evalCase = ROUTING_EVAL_CASES.find(({ id }) => id === "lookup-cwd-with-tool");
  assert.ok(evalCase);
  for (const effort of /** @type {const} */ (["medium", "high"])) {
    assert.equal(scoreDecision(evalCase, { model: "openai-codex/gpt-6-luna", effort }, GPT6_EVAL_CANDIDATES).ok, true);
  }
  const low = scoreDecision(evalCase, { model: "openai-codex/gpt-6-luna", effort: "low" }, GPT6_EVAL_CANDIDATES);
  assert.equal(low.ok, false);
  assert.ok(low.failures.some((failure) => failure.includes("below the medium floor")));
  assert.equal(
    scoreDecision(evalCase, { model: "openai-codex/gpt-6-sol", effort: "medium" }, GPT6_EVAL_CANDIDATES).ok,
    false,
  );
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

test("the intent corpus covers named models, delegated effort, and an incidental mention", () => {
  const ids = INTENT_EVAL_CASES.map((evalCase) => evalCase.id);
  assert.equal(new Set(ids).size, ids.length);
  // Every named model must be one the eval scope can actually resolve.
  for (const evalCase of INTENT_EVAL_CASES) {
    const named = evalCase.expectModel ?? evalCase.forbidModel;
    assert.ok(
      EVAL_CANDIDATES.some((candidate) => candidate.id === named),
      `${evalCase.id} names ${named}, which is not in the eval scope`,
    );
  }
  assert.ok(INTENT_EVAL_CASES.some((evalCase) => evalCase.expectEffort));
  assert.ok(INTENT_EVAL_CASES.some((evalCase) => evalCase.expectModel && !evalCase.expectEffort));
  assert.ok(INTENT_EVAL_CASES.some((evalCase) => evalCase.forbidModel));
});

test("honoring the named model and effort passes the intent eval", async () => {
  const report = await evaluateIntent(
    (evalCase) =>
      evalCase.expectModel
        ? { model: `openai-codex/${evalCase.expectModel}`, effort: evalCase.expectEffort ?? "high" }
        : // The incidental-mention case delegates the choice; the ladder should pick cheap.
          { model: "openai-codex/gpt-5.6-luna", effort: "low" },
    INTENT_EVAL_CASES,
  );
  assert.equal(report.passed, report.total, formatEvalReport(report));
});

test("delegated effort is not asserted, so any supported effort passes", async () => {
  const delegated = INTENT_EVAL_CASES.find((evalCase) => evalCase.id === "intent-luna-effort-delegated");
  assert.ok(delegated);
  for (const effort of /** @type {import("./helpers.ts").ThinkingLevel[]} */ (["low", "medium", "high", "xhigh"])) {
    const result = scoreIntent(delegated, { model: "openai-codex/gpt-5.6-luna", effort });
    assert.equal(result.ok, true, `effort ${effort} should be acceptable: ${result.failures.join("; ")}`);
  }
  // The model itself is still pinned.
  assert.equal(scoreIntent(delegated, { model: "openai-codex/gpt-5.6-sol", effort: "low" }).ok, false);
});

test("ignoring an explicitly named model fails the intent eval", async () => {
  // A router that always applies the ladder would override explicit requests.
  const report = await evaluateIntent(() => ({ model: "openai-codex/gpt-5.6-luna", effort: "low" }), INTENT_EVAL_CASES);
  const named = INTENT_EVAL_CASES.filter((evalCase) => evalCase.expectModel && evalCase.expectModel !== "gpt-5.6-luna");
  assert.ok(named.length > 0);
  for (const evalCase of named) {
    const result = report.results.find((entry) => entry.id === evalCase.id);
    assert.equal(result?.ok, false, `${evalCase.id} must fail when its named model is ignored`);
  }
});

test("echoing a model name mentioned in the task text fails the intent eval", async () => {
  const trap = INTENT_EVAL_CASES.find((evalCase) => evalCase.id === "intent-incidental-sol-mention");
  assert.ok(trap);
  const echoed = scoreIntent(trap, { model: "openai-codex/gpt-5.6-sol", effort: "high" });
  assert.equal(echoed.ok, false);
  assert.ok(echoed.failures.some((message) => message.includes("mentions")));
  // Classifying on difficulty instead lands on the cheapest tier and passes.
  assert.equal(scoreIntent(trap, { model: "openai-codex/gpt-5.6-luna", effort: "low" }).ok, true);
});

test("an explicit request for the dominated gpt-5.4-mini is honored over the ladder", () => {
  // The ladder prefers Luna, but an explicit request is not a tier suggestion.
  const mini = INTENT_EVAL_CASES.find((evalCase) => evalCase.id === "intent-54-mini-spaced");
  assert.ok(mini);
  assert.equal(scoreIntent(mini, { model: "openai-codex/gpt-5.4-mini", effort: "medium" }).ok, true);
  assert.equal(scoreIntent(mini, { model: "openai-codex/gpt-5.6-luna", effort: "medium" }).ok, false);
});
