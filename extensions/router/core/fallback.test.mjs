import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveFallback, validateFallbackTopology } from "./fallback.ts";
import { conservativeFeatures } from "./features.ts";
import { createTaskLease } from "./lease.ts";

function choice(vendor, modelId, profileId = `${vendor}-profile`) {
  return {
    provider: vendor,
    modelId,
    vendor,
    effort: "high",
    ability: 3,
    profileId,
    contextWindow: 1_000_000,
    rankReason: "bootstrap",
  };
}

function taskLease(archetype, selected, fallbacks) {
  return createTaskLease({
    taskId: "task",
    startedAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    archetype,
    features: conservativeFeatures(),
    selected,
    fallbacks,
    modelSnapshotId: "snapshot",
    policyVersion: "policy",
    lastPromptFingerprint: "prompt",
  });
}

describe("ordinary fallback", () => {
  it("allows exactly one sequential fallback and never a third", () => {
    const lease = taskLease(
      "median_repository_implementation",
      choice("openai", "gpt-5.6-terra", "openai-gpt-5.6-agent-v1"),
      [choice("anthropic", "claude-sonnet-5", "anthropic-claude-fast-agent-v1")],
    );
    assert.deepEqual(validateFallbackTopology(lease), []);
    const fallback = resolveFallback(lease, "deterministic_verification", "2026-07-17T00:01:00.000Z");
    assert.equal(fallback.action, "use_choice");
    assert.equal(fallback.choice.modelId, "claude-sonnet-5");
    const exhausted = resolveFallback(fallback.lease, "quality", "2026-07-17T00:02:00.000Z");
    assert.equal(exhausted.action, "restore_previous");
    assert.match(exhausted.reason, /no third choice/);
  });
});

describe("review fallback", () => {
  it("uses two independent vendors, then the fixed builder, then skips", () => {
    const lease = taskLease("code_review", choice("anthropic", "claude-sonnet-5", "anthropic-claude-fast-agent-v1"), [
      choice("google", "gemini-3.5-flash", "google-gemini-3.5-iterative-v1"),
      choice("openai", "gpt-5.6-terra", "openai-gpt-5.6-agent-v1"),
    ]);
    assert.deepEqual(validateFallbackTopology(lease), []);
    const secondReviewer = resolveFallback(lease, "availability", "2026-07-17T00:01:00.000Z");
    assert.equal(secondReviewer.action, "use_choice");
    assert.equal(secondReviewer.reviewFellBackToBuilder, false);
    const builder = resolveFallback(secondReviewer.lease, "model_error", "2026-07-17T00:02:00.000Z");
    assert.equal(builder.action, "use_choice");
    assert.equal(builder.reviewFellBackToBuilder, true);
    const exhausted = resolveFallback(builder.lease, "model_error", "2026-07-17T00:03:00.000Z");
    assert.equal(exhausted.action, "skip_review");
  });
});
