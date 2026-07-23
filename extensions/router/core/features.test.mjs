import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Check } from "typebox/value";
import { conservativeFeatures, TaskFeaturesSchema, validateTaskFeatures } from "./features.ts";

function validFeatures(overrides = {}) {
  return {
    intent: "implement",
    workflowType: "coding_implementation",
    actionMode: "reversible_mutation",
    instructionStyle: "outcome_first",
    literalAdherenceRequired: true,
    horizon: "single_pr",
    toolDependence: "repository_agent",
    contextShape: "multi_file_repository",
    outputRigidity: "patch_and_receipt",
    independenceRequirement: "none",
    taskContinuity: "new_task",
    cacheValue: { cachedTokens: 0, expectedReuseRatio: 0 },
    risk: "medium",
    ambiguity: "low",
    confidence: 0.95,
    reviewIntent: false,
    interactivity: "developer_loop",
    expectedAgentTurns: 5,
    expectedFilesRead: 8,
    expectedFilesChanged: 3,
    expectedToolOutputTokens: 10_000,
    verificationStrength: "unit_tests",
    decompositionRecommended: false,
    evidence: ["The request asks for a repository implementation"],
    ...overrides,
  };
}

describe("TaskFeaturesSchema", () => {
  it("accepts every required semantic axis", () => {
    const features = validFeatures();
    assert.equal(Check(TaskFeaturesSchema, features), true);
    assert.deepEqual(validateTaskFeatures(features), { success: true, value: features, errors: [] });
  });

  it("rejects unknown enums, extra properties, and out-of-range confidence", () => {
    const result = validateTaskFeatures(validFeatures({ intent: "choose_gpt", confidence: 2, model: "gpt-5.6-sol" }));
    assert.equal(result.success, false);
    assert.ok(result.errors.length >= 2);
  });

  it("provides a schema-valid fail-closed feature object", () => {
    const features = conservativeFeatures("malformed classifier response");
    assert.equal(validateTaskFeatures(features).success, true);
    assert.equal(features.risk, "high");
    assert.equal(features.ambiguity, "high");
    assert.equal(features.confidence, 0);
    assert.equal(features.independenceRequirement, "different_vendor_review");
  });
});
