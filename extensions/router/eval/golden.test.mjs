import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { deriveArchetype } from "../core/archetype.ts";
import { conservativeFeatures, validateTaskFeatures } from "../core/features.ts";
import { BOOTSTRAP_ROUTE_POLICIES, reviewerRefs } from "../core/policy.ts";
import { EFFORT_LEVELS, findPromptProfile } from "../core/profiles.ts";
import { selectOrdinaryRoute, selectReviewRoute } from "../core/routing.ts";
import { scoreFeatureAxes } from "./score.ts";

const fixtures = JSON.parse(await readFile(new URL("./corpus/routes.json", import.meta.url), "utf8"));

function baseFeatures() {
  return {
    ...conservativeFeatures("golden corpus fixture"),
    intent: "answer",
    workflowType: "research_or_analysis",
    actionMode: "information_only",
    instructionStyle: "outcome_first",
    literalAdherenceRequired: true,
    horizon: "one_response",
    toolDependence: "light",
    contextShape: "multi_file_repository",
    outputRigidity: "structured",
    independenceRequirement: "none",
    taskContinuity: "new_task",
    cacheValue: { cachedTokens: 0, expectedReuseRatio: 0 },
    risk: "medium",
    ambiguity: "low",
    confidence: 0.95,
    reviewIntent: false,
    interactivity: "developer_loop",
    expectedAgentTurns: 3,
    expectedFilesRead: 4,
    expectedFilesChanged: 0,
    expectedToolOutputTokens: 8_000,
    verificationStrength: "self_check",
    decompositionRecommended: false,
    evidence: ["Golden corpus fixture"],
  };
}

function registry() {
  const refs = [];
  for (const policy of Object.values(BOOTSTRAP_ROUTE_POLICIES)) refs.push(...policy.primary, ...policy.fallback);
  for (const vendor of ["openai", "anthropic", "google"]) {
    for (const ability of [1, 2, 3, 4]) refs.push(...reviewerRefs(vendor, ability));
  }
  const unique = new Map();
  for (const ref of refs) {
    const key = `${ref.provider}/${ref.modelId}`;
    if (unique.has(key)) continue;
    unique.set(key, {
      provider: ref.provider,
      modelId: ref.modelId,
      name: ref.modelId,
      vendor: ref.vendor,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      available: true,
      reasoning: true,
      supportedEfforts: EFFORT_LEVELS,
      inputTypes: ["text", "image"],
      toolCapable: true,
      costPerMillion: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
    });
  }
  return [...unique.values()];
}

const models = registry();
const requirements = { estimatedFinishedTokens: 50_000, requiresImages: false, requiresTools: true };

describe("routing golden corpus", () => {
  for (const fixture of fixtures) {
    it(fixture.id, () => {
      const features = { ...baseFeatures(), ...fixture.featureOverrides };
      const validation = validateTaskFeatures(features);
      assert.equal(validation.success, true, validation.errors?.join("\n"));
      assert.equal(scoreFeatureAxes(features, fixture.featureOverrides).accuracy, 1);
      const archetype = deriveArchetype(features).archetype;
      assert.equal(archetype, fixture.expected.archetype);
      const decision =
        archetype === "code_review"
          ? selectReviewRoute(
              models,
              requirements,
              models.find((model) => model.provider === "openai-codex" && model.modelId === "gpt-5.6-terra"),
              "medium",
              2,
            )
          : selectOrdinaryRoute(archetype, models, requirements);
      assert.notEqual(decision.kind, "unroutable", decision.reason);
      if (fixture.expected.primaryModel) assert.equal(decision.primary.modelId, fixture.expected.primaryModel);
      if (fixture.expected.fallbackModel) assert.equal(decision.fallback.modelId, fixture.expected.fallbackModel);
      if (fixture.expected.primaryVendor) assert.equal(decision.primary.vendor, fixture.expected.primaryVendor);
      if (fixture.expected.fallbackVendor) assert.equal(decision.fallback.vendor, fixture.expected.fallbackVendor);
      if (fixture.expected.builderFallbackVendor) {
        assert.equal(decision.kind, "review");
        assert.equal(decision.builderFallback.vendor, fixture.expected.builderFallbackVendor);
      }
      for (const choice of [
        decision.primary,
        decision.fallback,
        ...(decision.kind === "review" ? [decision.builderFallback] : []),
      ]) {
        assert.ok(findPromptProfile(choice.vendor, choice.modelId, archetype, choice.effort));
      }
    });
  }
});
