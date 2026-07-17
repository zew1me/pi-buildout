import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveArchetype } from "./archetype.ts";
import { conservativeFeatures } from "./features.ts";
import {
  canonicalVendor,
  isControlledHoldout,
  registrySnapshotId,
  robustCostToDone,
  selectOrdinaryRoute,
  selectReviewRoute,
} from "./routing.ts";

function model(provider, modelId, vendor, contextWindow = 1_000_000) {
  return {
    provider,
    modelId,
    name: modelId,
    vendor,
    contextWindow,
    maxOutputTokens: 128_000,
    available: true,
    reasoning: true,
    supportedEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    inputTypes: ["text", "image"],
    toolCapable: true,
    costPerMillion: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
  };
}

function registry() {
  return [
    model("openai-codex", "gpt-5.6-luna", "openai"),
    model("openai-codex", "gpt-5.6-terra", "openai"),
    model("openai-codex", "gpt-5.6-sol", "openai"),
    model("openai-codex", "gpt-5.5", "openai"),
    model("openai-codex", "gpt-5.4", "openai"),
    model("anthropic", "claude-haiku-4-5", "anthropic"),
    model("anthropic", "claude-sonnet-5", "anthropic"),
    model("anthropic", "claude-opus-4-8", "anthropic"),
    model("anthropic", "claude-fable-5", "anthropic"),
    model("github-copilot", "gemini-3.5-flash", "google"),
  ];
}

const REQUIREMENTS = { estimatedFinishedTokens: 50_000, requiresImages: false, requiresTools: true };

describe("deriveArchetype", () => {
  it("routes planning by horizon before implementation", () => {
    const features = {
      ...conservativeFeatures(),
      intent: "plan",
      workflowType: "implementation_planning",
      horizon: "two_to_ten_prs",
      risk: "medium",
      ambiguity: "medium",
      reviewIntent: false,
    };
    assert.equal(deriveArchetype(features).archetype, "implementation_planning");
    assert.equal(
      deriveArchetype({ ...features, horizon: "eleven_to_hundred_prs" }).archetype,
      "large_program_planning",
    );
  });
});

describe("ordinary route selection", () => {
  it("selects bootstrap primary and required OpenAI/Anthropic fallback", () => {
    const decision = selectOrdinaryRoute("median_repository_implementation", registry(), REQUIREMENTS);
    assert.equal(decision.kind, "ordinary");
    assert.equal(decision.primary.modelId, "gpt-5.6-terra");
    assert.equal(decision.fallback.modelId, "claude-sonnet-5");
    assert.ok(["openai", "anthropic"].includes(decision.fallback.vendor));
    assert.notEqual(decision.primary.profileId, "");
  });

  it("uses the exact generation-specific Google fallback when 3.5 is unavailable", () => {
    const models = [
      ...registry().filter((candidate) => candidate.modelId !== "gemini-3.5-flash"),
      model("google-vertex", "gemini-2.5-flash", "google"),
    ];
    const decision = selectOrdinaryRoute("algorithmic_iterative_coding", models, REQUIREMENTS);
    assert.equal(decision.kind, "ordinary");
    assert.equal(decision.primary.modelId, "gemini-2.5-flash");
    assert.equal(decision.primary.profileId, "google-gemini-2.5-iterative-v1");
    assert.equal(decision.fallback.modelId, "gpt-5.6-terra");
  });

  it("rejects candidates that exceed 70% context headroom", () => {
    const smallRegistry = registry().map((candidate) => ({ ...candidate, contextWindow: 100_000 }));
    const decision = selectOrdinaryRoute("median_repository_implementation", smallRegistry, {
      ...REQUIREMENTS,
      estimatedFinishedTokens: 70_001,
    });
    assert.equal(decision.kind, "unroutable");
    assert.ok(decision.exclusions.some((exclusion) => exclusion.code === "context_headroom"));
  });

  it("preserves bootstrap order until every comparable candidate is mature", () => {
    const samples = [
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-terra",
        archetype: "median_repository_implementation",
        comparableSamples: 30,
        acceptedRate: 0.99,
        p75ModelAndToolCost: 100,
        p75WallTimeMs: 100,
        probabilityHumanIntervention: 0,
        probabilityRetry: 0,
      },
    ];
    const decision = selectOrdinaryRoute("median_repository_implementation", registry(), REQUIREMENTS, samples);
    assert.equal(decision.kind, "ordinary");
    assert.equal(decision.telemetryMature, false);
    assert.equal(decision.primary.modelId, "gpt-5.6-terra");

    const mature = selectOrdinaryRoute("median_repository_implementation", registry(), REQUIREMENTS, [
      ...samples,
      {
        ...samples[0],
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        p75ModelAndToolCost: 1,
      },
    ]);
    assert.equal(mature.kind, "ordinary");
    assert.equal(mature.telemetryMature, true);
    assert.equal(mature.primary.modelId, "claude-sonnet-5");
    assert.equal(mature.primary.scoreComponents.p75ModelAndToolCost, 1);
    assert.ok(Math.abs(mature.primary.scoreComponents.developerWaitCost - 0.0001) < 1e-12);
    assert.equal(mature.primary.scoreComponents.humanInterventionCost, 0);
    assert.equal(mature.primary.scoreComponents.retryCost, 0);

    const holdoutKey = Array.from({ length: 100 }, (_, index) => `task-${index}`).find((key) =>
      isControlledHoldout(key),
    );
    assert.ok(holdoutKey);
    const holdout = selectOrdinaryRoute(
      "median_repository_implementation",
      registry(),
      REQUIREMENTS,
      [...samples, { ...samples[0], provider: "anthropic", modelId: "claude-sonnet-5", p75ModelAndToolCost: 1 }],
      undefined,
      holdoutKey,
    );
    assert.equal(holdout.kind, "ordinary");
    assert.equal(holdout.controlledHoldout, true);
    assert.equal(holdout.primary.modelId, "gpt-5.6-terra");
    assert.equal(holdout.primary.rankReason, "controlled_holdout");
  });
});

describe("review route selection", () => {
  it("selects both non-builder vendors and fixes the builder as final fallback", () => {
    const models = registry();
    const builder = models.find((candidate) => candidate.modelId === "gpt-5.6-terra");
    const decision = selectReviewRoute(models, REQUIREMENTS, builder, "medium", 2);
    assert.equal(decision.kind, "review");
    assert.deepEqual(new Set([decision.primary.vendor, decision.fallback.vendor]), new Set(["anthropic", "google"]));
    assert.equal(decision.builderFallback.vendor, "openai");
    assert.equal(decision.builderFallback.rankReason, "fixed_builder_fallback");
  });

  it("tries a stronger reviewer tier when the closest at-or-above model is unavailable", () => {
    const models = registry().map((candidate) =>
      candidate.modelId === "claude-opus-4-8" || candidate.modelId === "claude-sonnet-5"
        ? { ...candidate, available: false }
        : candidate,
    );
    const builder = models.find((candidate) => candidate.modelId === "gpt-5.6-sol");
    const decision = selectReviewRoute(models, REQUIREMENTS, builder, "high", 3);
    assert.equal(decision.kind, "review");
    const anthropic = [decision.primary, decision.fallback].find((choice) => choice.vendor === "anthropic");
    assert.equal(anthropic.modelId, "claude-fable-5");
  });

  it("rejects an unavailable fixed builder fallback", () => {
    const models = registry();
    const builder = { ...models.find((candidate) => candidate.modelId === "gpt-5.6-terra"), available: false };
    const decision = selectReviewRoute(
      models.map((candidate) => (candidate.modelId === builder.modelId ? builder : candidate)),
      REQUIREMENTS,
      builder,
      "medium",
      2,
    );
    assert.equal(decision.kind, "unroutable");
    assert.ok(decision.exclusions.some((exclusion) => exclusion.code === "unavailable"));
  });
});

describe("routing helpers", () => {
  it("normalizes gateway model IDs to their actual vendor", () => {
    assert.equal(canonicalVendor("github-copilot", "claude-sonnet-5"), "anthropic");
    assert.equal(canonicalVendor("github-copilot", "gemini-3.5-flash"), "google");
    assert.equal(canonicalVendor("openai-codex", "gpt-5.6-terra"), "openai");
    assert.equal(canonicalVendor("bifrost", "openai/gpt-5.6-terra"), "openai");
    assert.equal(canonicalVendor("bifrost", "bedrock/anthropic.claude-sonnet-5"), "anthropic");
    assert.equal(canonicalVendor("bifrost", "vertex/gemini-2.5-flash"), "google");
  });

  it("calculates robust cost-to-done and stable snapshots", () => {
    assert.equal(
      robustCostToDone(
        {
          provider: "openai",
          modelId: "x",
          archetype: "fast_classification",
          comparableSamples: 30,
          acceptedRate: 1,
          p75ModelAndToolCost: 2,
          p75WallTimeMs: 10,
          probabilityHumanIntervention: 0.1,
          probabilityRetry: 0.2,
        },
        { developerWaitValuePerMs: 0.5, humanInterventionCost: 10, retryCost: 5 },
      ),
      9,
    );
    const snapshot = registrySnapshotId(registry());
    assert.equal(snapshot, registrySnapshotId([...registry()].reverse()));
    assert.match(snapshot, /^registry-v1:10:[0-9a-f]{16}$/);
  });
});
