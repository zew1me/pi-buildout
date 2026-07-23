import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conservativeFeatures } from "./features.ts";
import {
  changeEffortWithinLease,
  createTaskLease,
  deterministicBoundaryGate,
  hasSignificantReusableCache,
  installLease,
  markManualOverride,
  resolveContinuity,
  setHardBoundary,
} from "./lease.ts";

function lease() {
  return createTaskLease({
    taskId: "task-1",
    startedAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    archetype: "median_repository_implementation",
    features: {
      ...conservativeFeatures(),
      intent: "implement",
      workflowType: "coding_implementation",
      horizon: "single_pr",
      risk: "medium",
      ambiguity: "low",
    },
    selected: {
      provider: "openai-codex",
      modelId: "gpt-5.6-terra",
      vendor: "openai",
      effort: "medium",
      ability: 2,
      profileId: "openai-gpt-5.6-agent-v1",
      contextWindow: 372_000,
      rankReason: "bootstrap",
    },
    fallbacks: [],
    modelSnapshotId: "snapshot",
    policyVersion: "policy",
    lastPromptFingerprint: "abc",
  });
}

describe("task boundary gate", () => {
  it("never reevaluates on a non-user turn", () => {
    const active = lease();
    assert.deepEqual(
      deterministicBoundaryGate(
        { mode: "active", active, manualOverride: false },
        {
          isUserInput: false,
          source: "interactive",
          prompt: "new task",
          cachedTokens: 0,
          expectedReuseRatio: 0,
        },
      ),
      { action: "ignore", reason: "lease evaluation is user-turn-only" },
    );
  });

  it("forces the first user turn after every hard boundary to a new task", () => {
    const active = lease();
    for (const boundary of ["new_session", "post_compaction", "post_push", "subagent"]) {
      const state = setHardBoundary({ mode: "active", active, manualOverride: false }, boundary);
      const result = deterministicBoundaryGate(state, {
        isUserInput: true,
        source: "interactive",
        prompt: "continue",
        cachedTokens: 100_000,
        expectedReuseRatio: 1,
      });
      assert.equal(result.action, "new_task");
      assert.equal(result.hardBoundary, boundary);
    }
  });

  it("keeps extension and queued follow-up messages in the existing lease", () => {
    const active = lease();
    for (const input of [
      { source: "extension", streamingBehavior: undefined },
      { source: "interactive", streamingBehavior: "followUp" },
    ]) {
      const result = deterministicBoundaryGate(
        { mode: "active", active, manualOverride: false },
        {
          isUserInput: true,
          ...input,
          prompt: "Do something unrelated",
          cachedTokens: 0,
          expectedReuseRatio: 0,
        },
      );
      assert.equal(result.action, "continue");
      assert.equal(result.lease.taskId, active.taskId);
    }
  });

  it("lets strong discontinuity override cache but resists a marginal switch", () => {
    const active = lease();
    const marginal = resolveContinuity(
      active,
      {
        ...active.features,
        taskContinuity: "new_task",
        confidence: 0.82,
        ambiguity: "medium",
      },
      { cachedTokens: 20_000, expectedReuseRatio: 0.5 },
    );
    assert.equal(marginal.action, "continue");
    const strong = resolveContinuity(
      active,
      { ...active.features, taskContinuity: "strong_discontinuity" },
      { cachedTokens: 100_000, expectedReuseRatio: 1 },
    );
    assert.equal(strong.action, "new_task");
    assert.equal(hasSignificantReusableCache(19_999, 1), false);
  });

  it("starts implementation under a lease separate from planning", () => {
    const active = {
      ...lease(),
      archetype: "implementation_planning",
      features: { ...lease().features, intent: "plan", workflowType: "implementation_planning" },
    };
    for (const prompt of ["Implement the plan.", "Start building PR one", "Now execute it"]) {
      const result = deterministicBoundaryGate(
        { mode: "active", active, manualOverride: false },
        {
          isUserInput: true,
          source: "interactive",
          prompt,
          cachedTokens: 100_000,
          expectedReuseRatio: 1,
        },
      );
      assert.equal(result.action, "new_task");
      assert.match(result.reason, /separate leases/);
    }
  });

  it("honors manual override until a hard boundary", () => {
    const active = lease();
    const overridden = markManualOverride({ mode: "active", active, manualOverride: false });
    const result = deterministicBoundaryGate(overridden, {
      isUserInput: true,
      source: "interactive",
      prompt: "Please inspect another file in this work",
      cachedTokens: 0,
      expectedReuseRatio: 0,
    });
    assert.equal(result.action, "continue");
    assert.match(result.reason, /manual/);
    const installed = installLease(setHardBoundary(overridden, "new_session"), active);
    assert.equal(installed.manualOverride, false);
    assert.equal("pendingHardBoundary" in installed, false);
  });
});

describe("effort changes", () => {
  it("preserves task/model/profile identity inside a lease", () => {
    const active = lease();
    const changed = changeEffortWithinLease(active, "high", "2026-07-17T00:01:00.000Z");
    assert.equal(changed.success, true);
    assert.equal(changed.lease.taskId, active.taskId);
    assert.equal(changed.lease.selected.modelId, active.selected.modelId);
    assert.equal(changed.lease.promptProfileId, active.promptProfileId);
    assert.equal(changed.lease.selected.effort, "high");
  });
});
