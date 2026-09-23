#!/usr/bin/env node
/** Opt-in paid live eval. Never run during npm test. */
import { writeFile } from "node:fs/promises";
import { buildClassifierPrompt, formatModelCatalog } from "./helpers.ts";
import { ESCALATION_EVAL_CASES, ROUTING_EVAL_CASES } from "./routing-eval-cases.mjs";
import { createLiveClassifier, GPT6_EVAL_CANDIDATES, scoreDecision } from "./routing-eval.mjs";

if (!process.argv.includes("--live")) {
  throw new Error("Live eval makes paid network calls; opt in with --live.");
}
const cases = [...ROUTING_EVAL_CASES, ...ESCALATION_EVAL_CASES];
const decide = createLiveClassifier({ model: "openai-codex/gpt-6-luna", candidates: GPT6_EVAL_CANDIDATES });
const results = [];
for (const evalCase of cases) {
  try {
    const decision = await decide(evalCase);
    const score = scoreDecision(evalCase, decision, GPT6_EVAL_CANDIDATES);
    console.error(`${evalCase.id}: ${score.ok ? "PASS" : "FAIL"} ${JSON.stringify(decision)}`);
    results.push({ id: evalCase.id, decision, score });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${evalCase.id}: ERROR ${message}`);
    results.push({ id: evalCase.id, error: message });
  }
}
const artifact = {
  generatedAt: new Date().toISOString(),
  classifierModel: "openai-codex/gpt-6-luna",
  classifierEffort: "low",
  note: "Pi CLI print mode (extensions/skills/tools disabled), empty context summary; not identical to extension completeSimple system environment. Paid and nondeterministic.",
  prompt: buildClassifierPrompt({
    task: "<CASE TASK>",
    contextSummary: "",
    catalog: formatModelCatalog(GPT6_EVAL_CANDIDATES),
  }),
  cases: cases.map(({ id, task, allow, maxEffort, allowEscalation }) => ({
    id,
    task,
    allow,
    maxEffort,
    allowEscalation,
  })),
  candidates: GPT6_EVAL_CANDIDATES,
  results,
};
const destination = new URL("./routing-gpt6-eval-results.json", import.meta.url);
await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`);
console.error(`Wrote ${destination.pathname}`);
