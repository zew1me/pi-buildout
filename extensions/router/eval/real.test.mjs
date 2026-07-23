import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { complete, Type, validateToolArguments } from "@earendil-works/pi-ai/compat";
import { CLASSIFIER_TOOL_NAME, classifyTask } from "../classifier.ts";
import { compilePrompt } from "../core/compiler.ts";
import { TaskFeaturesSchema } from "../core/features.ts";
import { ProgramPlanSchema, validateProgramPlan } from "../core/planning.ts";
import { findPromptProfile } from "../core/profiles.ts";
import { canonicalVendor } from "../core/routing.ts";
import { requireToolCall } from "../core/tool-choice.ts";
import { resolveBifrostEvalEnvironment } from "./environment.ts";
import { calibrationError, scoreFeatureAxes } from "./score.ts";

const exportedBifrost = {
  BIFROST_BASE_URL: process.env.BIFROST_BASE_URL,
  BIFROST_VIRTUAL_KEY: process.env.BIFROST_VIRTUAL_KEY,
};
if (!exportedBifrost.BIFROST_VIRTUAL_KEY?.trim() || !exportedBifrost.BIFROST_BASE_URL?.trim()) {
  try {
    loadEnvFile(new URL("../../../.env", import.meta.url));
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}
const { virtualKey: bifrostKey, baseUrl: bifrostBase } = resolveBifrostEvalEnvironment(exportedBifrost, process.env);
const enabled = Boolean(bifrostKey && bifrostBase);
const fixtures = JSON.parse(await readFile(new URL("./corpus/routes.json", import.meta.url), "utf8"));
function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function compactProviderError(value) {
  if (!value) return undefined;
  return String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function completeWithStopRetry(run, maximumAttempts = 4) {
  const responses = [];
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    const response = await run();
    responses.push(response);
    if (response.stopReason !== "error") break;
    if (attempt + 1 < maximumAttempts) await delay(1_000 * 2 ** attempt);
  }
  return responses;
}

const limit = positiveInteger(process.env.ROUTER_EVAL_LIMIT, fixtures.length);
const classifierOffset = Math.max(0, Number.parseInt(process.env.ROUTER_EVAL_OFFSET ?? "0", 10) || 0);
const PREMIUM_ARCHETYPES = new Set(["large_program_planning", "highest_risk_advisory"]);

function model(id, provider) {
  const vendor = provider.replace(/^bifrost-/, "");
  const bifrostId = id.includes("/") || vendor !== "google" ? id : `vertex/${id}`;
  return {
    id: bifrostId,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: bifrostBase?.replace(/\/$/, "").endsWith("/v1")
      ? bifrostBase.replace(/\/$/, "")
      : `${bifrostBase?.replace(/\/$/, "")}/v1`,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  };
}

const classifierTool = {
  name: CLASSIFIER_TOOL_NAME,
  description: "Return semantic task features only.",
  parameters: TaskFeaturesSchema,
};

function classifierVendor(modelId) {
  const vendor = canonicalVendor("bifrost", modelId);
  if (!vendor) throw new Error(`Cannot derive classifier vendor for ${modelId}`);
  return vendor;
}

function classifierTransport(selectedModel, vendor) {
  return async (request) => {
    const started = performance.now();
    const responses = await completeWithStopRetry(() =>
      complete(
        selectedModel,
        {
          systemPrompt: request.systemPrompt,
          messages: [{ role: "user", content: request.userPrompt, timestamp: Date.now() }],
          tools: [classifierTool],
        },
        {
          apiKey: bifrostKey,
          maxTokens: 4_096,
          maxRetries: 1,
          onPayload: (payload) => requireToolCall(payload, selectedModel.api, CLASSIFIER_TOOL_NAME),
        },
      ),
    );
    const response = responses.at(-1);
    assert.ok(response, "Bifrost classifier returned no response");
    const toolCall = response.content.find((part) => part.type === "toolCall" && part.name === CLASSIFIER_TOOL_NAME);
    if (!toolCall) {
      const contentTypes = response.content.map((part) => part.type).join(",") || "none";
      throw new Error(
        `Bifrost classifier omitted the schema tool call after ${responses.length} transport attempts (stop=${response.stopReason}, content=${contentTypes}, error=${compactProviderError(response.errorMessage) ?? "none"})`,
      );
    }
    return {
      arguments: validateToolArguments(classifierTool, toolCall),
      provider: selectedModel.provider,
      modelId: selectedModel.id,
      vendor,
      latencyMs: Math.round(performance.now() - started),
      usage: {
        input: response.usage.input,
        output: response.usage.output,
        cacheRead: response.usage.cacheRead,
        cacheWrite: response.usage.cacheWrite,
        cost: response.usage.cost.total,
      },
    };
  };
}

const synopsis = {
  version: 1,
  sessionId: "real-eval",
  workspace: "/evaluation/repository",
  activeTools: ["read", "bash", "edit", "write"],
  context: { tokens: 12_000, contextWindow: 1_000_000, percent: 1.2 },
  repository: {
    root: "/evaluation/repository",
    dirty: false,
    changedFiles: [],
    languageBuckets: ["typescript"],
  },
  artifactState: { readFiles: [], modifiedFiles: [], failedTools: [] },
  priorDecisions: [],
  recentGoals: [],
  recentOutcomes: [],
};

describe("real Bifrost routing evaluation", { skip: !enabled }, () => {
  it("measures classifier accuracy and calibration without provider mocks", async () => {
    const primaryId = process.env.ROUTER_EVAL_PRIMARY_MODEL ?? "gpt-5.5";
    const secondaryId = process.env.ROUTER_EVAL_SECONDARY_MODEL ?? "claude-sonnet-5";
    const primaryVendor = classifierVendor(primaryId);
    const secondaryVendor = classifierVendor(secondaryId);
    assert.notEqual(primaryVendor, secondaryVendor, "classifier eval requires provider-diverse models");
    const results = [];
    for (const fixture of fixtures.slice(classifierOffset, classifierOffset + limit)) {
      const classification = await classifyTask({
        prompt: fixture.prompt,
        synopsis,
        primary: classifierTransport(model(primaryId, `bifrost-${primaryVendor}`), primaryVendor),
        secondary: classifierTransport(model(secondaryId, `bifrost-${secondaryVendor}`), secondaryVendor),
        primaryVendor,
        secondaryVendor,
      });
      const expectedAxes = Object.fromEntries(
        ["intent", "workflowType", "actionMode", "horizon", "risk", "reviewIntent"]
          .filter((axis) => axis in fixture.featureOverrides)
          .map((axis) => [axis, fixture.featureOverrides[axis]]),
      );
      const score = scoreFeatureAxes(classification.features, expectedAxes);
      const expectedReview = fixture.featureOverrides.reviewIntent === true;
      const actualReview = classification.features.reviewIntent;
      const disagreement =
        classification.primaryFeatures && classification.secondaryFeatures
          ? ["intent", "workflowType", "actionMode", "horizon", "risk", "reviewIntent"].some(
              (axis) => classification.primaryFeatures[axis] !== classification.secondaryFeatures[axis],
            )
          : false;
      results.push({
        id: fixture.id,
        accuracy: score.accuracy,
        mismatches: score.mismatches,
        actualAxes: Object.fromEntries(Object.keys(expectedAxes).map((axis) => [axis, classification.features[axis]])),
        confidence: classification.features.confidence,
        correct: score.accuracy === 1,
        archetype: classification.archetype.archetype,
        expectedArchetype: fixture.expected.archetype,
        premiumRoute: PREMIUM_ARCHETYPES.has(classification.archetype.archetype),
        expectedPremiumRoute: PREMIUM_ARCHETYPES.has(fixture.expected.archetype),
        expectedReview,
        actualReview,
        disagreement,
        escalated: classification.escalated,
        failedClosed: classification.failedClosed,
        attempts: classification.attempts,
      });
    }
    const axisAccuracy = results.reduce((total, result) => total + result.accuracy, 0) / results.length;
    const archetypeAccuracy =
      results.filter((result) => result.archetype === result.expectedArchetype).length / results.length;
    const calibration = calibrationError(results);
    const falseReviewRate =
      results.filter((result) => !result.expectedReview && result.actualReview).length /
      Math.max(1, results.filter((result) => !result.expectedReview).length);
    const missedReviewRate =
      results.filter((result) => result.expectedReview && !result.actualReview).length /
      Math.max(1, results.filter((result) => result.expectedReview).length);
    const escalated = results.filter((result) => result.escalated);
    const disagreementRate = escalated.filter((result) => result.disagreement).length / Math.max(1, escalated.length);
    const attempts = results.flatMap((result) => result.attempts);
    const latencyMs = attempts.reduce((total, attempt) => total + (attempt.latencyMs ?? 0), 0);
    const cost = attempts.reduce((total, attempt) => total + (attempt.usage?.cost ?? 0), 0);
    const hardPolicyViolations = results.filter((result) => result.expectedReview && !result.actualReview).length;
    const failedClosedCount = results.filter((result) => result.failedClosed).length;
    const premiumFalsePositives = results.filter((result) => result.premiumRoute && !result.expectedPremiumRoute);
    const premiumRouteFalsePositiveRate =
      premiumFalsePositives.length / Math.max(1, results.filter((result) => !result.expectedPremiumRoute).length);
    const premiumRouteMissRate =
      results.filter((result) => !result.premiumRoute && result.expectedPremiumRoute).length /
      Math.max(1, results.filter((result) => result.expectedPremiumRoute).length);
    console.log(
      JSON.stringify(
        {
          axisAccuracy,
          archetypeAccuracy,
          calibration,
          falseReviewRate,
          missedReviewRate,
          disagreementRate,
          hardPolicyViolations,
          failedClosedCount,
          premiumRouteFalsePositiveRate,
          premiumRouteMissRate,
          premiumFalsePositiveIds: premiumFalsePositives.map((result) => result.id),
          classificationLatencyMs: latencyMs,
          classificationCost: cost,
          results,
        },
        null,
        2,
      ),
    );
    if (results.length === fixtures.length) {
      assert.ok(axisAccuracy >= 0.8, `classifier axis accuracy ${axisAccuracy} is below 0.8`);
      assert.ok(archetypeAccuracy >= 0.8, `archetype accuracy ${archetypeAccuracy} is below 0.8`);
    } else {
      assert.equal(failedClosedCount, 0, "partial classifier canary failed closed");
      assert.ok(archetypeAccuracy >= 0.8, `partial classifier archetype accuracy ${archetypeAccuracy} is below 0.8`);
    }
    const review = results.find((result) => result.id === "code-review-001");
    if (review) assert.equal(review.archetype, "code_review", "explicit review intent was missed");
    assert.equal(hardPolicyViolations, 0, "real classifier produced a hard-policy violation");
    assert.equal(
      premiumFalsePositives.length,
      0,
      `non-premium fixtures were over-routed: ${premiumFalsePositives.map((result) => result.id).join(", ")}`,
    );
  });

  it("evaluates every archetype as a model/profile paired treatment", async () => {
    const treatments = [
      {
        archetype: "fast_classification",
        vendor: "openai",
        modelId: "gpt-5.6-luna",
        effort: "low",
        request:
          'Summarize in one sentence: "This repository packages pi extensions. Each extension has deterministic tests, and installation is scripted."',
      },
      {
        archetype: "exact_extraction",
        vendor: "openai",
        modelId: "gpt-5.6-terra",
        effort: "medium",
        request: 'Return exactly JSON matching {"name": string, "age": number} for: name=Ada, age=36.',
      },
      {
        archetype: "deliberate_tool_workflow",
        vendor: "openai",
        modelId: "gpt-5.5",
        effort: "medium",
        request:
          "Return a dry-run release checklist in this response with an explicit human checkpoint before publish; do not create files or ask where to save it.",
      },
      {
        archetype: "median_repository_implementation",
        vendor: "openai",
        modelId: "gpt-5.6-terra",
        effort: "medium",
        request:
          "Given src/store.ts contains `export function save(name: string) { return db.save({ name }); }`, return a unified TypeScript patch that throws on an empty trimmed name, plus one node:test unit test; do not inspect files.",
      },
      {
        archetype: "terminal_heavy_implementation",
        vendor: "openai",
        modelId: "gpt-5.6-terra",
        effort: "high",
        request: "Diagnose EADDRINUSE on port 3000 and give the minimal safe inspect, fix, and verify commands.",
      },
      {
        archetype: "algorithmic_iterative_coding",
        vendor: "google",
        modelId: "gemini-2.5-flash",
        effort: "medium",
        request:
          "Return a concise self-contained TypeScript function that strictly parses comma-separated safe integers, rejecting empty, malformed, non-integer, and unsafe-number fields, plus at most eight focused edge-case tests.",
      },
      {
        archetype: "code_review",
        vendor: "google",
        modelId: "gemini-2.5-flash",
        effort: "high",
        request:
          "Review `function divide(a,b){ return a/b }` for actionable correctness issues; include evidence anchors.",
      },
      {
        archetype: "implementation_planning",
        vendor: "anthropic",
        modelId: "claude-opus-4-8",
        effort: "high",
        request: "Plan a three-PR additive database migration with dependencies, acceptance, rollout, and rollback.",
      },
      {
        archetype: "large_program_planning",
        vendor: "anthropic",
        modelId: "claude-fable-5",
        effort: "high",
        request:
          "Call submit_implementation_plan immediately with exactly twelve compact PRs for a service extraction. Use at most two assumptions and two program unknowns, one short sentence per field, dependency DAG edges, and reversible rollout gates.",
      },
      {
        archetype: "long_context_synthesis",
        vendor: "anthropic",
        modelId: "claude-sonnet-5",
        effort: "medium",
        request:
          "Synthesize: document A requires weekly deploys; document B freezes deploys in December. State the conflict.",
      },
      {
        archetype: "highest_risk_advisory",
        vendor: "openai",
        modelId: "gpt-5.6-sol",
        effort: "max",
        request:
          "Advise on an irreversible production data deletion with ambiguous retention requirements; do not authorize it.",
      },
    ];
    const profileLimit = positiveInteger(process.env.ROUTER_EVAL_PROFILE_LIMIT, treatments.length);
    const profileOffset = Math.max(0, Number.parseInt(process.env.ROUTER_EVAL_PROFILE_OFFSET ?? "0", 10) || 0);
    const JudgeSchema = Type.Object(
      {
        pass: Type.Boolean(),
        instructionAdherence: Type.Number({ minimum: 0, maximum: 1 }),
        unnecessaryClarification: Type.Boolean(),
        prematureStop: Type.Boolean(),
        outputSchemaValid: Type.Boolean(),
        toolSelectionAccurate: Type.Boolean(),
        progressClaimsAccurate: Type.Boolean(),
        rationale: Type.String({ maxLength: 4_000 }),
      },
      { additionalProperties: false },
    );
    const judgeTool = {
      name: "report_profile_judgment",
      description: "Score the paired model/profile treatment against the request and profile contract.",
      parameters: JudgeSchema,
    };
    const planTool = {
      name: "submit_implementation_plan",
      description: "Submit the complete implementation-plan DAG.",
      parameters: ProgramPlanSchema,
    };
    const results = [];
    for (const treatment of treatments.slice(profileOffset, profileOffset + profileLimit)) {
      const profile = findPromptProfile(treatment.vendor, treatment.modelId, treatment.archetype, treatment.effort);
      assert.ok(profile, `missing profile for ${treatment.archetype}`);
      const planning =
        treatment.archetype === "implementation_planning" || treatment.archetype === "large_program_planning";
      const treatmentSynopsis = {
        ...synopsis,
        activeTools: planning ? ["submit_implementation_plan"] : [],
      };
      const compiled = compilePrompt({
        baseSystemPrompt: "Be safe and accurate.",
        profile,
        synopsis: treatmentSynopsis,
        userRequest: treatment.request,
        archetype: treatment.archetype,
      });
      const workerModel = model(treatment.modelId, `bifrost-${treatment.vendor}`);
      const workerMessages = [
        { role: "user", content: compiled.contextMessage, timestamp: Date.now() },
        { role: "user", content: compiled.userRequest, timestamp: Date.now() },
      ];
      const initialWorkerResponses = await completeWithStopRetry(() =>
        complete(
          workerModel,
          {
            systemPrompt: compiled.systemPrompt,
            messages: workerMessages,
            ...(planning ? { tools: [planTool] } : {}),
          },
          {
            apiKey: bifrostKey,
            maxTokens: planning ? 8_192 : 16_384,
            maxRetries: 0,
            timeoutMs: planning ? 180_000 : 90_000,
            reasoning: treatment.effort,
            ...(planning
              ? { onPayload: (payload) => requireToolCall(payload, "openai-completions", planTool.name) }
              : {}),
          },
        ),
      );
      let workerResponse = initialWorkerResponses.at(-1);
      assert.ok(workerResponse, `worker returned no response for ${treatment.archetype}`);
      const workerUsage = initialWorkerResponses.map((response) => response.usage);
      let planValid;
      let planValidationError;
      let planToolCalled = false;
      let submittedPlanPrCount;
      if (planning) {
        const planCall = workerResponse.content.find(
          (part) => part.type === "toolCall" && part.name === "submit_implementation_plan",
        );
        planToolCalled = Boolean(planCall);
        try {
          const submittedPlan = planCall ? validateToolArguments(planTool, planCall) : undefined;
          planValid = submittedPlan ? validateProgramPlan(submittedPlan).success : false;
          submittedPlanPrCount = submittedPlan?.pullRequests.length;
        } catch (error) {
          planValid = false;
          planValidationError = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
        }
        if (planCall && planValid) {
          const planResponse = workerResponse;
          const finalWorkerResponses = await completeWithStopRetry(() =>
            complete(
              workerModel,
              {
                systemPrompt: compiled.systemPrompt,
                messages: [
                  ...workerMessages,
                  planResponse,
                  {
                    role: "toolResult",
                    toolCallId: planCall.id,
                    toolName: planTool.name,
                    content: [{ type: "text", text: "Implementation-plan DAG validated successfully." }],
                    isError: false,
                    timestamp: Date.now(),
                  },
                ],
              },
              {
                apiKey: bifrostKey,
                maxTokens: 2_048,
                maxRetries: 0,
                timeoutMs: 60_000,
                reasoning: treatment.effort,
              },
            ),
          );
          workerUsage.push(...finalWorkerResponses.map((response) => response.usage));
          workerResponse = finalWorkerResponses.at(-1);
          assert.ok(workerResponse, `planning worker returned no final response for ${treatment.archetype}`);
        }
      }
      const judgeId =
        treatment.vendor === "anthropic"
          ? (process.env.ROUTER_EVAL_OPENAI_JUDGE_MODEL ?? "gpt-5.5")
          : (process.env.ROUTER_EVAL_ANTHROPIC_JUDGE_MODEL ?? "claude-sonnet-5");
      const judgeVendor = treatment.vendor === "anthropic" ? "openai" : "anthropic";
      const judgeModel = model(judgeId, `bifrost-${judgeVendor}`);
      const judgeRequest = {
        systemPrompt:
          "Judge instruction adherence conservatively. Only implementation_planning and large_program_planning require submit_implementation_plan; other treatments may correctly return self-contained artifacts without tools. Deterministic planValid, planToolCalled, and submittedPlanPrCount fields are authoritative evidence for planning tool use; a planning response is only the post-tool final message. Keep rationale under 800 characters and call report_profile_judgment exactly once.",
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              request: treatment.request,
              archetype: treatment.archetype,
              profileId: profile.id,
              outputContract: compiled.outputContract,
              response: workerResponse.content,
              planValid,
              planToolCalled,
              submittedPlanPrCount,
              planValidationError,
            }),
            timestamp: Date.now(),
          },
        ],
        tools: [judgeTool],
      };
      const judgeResponses = [];
      let judgmentCall;
      for (let attempt = 0; attempt < 2 && !judgmentCall; attempt++) {
        const transportResponses = await completeWithStopRetry(() =>
          complete(judgeModel, judgeRequest, {
            apiKey: bifrostKey,
            maxTokens: 1_024,
            maxRetries: 0,
            timeoutMs: 60_000,
            onPayload: (payload) => requireToolCall(payload, "openai-completions", judgeTool.name),
          }),
        );
        judgeResponses.push(...transportResponses);
        const response = transportResponses.at(-1);
        assert.ok(response, `judge returned no response for ${treatment.archetype}`);
        judgmentCall = response.content.find(
          (part) => part.type === "toolCall" && part.name === "report_profile_judgment",
        );
        if (response.stopReason === "error") break;
      }
      const judgeResponse = judgeResponses.at(-1);
      const judgeDiagnostics = judgeResponse
        ? `stop=${judgeResponse.stopReason}, content=${judgeResponse.content.map((part) => part.type).join(",") || "none"}, error=${compactProviderError(judgeResponse.errorMessage) ?? "none"}`
        : "no response";
      assert.ok(
        judgmentCall,
        `judge omitted structured judgment for ${treatment.archetype} after ${judgeResponses.length} attempts (${judgeDiagnostics})`,
      );
      const judgment = validateToolArguments(judgeTool, judgmentCall);
      results.push({
        ...treatment,
        profileId: profile.id,
        judgeId,
        planValid,
        planToolCalled,
        submittedPlanPrCount,
        planValidationError,
        judgment,
        workerStopReason: workerResponse.stopReason,
        workerErrorMessage: compactProviderError(workerResponse.errorMessage),
        workerUsage,
        judgeUsage: judgeResponses.map((response) => response.usage),
      });
    }
    const passRate =
      results.filter((result) => result.judgment.pass && result.planValid !== false).length / results.length;
    const unnecessaryClarificationRate =
      results.filter((result) => result.judgment.unnecessaryClarification).length / results.length;
    const prematureStopRate = results.filter((result) => result.judgment.prematureStop).length / results.length;
    const outputSchemaValidity = results.filter((result) => result.judgment.outputSchemaValid).length / results.length;
    const toolSelectionAccuracy =
      results.filter((result) => result.judgment.toolSelectionAccurate).length / results.length;
    const progressClaimAccuracy =
      results.filter((result) => result.judgment.progressClaimsAccurate).length / results.length;
    console.log(
      JSON.stringify(
        {
          passRate,
          unnecessaryClarificationRate,
          prematureStopRate,
          outputSchemaValidity,
          toolSelectionAccuracy,
          progressClaimAccuracy,
          results,
        },
        null,
        2,
      ),
    );
    assert.ok(passRate >= 0.8, `paired-treatment pass rate ${passRate} is below 0.8`);
  });
});
