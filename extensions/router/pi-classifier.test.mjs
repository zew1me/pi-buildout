import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectClassifierModels, transportFromCandidates } from "./pi-classifier.ts";

function model(provider, id) {
  return { provider, id };
}

function candidate(provider, id, vendor) {
  return { model: model(provider, id), vendor };
}

function request(stage = "primary") {
  return {
    stage,
    systemPrompt: "system",
    userPrompt: "user",
    toolName: "report_task_features",
    toolSchema: {},
  };
}

function rateLimitError(provider) {
  const error = new Error(`${provider}: 429 Too Many Requests - rate limit exceeded`);
  error.status = 429;
  return error;
}

describe("selectClassifierModels", () => {
  it("selects exact configured IDs from different model vendors", () => {
    const selected = selectClassifierModels([
      model("openai-codex", "gpt-5.6-luna"),
      model("anthropic", "claude-sonnet-5"),
    ]);
    assert.equal(selected.primary[0].model.id, "gpt-5.6-luna");
    assert.equal(selected.primary[0].vendor, "openai");
    assert.equal(selected.secondary[0].model.id, "claude-sonnet-5");
    assert.equal(selected.secondary[0].vendor, "anthropic");
  });

  it("does not downgrade the independent secondary from validated Sonnet to Haiku", () => {
    const selected = selectClassifierModels([
      model("openai-codex", "gpt-5.6-luna"),
      model("anthropic", "claude-haiku-4-5"),
    ]);
    assert.equal(selected.primary[0].model.id, "gpt-5.6-luna");
    assert.equal(selected.secondary.length, 0);
  });

  it("does not invent an unconfigured classifier model", () => {
    const selected = selectClassifierModels([model("openai", "gpt-4o")]);
    assert.equal(selected.primary.length, 0);
    assert.equal(selected.secondary.length, 0);
  });

  it("collects every configured Luna endpoint, including direct Amazon Bedrock, ahead of Haiku", () => {
    const selected = selectClassifierModels([
      model("openai-codex", "gpt-5.6-luna"),
      model("openai", "gpt-5.6-luna"),
      model("amazon-bedrock", "openai.gpt-5.6-luna"),
      model("anthropic", "claude-haiku-4-5"),
      model("amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0"),
      model("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0"),
    ]);
    assert.deepEqual(
      selected.primary.map((entry) => `${entry.model.provider}/${entry.model.id}`),
      [
        "openai-codex/gpt-5.6-luna",
        "openai/gpt-5.6-luna",
        "amazon-bedrock/openai.gpt-5.6-luna",
        "anthropic/claude-haiku-4-5",
        "amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0",
        "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
      ],
    );
    // The vendor guess for secondary selection follows the highest-priority tier (Luna/openai),
    // even though multiple endpoints across two vendors were configured.
    assert.equal(selected.primary[0].vendor, "openai");
  });

  it("offers Amazon Bedrock as a secondary endpoint alternative for Sonnet and Terra", () => {
    const openaiPrimary = selectClassifierModels([
      model("openai-codex", "gpt-5.6-luna"),
      model("amazon-bedrock", "anthropic.claude-sonnet-5"),
    ]);
    assert.equal(openaiPrimary.secondary[0]?.model.id, "anthropic.claude-sonnet-5");
    assert.equal(openaiPrimary.secondary[0]?.model.provider, "amazon-bedrock");

    const anthropicPrimary = selectClassifierModels([
      model("anthropic", "claude-haiku-4-5"),
      model("amazon-bedrock", "openai.gpt-5.6-terra"),
    ]);
    assert.equal(anthropicPrimary.secondary[0]?.model.id, "openai.gpt-5.6-terra");
    assert.equal(anthropicPrimary.secondary[0]?.model.provider, "amazon-bedrock");
  });
});

describe("transportFromCandidates", () => {
  it("falls back to the next configured endpoint when the first is rate limited", async () => {
    const attempted = [];
    const transport = transportFromCandidates(
      [candidate("openai-codex", "gpt-5.6-luna", "openai"), candidate("openai", "gpt-5.6-luna", "openai")],
      async (candidateEntry) => {
        attempted.push(candidateEntry.model.provider);
        if (candidateEntry.model.provider === "openai-codex") throw rateLimitError("openai-codex");
        return {
          arguments: { ok: true },
          provider: candidateEntry.model.provider,
          modelId: candidateEntry.model.id,
          vendor: candidateEntry.vendor,
          latencyMs: 10,
        };
      },
    );

    const result = await transport(request());
    assert.deepEqual(attempted, ["openai-codex", "openai"]);
    assert.equal(result.provider, "openai");
  });

  it("tries every Luna endpoint before falling through to the Haiku tier", async () => {
    const attempted = [];
    const candidates = [
      candidate("openai-codex", "gpt-5.6-luna", "openai"),
      candidate("openai", "gpt-5.6-luna", "openai"),
      candidate("amazon-bedrock", "openai.gpt-5.6-luna", "openai"),
      candidate("anthropic", "claude-haiku-4-5", "anthropic"),
      candidate("amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0", "anthropic"),
    ];
    const transport = transportFromCandidates(candidates, async (candidateEntry) => {
      attempted.push(candidateEntry.model.provider);
      if (candidateEntry.vendor === "openai") throw rateLimitError(candidateEntry.model.provider);
      return {
        arguments: { ok: true },
        provider: candidateEntry.model.provider,
        modelId: candidateEntry.model.id,
        vendor: candidateEntry.vendor,
        latencyMs: 10,
      };
    });

    const result = await transport(request());
    assert.deepEqual(attempted, ["openai-codex", "openai", "amazon-bedrock", "anthropic"]);
    assert.equal(result.provider, "anthropic");
    assert.equal(result.modelId, "claude-haiku-4-5");
  });

  it("throws an aggregated error naming every failed endpoint when the whole tier list is exhausted", async () => {
    const candidates = [
      candidate("openai-codex", "gpt-5.6-luna", "openai"),
      candidate("openai", "gpt-5.6-luna", "openai"),
    ];
    const transport = transportFromCandidates(candidates, async (candidateEntry) => {
      throw rateLimitError(candidateEntry.model.provider);
    });

    await assert.rejects(transport(request()), (error) => {
      assert.match(error.message, /openai-codex\/gpt-5\.6-luna/);
      assert.match(error.message, /openai\/gpt-5\.6-luna/);
      assert.match(error.message, /rate limit/);
      return true;
    });
  });

  it("does not retry another endpoint after the caller aborts the request", async () => {
    const attempted = [];
    const candidates = [
      candidate("openai-codex", "gpt-5.6-luna", "openai"),
      candidate("openai", "gpt-5.6-luna", "openai"),
    ];
    const transport = transportFromCandidates(candidates, async (candidateEntry) => {
      attempted.push(candidateEntry.model.provider);
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    });

    await assert.rejects(transport(request()), /aborted/i);
    assert.deepEqual(attempted, ["openai-codex"]);
  });

  it("throws immediately when no endpoint is configured for the required stage", async () => {
    const transport = transportFromCandidates([], async () => {
      throw new Error("should never be called");
    });
    await assert.rejects(
      transport(request("secondary")),
      /No configured secondary classifier from the required vendor/,
    );
  });
});
