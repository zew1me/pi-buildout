import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conservativeFeatures } from "./core/features.ts";
import { createTaskLease } from "./core/lease.ts";
import { selectReviewRoute } from "./core/routing.ts";
import {
  cacheEstimate,
  estimateFinishedTokens,
  latestReportedContextTokens,
  modelAbility,
  normalizeSessionEntries,
  promptFingerprint,
  readRepositoryMetadata,
  restoreLeaseState,
} from "./pi-state.ts";

describe("modelAbility", () => {
  it("defers to the authoritative policy table for known (model, effort) pairs", () => {
    // Per-model effort scaling: sonnet-5 and gemini-3.5-flash gain a tier at
    // "high", while terra does not (see core/policy.ts).
    assert.equal(modelAbility("claude-sonnet-5", "high"), 3);
    assert.equal(modelAbility("gemini-3.5-flash", "high"), 3);
    assert.equal(modelAbility("gpt-5.6-terra", "high"), 2);
    assert.equal(modelAbility("claude-sonnet-5", "medium"), 2);
    assert.equal(modelAbility("gemini-2.5-flash", "high"), 2);
    assert.equal(modelAbility("bedrock/anthropic.claude-sonnet-5", "high"), 3);
    assert.equal(modelAbility("gpt-5.6-sol", "max"), 4);
  });

  it("falls back to the heuristic for pairs the policy table does not know", () => {
    assert.equal(modelAbility("claude-haiku-4-5", "medium"), 1);
    assert.equal(modelAbility("some-unknown-mini", "low"), 1);
    assert.equal(modelAbility("some-unknown-pro", "medium"), 4);
    assert.equal(modelAbility("some-unknown-model", "max"), 3);
  });

  it("selects ability-3 reviewers end to end for a sonnet-5 high builder", () => {
    // Regression for the original skew: the heuristic rated claude-sonnet-5@high
    // as ability 2, which routed review to gpt-5.6-terra@high and
    // gemini-3.5-flash@medium instead of the ability-3 tiers.
    const registryModel = (provider, modelId, vendor) => ({
      provider,
      modelId,
      name: modelId,
      vendor,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      available: true,
      reasoning: true,
      supportedEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      inputTypes: ["text", "image"],
      toolCapable: true,
      costPerMillion: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
    });
    const registry = [
      registryModel("openai-codex", "gpt-5.6-terra", "openai"),
      registryModel("openai-codex", "gpt-5.6-sol", "openai"),
      registryModel("anthropic", "claude-sonnet-5", "anthropic"),
      registryModel("github-copilot", "gemini-3.5-flash", "google"),
    ];
    const builder = registry.find((candidate) => candidate.modelId === "claude-sonnet-5");
    const decision = selectReviewRoute(
      registry,
      { estimatedFinishedTokens: 50_000, requiresImages: false, requiresTools: true },
      builder,
      "high",
      modelAbility("claude-sonnet-5", "high"),
    );
    assert.equal(decision.kind, "review");
    const reviewers = new Map([decision.primary, decision.fallback].map((choice) => [choice.vendor, choice]));
    assert.equal(reviewers.get("openai").modelId, "gpt-5.6-sol");
    assert.equal(reviewers.get("google").modelId, "gemini-3.5-flash");
    for (const choice of reviewers.values()) {
      assert.equal(choice.effort, "high");
      assert.equal(choice.ability, 3);
    }
    assert.deepEqual(decision.ceilingMismatchVendors, []);
  });
});

describe("normalizeSessionEntries", () => {
  it("extracts bounded semantic state and tool paths from pi entries", () => {
    const entries = normalizeSessionEntries([
      { type: "message", message: { role: "user", content: "Implement it" } },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call-1", name: "edit", arguments: { path: "src/a.ts" } }],
        },
      },
      {
        type: "message",
        message: { role: "toolResult", toolCallId: "call-1", toolName: "edit", isError: false },
      },
      {
        type: "compaction",
        summary: "Decision: use TypeBox",
        details: { readFiles: ["README.md"], modifiedFiles: ["src/a.ts"] },
      },
    ]);
    assert.deepEqual(entries[0], { kind: "user", text: "Implement it" });
    assert.deepEqual(entries[2], { kind: "tool", toolName: "edit", path: "src/a.ts", isError: false });
    assert.deepEqual(entries[3].modifiedFiles, ["src/a.ts"]);
  });
});

describe("lease restoration and context estimates", () => {
  it("restores only router-authored state entries", () => {
    const state = restoreLeaseState(
      [
        { type: "custom", customType: "other", data: { mode: "active" } },
        { type: "custom", customType: "model-router-state", data: { mode: "active", manualOverride: true } },
      ],
      "shadow",
    );
    assert.deepEqual(state, { mode: "active", manualOverride: true });

    const active = createTaskLease({
      taskId: "task",
      startedAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      archetype: "highest_risk_advisory",
      features: conservativeFeatures(),
      selected: {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        vendor: "openai",
        effort: "max",
        ability: 4,
        profileId: "openai-gpt-5.6-agent-v1",
        contextWindow: 1_000_000,
        rankReason: "bootstrap",
      },
      fallbacks: [
        {
          provider: "anthropic",
          modelId: "claude-opus-4-8",
          vendor: "anthropic",
          effort: "high",
          ability: 3,
          profileId: "anthropic-claude-planning-v1",
          contextWindow: 1_000_000,
          rankReason: "bootstrap",
        },
      ],
      modelSnapshotId: "snapshot",
      policyVersion: "policy",
      lastPromptFingerprint: "fingerprint",
    });
    const restored = restoreLeaseState(
      [{ type: "custom", customType: "model-router-state", data: { mode: "active", active } }],
      "shadow",
    );
    assert.equal(restored.active.taskId, "task");
    const tampered = structuredClone(active);
    tampered.selected.modelId = "unknown-model";
    assert.equal(
      restoreLeaseState(
        [{ type: "custom", customType: "model-router-state", data: { mode: "active", active: tampered } }],
        "shadow",
      ).active,
      undefined,
    );
  });

  it("adds deterministic tool, response, change, and compaction reserves", () => {
    const estimate = estimateFinishedTokens(10_000, {
      expectedToolOutputTokens: 20_000,
      expectedAgentTurns: 4,
      expectedFilesChanged: 2,
    });
    assert.equal(estimate, 54_384);
    assert.equal(promptFingerprint("same"), promptFingerprint("same"));
    assert.notEqual(promptFingerprint("same"), promptFingerprint("different"));
  });

  it("derives cache value from the latest assistant usage", () => {
    const entries = [
      {
        type: "message",
        message: { role: "assistant", usage: { input: 40_000, cacheRead: 25_000, output: 2_000 } },
      },
    ];
    assert.deepEqual(cacheEstimate(entries), { cachedTokens: 25_000, expectedReuseRatio: 0.625 });
    assert.equal(latestReportedContextTokens(entries), 67_000);
  });
});

describe("readRepositoryMetadata", () => {
  it("uses git state and deterministic language buckets", async () => {
    const outputs = new Map([
      ["rev-parse --show-toplevel", "/repo"],
      ["rev-parse HEAD", "abc"],
      ["rev-parse --verify @{upstream}", "def"],
      ["status --porcelain=v1 --untracked-files=normal", " M src/a.ts\n?? src/new.py"],
      ["ls-files", "src/a.ts\nsrc/new.py\napp/Main.kt\nscripts/deploy.sh\nREADME.md"],
    ]);
    const metadata = await readRepositoryMetadata(
      {
        exec: async (_command, args) => {
          const key = args.slice(2).join(" ");
          return { code: 0, stdout: outputs.get(key) ?? "", stderr: "", killed: false };
        },
      },
      "/repo",
    );
    assert.equal(metadata.upstream, "def");
    assert.deepEqual(metadata.changedFiles, ["src/a.ts", "src/new.py"]);
    assert.deepEqual(metadata.languageBuckets, ["kotlin", "python", "shell", "typescript"]);
  });
});
