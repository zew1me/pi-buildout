import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { deriveArchetype } from "../core/archetype.ts";
import { conservativeFeatures, validateTaskFeatures } from "../core/features.ts";
import { BOOTSTRAP_ROUTE_POLICIES, reviewerRefs, reviewerVendors } from "../core/policy.ts";
import { EFFORT_LEVELS, findPromptProfile } from "../core/profiles.ts";
import { deriveRoutingContext, selectOrdinaryRoute, selectStandaloneReviewRoute } from "../core/routing.ts";
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
  for (const vendor of reviewerVendors()) {
    for (const ability of [1, 2, 3, 4]) refs.push(...reviewerRefs(vendor, ability));
  }
  // Policy names logical models, so the corpus synthesizes one manufacturer endpoint per model. This
  // is what a machine with everything scoped in looks like.
  const providerFor = {
    openai: "openai-codex",
    anthropic: "anthropic",
    google: "google-vertex",
    minimax: "amazon-bedrock",
    moonshot: "amazon-bedrock",
  };
  const unique = new Map();
  for (const ref of refs) {
    const key = `${providerFor[ref.vendor]}/${ref.logicalModelId}`;
    if (unique.has(key)) continue;
    unique.set(key, {
      provider: providerFor[ref.vendor],
      modelId: ref.logicalModelId,
      name: ref.logicalModelId,
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
const PREMIUM_ARCHETYPES = new Set(["large_program_planning", "highest_risk_advisory"]);
const SOL_MODELS = new Set(["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-sol"]);

// Premium choices are the super-saturation and highest-cost-per-pass configurations. Only the
// premium archetypes may take one as a primary; every other archetype must stay on a saturated tier.
function isPremiumChoice(choice) {
  const logical = choice.logicalModelId ?? choice.modelId;
  return (
    (SOL_MODELS.has(logical) && choice.effort === "max") ||
    (logical === "claude-opus-5-5" && (choice.effort === "xhigh" || choice.effort === "max")) ||
    logical === "claude-fable-5"
  );
}

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
          ? selectStandaloneReviewRoute(
              models,
              requirements,
              [],
              undefined,
              undefined,
              deriveRoutingContext(features, []),
            )
          : selectOrdinaryRoute(
              archetype,
              models,
              requirements,
              [],
              undefined,
              undefined,
              // Consequence, verification strength, and interactivity come from the fixture's own
              // features, so the corpus exercises the real derivation rather than a default.
              deriveRoutingContext(features, []),
            );
      assert.notEqual(decision.kind, "unroutable", decision.reason);
      const fallbacks = decision.fallbacks;
      if (fixture.expected.primaryModel) assert.equal(decision.primary.modelId, fixture.expected.primaryModel);
      if (fixture.expected.primaryEffort) assert.equal(decision.primary.effort, fixture.expected.primaryEffort);
      if (fixture.expected.fallbackModel) {
        assert.ok(fallbacks.some((choice) => choice.modelId === fixture.expected.fallbackModel));
      }
      if (fixture.expected.fallbackEffort) {
        assert.ok(fallbacks.some((choice) => choice.effort === fixture.expected.fallbackEffort));
      }
      if (fixture.expected.allowedModels) {
        const allowed = new Set(fixture.expected.allowedModels);
        assert.ok([decision.primary, ...fallbacks].every((choice) => allowed.has(choice.modelId)));
      }
      if (fixture.expected.primaryVendor) assert.equal(decision.primary.vendor, fixture.expected.primaryVendor);
      if (fixture.expected.fallbackVendor) {
        assert.ok(fallbacks.some((choice) => choice.vendor === fixture.expected.fallbackVendor));
      }
      if (!PREMIUM_ARCHETYPES.has(fixture.expected.archetype)) {
        assert.equal(isPremiumChoice(decision.primary), false, `${fixture.id} received a premium primary`);
      }
      for (const choice of [decision.primary, ...fallbacks]) {
        assert.ok(findPromptProfile(choice.vendor, choice.modelId, archetype, choice.effort));
      }
    });
  }
});
