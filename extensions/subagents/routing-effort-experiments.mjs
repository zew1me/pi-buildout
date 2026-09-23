#!/usr/bin/env node
/** Opt-in live prompt eval: append a suffix, or replay an exact recorded guidance artifact. */
import { readFile, writeFile } from "node:fs/promises";
import {
  buildClassifierPrompt,
  formatModelCatalog,
  parseClassifierDecision,
  ROUTING_LADDER_GUIDANCE,
} from "./helpers.ts";
import { ESCALATION_EVAL_CASES, ROUTING_EVAL_CASES } from "./routing-eval-cases.mjs";
import { execFileClosedStdin, GPT6_EVAL_CANDIDATES } from "./routing-eval.mjs";
import { scoreTunedDecision } from "./routing-target-eval.mjs";

/** @param {string} name */
function argument(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

if (!process.argv.includes("--live")) throw new Error("Live experiments make paid network calls; pass --live.");
const suffixPath = argument("suffix-file");
const artifactPath = argument("guidance-artifact");
const outputPath = argument("output");
if (!outputPath || Boolean(suffixPath) === Boolean(artifactPath)) {
  throw new Error("Pass --output=<path> and exactly one of --suffix-file=<path> or --guidance-artifact=<path>.");
}
let suffix = "";
let guidance = ROUTING_LADDER_GUIDANCE;
if (artifactPath) {
  const saved = JSON.parse(await readFile(artifactPath, "utf8"));
  if (typeof saved.guidance !== "string" || !saved.guidance.trim()) {
    throw new Error("Guidance artifact must contain a nonempty guidance string.");
  }
  guidance = saved.guidance;
  suffix = typeof saved.suffix === "string" ? saved.suffix : "";
} else if (suffixPath) {
  suffix = (await readFile(suffixPath, "utf8")).trim();
  guidance = suffix ? `${ROUTING_LADDER_GUIDANCE}\n\n${suffix}` : ROUTING_LADDER_GUIDANCE;
}
const requested = argument("cases")?.split(",");
const corpus = [...ROUTING_EVAL_CASES, ...ESCALATION_EVAL_CASES];
const cases = requested ? corpus.filter(({ id }) => requested.includes(id)) : corpus;
if (cases.length === 0 || (requested && cases.length !== requested.length)) {
  throw new Error(`Unknown/duplicate cases: ${requested?.join(",") ?? "(none)"}`);
}
const catalog = formatModelCatalog(GPT6_EVAL_CANDIDATES);
const results = [];
for (const evalCase of cases) {
  const prompt = buildClassifierPrompt({ task: evalCase.task, contextSummary: "", catalog }).replace(
    ROUTING_LADDER_GUIDANCE,
    guidance,
  );
  try {
    const { stdout } = await execFileClosedStdin(
      "pi",
      ["-ne", "-ns", "-nt", "--no-session", "--model", "openai-codex/gpt-6-luna", "--thinking", "low", "-p", prompt],
      { maxBuffer: 8 * 1024 * 1024, timeout: 90_000 },
    );
    const decision = parseClassifierDecision(stdout.toString());
    const score = scoreTunedDecision(evalCase, decision);
    results.push({ id: evalCase.id, decision, score });
    console.error(`${evalCase.id}: ${score.ok ? "PASS" : "FAIL"} ${JSON.stringify(decision)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ id: evalCase.id, error: message });
    console.error(`${evalCase.id}: ERROR ${message}`);
  }
}
const artifact = {
  generatedAt: new Date().toISOString(),
  classifier: "openai-codex/gpt-6-luna:low",
  note: "Pi CLI print mode, no extensions/skills/tools/session; empty context summary. Paid, nondeterministic; not the extension's completeSimple system environment.",
  guidance,
  suffix,
  catalog,
  cases: cases.map(({ id, task }) => ({ id, task })),
  results,
};
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.error(`Saved ${outputPath}`);
