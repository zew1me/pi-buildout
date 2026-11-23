import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { fauxAssistantMessage, fauxToolCall, getModel, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { conservativeFeatures } from "./core/features.ts";
import {
  classifyTaskSecondaryWithPi,
  classifyTaskWithPi,
  selectClassifierModels,
  transportFromCandidates,
} from "./pi-classifier.ts";

function model(provider, id) {
  return { provider, id };
}

function snapshot(provider, modelId, overrides = {}) {
  const canonicalId = modelId
    .replace(/^(?:us|eu|au|jp|apac|global)\./, "")
    .replace(/^(?:anthropic|openai|google)\./, "");
  const vendor = canonicalId.startsWith("claude-")
    ? "anthropic"
    : canonicalId.startsWith("gemini-")
      ? "google"
      : "openai";
  return {
    provider,
    modelId,
    name: modelId,
    vendor,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    available: true,
    reasoning: true,
    supportedEfforts: ["low"],
    inputTypes: ["text"],
    toolCapable: true,
    costPerMillion: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    ...overrides,
  };
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
      snapshot("openai-codex", "gpt-6-luna"),
      snapshot("anthropic", "claude-sonnet-5"),
    ]);
    assert.equal(selected.primary[0].model.id, "gpt-6-luna");
    assert.equal(selected.primary[0].vendor, "openai");
    assert.equal(selected.secondary[0].model.id, "claude-sonnet-5");
    assert.equal(selected.secondary[0].vendor, "anthropic");
  });

  it("does not downgrade the independent secondary from validated Sonnet to Haiku", () => {
    const selected = selectClassifierModels([
      snapshot("openai-codex", "gpt-6-luna"),
      snapshot("anthropic", "claude-haiku-4-5"),
    ]);
    assert.equal(selected.primary[0].model.id, "gpt-6-luna");
    assert.equal(selected.secondary.length, 0);
  });

  it("does not invent an unconfigured classifier model", () => {
    const selected = selectClassifierModels([snapshot("openai", "gpt-4o")]);
    assert.equal(selected.primary.length, 0);
    assert.equal(selected.secondary.length, 0);
  });

  it("still finds an independent secondary when the primary's vendor declares no tier", () => {
    // The secondary tier table is a partial map, so a vendor added to MODEL_VENDORS without its own
    // entry falls back to the shared tier list. Independence must still hold, which is enforced at
    // selection time rather than assumed from the table.
    const selected = selectClassifierModels([
      snapshot("openai-codex", "gpt-6-luna", { vendor: "moonshot" }),
      snapshot("anthropic", "claude-sonnet-5"),
      snapshot("openai-codex", "gpt-5.6-terra"),
    ]);
    assert.equal(selected.primary[0].vendor, "moonshot");
    assert.ok(selected.secondary.length > 0, "a vendor without its own tier must still get a secondary");
    assert.ok(
      selected.secondary.every((entry) => entry.vendor !== "moonshot"),
      "the secondary must never share the primary's vendor",
    );
  });

  it("never reconciles a primary against its own vendor", () => {
    // Both shared-fallback tiers are present, but one of them is the primary's own vendor and must be
    // filtered out rather than accepted as an independent second opinion.
    const selected = selectClassifierModels([
      snapshot("anthropic", "claude-haiku-4-5"),
      snapshot("anthropic", "claude-sonnet-5"),
      snapshot("openai-codex", "gpt-5.6-terra"),
    ]);
    assert.equal(selected.primary[0].vendor, "anthropic");
    assert.ok(
      selected.secondary.every((entry) => entry.vendor !== "anthropic"),
      "an Anthropic primary must not be reconciled by an Anthropic secondary",
    );
  });

  it("collects every configured Luna endpoint, including direct Amazon Bedrock, ahead of Haiku", () => {
    const selected = selectClassifierModels([
      snapshot("openai-codex", "gpt-6-luna"),
      snapshot("openai", "gpt-6-luna"),
      snapshot("amazon-bedrock", "openai.gpt-6-luna"),
      snapshot("anthropic", "claude-haiku-4-5"),
      snapshot("amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0"),
      snapshot("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0"),
    ]);
    assert.deepEqual(
      selected.primary.map((entry) => `${entry.model.provider}/${entry.model.id}`),
      [
        "openai-codex/gpt-6-luna",
        "amazon-bedrock/openai.gpt-6-luna",
        "openai/gpt-6-luna",
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
      snapshot("openai-codex", "gpt-6-luna"),
      snapshot("amazon-bedrock", "anthropic.claude-sonnet-5"),
    ]);
    assert.equal(openaiPrimary.secondary[0]?.model.id, "anthropic.claude-sonnet-5");
    assert.equal(openaiPrimary.secondary[0]?.model.provider, "amazon-bedrock");

    const anthropicPrimary = selectClassifierModels([
      snapshot("anthropic", "claude-haiku-4-5"),
      snapshot("amazon-bedrock", "openai.gpt-5.6-terra"),
    ]);
    assert.equal(anthropicPrimary.secondary[0]?.model.id, "openai.gpt-5.6-terra");
    assert.equal(anthropicPrimary.secondary[0]?.model.provider, "amazon-bedrock");
  });

  it("chooses both secondary logical tiers from the primary model vendor, not its endpoint provider", () => {
    const openaiSelected = selectClassifierModels([
      snapshot("amazon-bedrock", "openai.gpt-6-luna"),
      snapshot("amazon-bedrock", "anthropic.claude-sonnet-5"),
      snapshot("amazon-bedrock", "openai.gpt-5.6-terra"),
    ]);
    assert.equal(openaiSelected.primary[0]?.vendor, "openai");
    assert.deepEqual(
      openaiSelected.secondary.map((entry) => entry.model.id),
      ["anthropic.claude-sonnet-5"],
    );

    const anthropicSelected = selectClassifierModels([
      snapshot("amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0"),
      snapshot("amazon-bedrock", "anthropic.claude-sonnet-5"),
      snapshot("amazon-bedrock", "openai.gpt-5.6-terra"),
    ]);
    assert.equal(anthropicSelected.primary[0]?.vendor, "anthropic");
    assert.deepEqual(
      anthropicSelected.secondary.map((entry) => entry.model.id),
      ["openai.gpt-5.6-terra"],
    );
  });

  it("orders flat-rate endpoints after token-billed alternatives", () => {
    const selected = selectClassifierModels([
      snapshot("github-copilot", "gpt-6-luna"),
      snapshot("openai-codex", "gpt-6-luna"),
    ]);
    assert.deepEqual(
      selected.primary.map((entry) => entry.model.provider),
      ["openai-codex", "github-copilot"],
    );
    assert.equal(selected.primary[1]?.endpointEffectiveCost, undefined);
  });

  it("excludes endpoints that cannot serve the classifier's forced tool call", () => {
    // Classification is enforced through a forced tool call, so a non-tool-capable endpoint could
    // never satisfy this tier even when it is scoped in, healthy, and the cheapest candidate.
    const selected = selectClassifierModels([
      snapshot("amazon-bedrock", "openai.gpt-6-luna", {
        toolCapable: false,
        costPerMillion: { input: 0.01, output: 0.01, cacheRead: 0.001, cacheWrite: 0.01 },
      }),
      snapshot("openai-codex", "gpt-6-luna"),
    ]);
    assert.deepEqual(
      selected.primary.map((entry) => `${entry.model.provider}/${entry.model.id}`),
      ["openai-codex/gpt-6-luna"],
    );
  });

  it("declines classification when every scoped endpoint lacks tool support", () => {
    const selected = selectClassifierModels([
      snapshot("openai-codex", "gpt-6-luna", { toolCapable: false }),
      snapshot("anthropic", "claude-haiku-4-5", { toolCapable: false }),
    ]);
    assert.deepEqual(selected.primary, []);
    assert.deepEqual(selected.secondary, []);
  });

  it("excludes unavailable and recurring-failure endpoints but retains transient failures", () => {
    const selected = selectClassifierModels([
      snapshot("github-copilot", "gpt-6-luna", { available: false }),
      snapshot("openai", "gpt-6-luna", {
        health: { provider: "openai", modelId: "gpt-6-luna", status: "client_error" },
      }),
      snapshot("bifrost", "gpt-6-luna", {
        health: { provider: "bifrost", modelId: "gpt-6-luna", status: "failed" },
      }),
      snapshot("amazon-bedrock", "openai.gpt-6-luna", {
        health: { provider: "amazon-bedrock", modelId: "openai.gpt-6-luna", status: "server_error" },
      }),
      snapshot("google-vertex", "gpt-6-luna", {
        health: { provider: "google-vertex", modelId: "gpt-6-luna", status: "timeout" },
      }),
      snapshot("openai-codex", "gpt-6-luna"),
    ]);
    assert.deepEqual(
      selected.primary.map((entry) => `${entry.model.provider}/${entry.model.id}`),
      ["google-vertex/gpt-6-luna", "openai-codex/gpt-6-luna", "amazon-bedrock/openai.gpt-6-luna"],
    );
  });

  it("keeps an OpenAI primary when the scope serves only GPT-5.6 Luna", () => {
    // Amazon Bedrock and many registries still serve only the 5.6 generation. Requiring GPT-6 Luna
    // silently moved every primary onto Haiku, which in turn needed a scarce OpenAI secondary.
    const selected = selectClassifierModels([
      snapshot("amazon-bedrock", "global.openai.gpt-5.6-luna"),
      snapshot("openai-codex", "gpt-5.6-luna"),
      snapshot("anthropic", "claude-haiku-4-5"),
      snapshot("anthropic", "claude-sonnet-5"),
    ]);
    assert.equal(selected.primary[0]?.vendor, "openai");
    assert.equal(selected.primary.at(-1)?.model.id, "claude-haiku-4-5");
    assert.deepEqual(
      selected.primary
        .filter((entry) => entry.vendor === "openai")
        .map((entry) => entry.model.id)
        .sort(),
      ["global.openai.gpt-5.6-luna", "gpt-5.6-luna"],
    );
    assert.equal(selected.secondary[0]?.model.id, "claude-sonnet-5");
  });

  it("offers first-party Gemini as a third-vendor secondary after the other vendor's tiers", () => {
    const registry = [
      snapshot("github-copilot", "gemini-3.5-flash"),
      snapshot("github-copilot", "gemini-3.8-flash"),
      snapshot("google-vertex", "gemini-2.5-pro"),
      snapshot("amazon-bedrock", "us.openai.gpt-5.6-terra"),
      snapshot("anthropic", "claude-sonnet-5"),
    ];
    const anthropicPrimary = selectClassifierModels([snapshot("anthropic", "claude-haiku-4-5"), ...registry]);
    assert.deepEqual(
      anthropicPrimary.secondary.map((entry) => entry.model.id),
      ["us.openai.gpt-5.6-terra", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-2.5-pro"],
    );
    assert.ok(anthropicPrimary.secondary.every((entry) => entry.vendor !== "anthropic"));

    const openaiPrimary = selectClassifierModels([snapshot("openai-codex", "gpt-5.6-luna"), ...registry]);
    assert.deepEqual(
      openaiPrimary.secondary.map((entry) => entry.model.id),
      ["claude-sonnet-5", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-2.5-pro"],
    );
  });

  it("still reconciles a Haiku primary when Gemini is the only other vendor in scope", () => {
    const selected = selectClassifierModels([
      snapshot("anthropic", "claude-haiku-4-5"),
      snapshot("github-copilot", "gemini-3.6-flash"),
    ]);
    assert.deepEqual(
      selected.secondary.map((entry) => `${entry.vendor}/${entry.model.id}`),
      ["google/gemini-3.6-flash"],
    );
  });

  it("falls back to Gemini 3.5 Flash Lite as a last-resort primary with a non-Google secondary", () => {
    const selected = selectClassifierModels([
      snapshot("google-vertex", "gemini-3.5-flash-lite"),
      snapshot("anthropic", "claude-haiku-4-5"),
      snapshot("amazon-bedrock", "us.openai.gpt-5.6-terra"),
      snapshot("amazon-bedrock", "us.anthropic.claude-sonnet-5"),
    ]);
    assert.deepEqual(
      selected.primary.map((entry) => entry.model.id),
      ["claude-haiku-4-5", "gemini-3.5-flash-lite"],
    );

    const geminiOnly = selectClassifierModels([
      snapshot("google-vertex", "gemini-3.5-flash-lite"),
      snapshot("amazon-bedrock", "us.openai.gpt-5.6-terra"),
      snapshot("amazon-bedrock", "us.anthropic.claude-sonnet-5"),
    ]);
    assert.equal(geminiOnly.primary[0]?.vendor, "google");
    assert.deepEqual(
      geminiOnly.secondary.map((entry) => entry.model.id),
      ["us.openai.gpt-5.6-terra", "us.anthropic.claude-sonnet-5"],
    );
  });

  it("uses MAI-Code Flash as the primary after every Luna endpoint and before Haiku", () => {
    const mai = snapshot("github-copilot", "mai-code-1.1-flash", { vendor: "microsoft" });
    const selected = selectClassifierModels([
      snapshot("anthropic", "claude-haiku-4-5"),
      mai,
      snapshot("amazon-bedrock", "us.openai.gpt-5.6-luna"),
      snapshot("anthropic", "claude-sonnet-5"),
    ]);
    assert.deepEqual(
      selected.primary.map((entry) => entry.model.id),
      ["us.openai.gpt-5.6-luna", "mai-code-1.1-flash", "claude-haiku-4-5"],
    );

    // With no Luna in scope MAI leads, and its secondary must come from another vendor.
    const maiFirst = selectClassifierModels([
      mai,
      snapshot("anthropic", "claude-haiku-4-5"),
      snapshot("anthropic", "claude-sonnet-5"),
      snapshot("amazon-bedrock", "us.openai.gpt-5.6-terra"),
    ]);
    assert.equal(maiFirst.primary[0]?.vendor, "microsoft");
    assert.deepEqual(
      maiFirst.secondary.map((entry) => entry.model.id),
      ["claude-sonnet-5", "us.openai.gpt-5.6-terra"],
    );
  });

  it("places MAI-Code Flash last in the OpenAI and Google primaries' secondary tiers", () => {
    const mai = snapshot("github-copilot", "mai-code-1.1-flash", { vendor: "microsoft" });
    const openaiPrimary = selectClassifierModels([
      snapshot("openai-codex", "gpt-5.6-luna"),
      mai,
      snapshot("github-copilot", "gemini-3.8-flash"),
      snapshot("anthropic", "claude-sonnet-5"),
    ]);
    assert.equal(openaiPrimary.primary[0]?.vendor, "openai");
    assert.deepEqual(
      openaiPrimary.secondary.map((entry) => entry.model.id),
      ["claude-sonnet-5", "gemini-3.8-flash", "mai-code-1.1-flash"],
    );
  });

  it("places MAI-Code Flash after Terra and Sonnet for a Gemini-answered primary", async () => {
    const registryLookups = [];
    const features = conservativeFeatures("fixture");
    await classifyTaskSecondaryWithPi({
      ctx: {
        modelRegistry: {
          find: (provider, modelId) => {
            registryLookups.push(`${provider}/${modelId}`);
            return undefined;
          },
        },
      },
      registry: [
        snapshot("google-vertex", "gemini-3.5-flash-lite"),
        snapshot("github-copilot", "mai-code-1.1-flash", { vendor: "microsoft" }),
        snapshot("anthropic", "claude-sonnet-5"),
        snapshot("amazon-bedrock", "us.openai.gpt-5.6-terra"),
      ],
      prompt: "Implement the change",
      synopsis: {},
      primary: {
        features,
        primaryFeatures: features,
        escalated: true,
        failedClosed: false,
        attempts: [],
        primaryVendor: "google",
      },
    });
    assert.deepEqual(
      [...new Set(registryLookups)],
      ["amazon-bedrock/us.openai.gpt-5.6-terra", "anthropic/claude-sonnet-5", "github-copilot/mai-code-1.1-flash"],
    );
  });

  it("offers MAI-Code Flash as a last-resort secondary after Gemini for a Haiku-answered primary", async () => {
    const registryLookups = [];
    const features = conservativeFeatures("fixture");
    await classifyTaskSecondaryWithPi({
      ctx: {
        modelRegistry: {
          find: (provider, modelId) => {
            registryLookups.push(`${provider}/${modelId}`);
            return undefined;
          },
        },
      },
      registry: [
        snapshot("anthropic", "claude-haiku-4-5"),
        snapshot("github-copilot", "mai-code-1.1-flash", { vendor: "microsoft" }),
        snapshot("github-copilot", "gemini-3.8-flash"),
        snapshot("anthropic", "claude-sonnet-5"),
      ],
      prompt: "Implement the change",
      synopsis: {},
      primary: {
        features,
        primaryFeatures: features,
        escalated: true,
        failedClosed: false,
        attempts: [],
        primaryVendor: "anthropic",
      },
    });
    assert.deepEqual(
      [...new Set(registryLookups)],
      ["github-copilot/gemini-3.8-flash", "github-copilot/mai-code-1.1-flash"],
    );
  });

  it("prefers GPT-6 Luna over GPT-5.6 Luna for the primary tier", () => {
    const selected = selectClassifierModels([
      snapshot("openai-codex", "gpt-5.6-luna"),
      snapshot("openai-codex", "gpt-6-luna"),
    ]);
    assert.deepEqual(
      selected.primary.map((entry) => entry.model.id),
      ["gpt-6-luna", "gpt-5.6-luna"],
    );
  });

  it("returns no candidates when the scoped snapshot contains no classifier model", () => {
    const selected = selectClassifierModels([]);
    assert.deepEqual(selected, { primary: [], secondary: [] });
  });

  it("fails closed without consulting the registry when scope leaves no classifier endpoint", async () => {
    let registryLookups = 0;
    const observations = [];
    const result = await classifyTaskWithPi({
      ctx: {
        modelRegistry: {
          find: () => {
            registryLookups++;
            return undefined;
          },
        },
      },
      registry: [],
      prompt: "Implement the change",
      synopsis: {},
      onAttempt: (observation) => observations.push(observation),
    });
    assert.equal(result.failedClosed, true);
    assert.equal(registryLookups, 0);
    assert.equal(result.attempts.length, 2);
    assert.ok(result.attempts.every((attempt) => attempt.valid === false));
    assert.equal(observations.filter((observation) => observation.state === "started").length, 2);
    assert.equal(observations.filter((observation) => observation.outcome === "error").length, 2);
  });

  it("does not call an alternate endpoint when the provider returns an aborted response", async () => {
    const faux = registerFauxProvider({
      api: "router-classifier-abort-test",
      provider: "router-classifier-abort-test",
      models: [{ id: "abort-fixture" }],
    });
    faux.setResponses([fauxAssistantMessage([], { stopReason: "aborted" })]);
    const registryLookups = [];
    try {
      await assert.rejects(
        classifyTaskWithPi({
          ctx: {
            modelRegistry: {
              find: (provider, modelId) => {
                registryLookups.push(`${provider}/${modelId}`);
                return faux.getModel();
              },
              getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
            },
          },
          registry: [snapshot("a-primary", "gpt-6-luna"), snapshot("z-alternate", "gpt-6-luna")],
          prompt: "Implement the change",
          synopsis: {},
        }),
        (error) => error instanceof Error && error.name === "AbortError",
      );
      assert.deepEqual(registryLookups, ["a-primary/gpt-6-luna"]);
    } finally {
      faux.unregister();
    }
  });
});

describe("classifier request options", () => {
  it("sends low reasoning effort and forces the classifier tool in the Codex HTTP body", async (t) => {
    const model = getModel("openai-codex", "gpt-6-luna");
    const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }));
    const features = { ...conservativeFeatures("fixture"), confidence: 0.95, risk: "low" };
    const item = {
      type: "function_call",
      id: "fc_fixture",
      call_id: "call_fixture",
      name: "report_task_features",
      arguments: JSON.stringify(features),
    };
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { status: "completed" } },
    ];

    // Block the adapter's preferred WebSocket transport so the real SSE serializer reaches mocked fetch.
    t.mock.method(globalThis, "WebSocket", () => {
      throw new Error("WebSocket disabled for this fixture");
    });
    const fetch = t.mock.method(
      globalThis,
      "fetch",
      () =>
        new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const result = await classifyTaskWithPi({
      ctx: {
        modelRegistry: {
          find: () => model,
          getApiKeyAndHeaders: async () => ({
            ok: true,
            apiKey: `fixture.${claims.toString("base64")}.fixture`,
            baseUrl: "https://codex.invalid",
          }),
        },
      },
      registry: [snapshot("openai-codex", "gpt-6-luna")],
      prompt: "Implement the change",
      synopsis: {},
    });

    assert.equal(fetch.mock.callCount(), 1);
    const [, { headers, body }] = fetch.mock.calls[0].arguments;
    const payload = JSON.parse(headers.get("content-encoding") === "zstd" ? zstdDecompressSync(body).toString() : body);
    assert.equal(payload.reasoning?.effort, "low");
    assert.deepEqual(payload.tool_choice, { type: "function", name: "report_task_features" });
    assert.equal(result.failedClosed, false);
    assert.equal(result.attempts[0]?.valid, true);
  });
});

describe("classifier request authentication", () => {
  it("calls an endpoint whose registry auth resolves without an API key, such as Amazon Bedrock", async () => {
    // Bedrock authenticates through the ambient AWS credential chain, so the registry reports
    // `ok: true` with no `apiKey`. That must be sufficient to issue the classifier request.
    const faux = registerFauxProvider({
      api: "router-classifier-keyless-test",
      provider: "router-classifier-keyless-test",
      models: [{ id: "keyless-fixture" }],
    });
    const features = { ...conservativeFeatures("fixture"), confidence: 0.95, risk: "low" };
    let seenOptions;
    faux.setResponses([
      (_context, options) => {
        seenOptions = options;
        return fauxAssistantMessage([fauxToolCall("report_task_features", features)]);
      },
    ]);
    try {
      const result = await classifyTaskWithPi({
        ctx: {
          modelRegistry: {
            find: () => faux.getModel(),
            getApiKeyAndHeaders: async () => ({ ok: true }),
          },
        },
        registry: [snapshot("amazon-bedrock", "global.openai.gpt-5.6-luna")],
        prompt: "Implement the change",
        synopsis: {},
      });
      assert.equal(result.failedClosed, false);
      assert.equal(result.attempts[0]?.valid, true);
      assert.equal(result.attempts[0]?.provider, "amazon-bedrock");
      assert.equal(seenOptions.reasoning, "low");
      assert.ok(!Object.hasOwn(seenOptions, "reasoningEffort"));
    } finally {
      faux.unregister();
    }
  });

  it("sends the request to the base URL override resolved by the registry", async () => {
    const faux = registerFauxProvider({
      api: "router-classifier-baseurl-test",
      provider: "router-classifier-baseurl-test",
      models: [{ id: "baseurl-fixture" }],
    });
    const features = { ...conservativeFeatures("fixture"), confidence: 0.95, risk: "low" };
    let seenBaseUrl;
    faux.setResponses([
      (_context, _options, _state, model) => {
        seenBaseUrl = model.baseUrl;
        return fauxAssistantMessage([fauxToolCall("report_task_features", features)]);
      },
    ]);
    try {
      const result = await classifyTaskWithPi({
        ctx: {
          modelRegistry: {
            find: () => faux.getModel(),
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture", baseUrl: "https://gateway.example/v1" }),
          },
        },
        registry: [snapshot("amazon-bedrock", "global.openai.gpt-5.6-luna")],
        prompt: "Implement the change",
        synopsis: {},
      });
      assert.equal(result.attempts[0]?.valid, true);
      assert.equal(seenBaseUrl, "https://gateway.example/v1");
    } finally {
      faux.unregister();
    }
  });

  it("still skips an endpoint whose registry auth reports a failure", async () => {
    const result = await classifyTaskWithPi({
      ctx: {
        modelRegistry: {
          find: (provider, id) => ({ provider, id }),
          getApiKeyAndHeaders: async () => ({ ok: false, error: 'No API key found for "openai-codex"' }),
        },
      },
      registry: [snapshot("openai-codex", "gpt-5.6-luna")],
      prompt: "Implement the change",
      synopsis: {},
    });
    assert.equal(result.failedClosed, true);
    assert.ok(result.attempts.every((attempt) => attempt.valid === false));
  });
});

describe("classifyTaskSecondaryWithPi", () => {
  it("gives a Haiku-answered primary every scoped OpenAI secondary tier, Terra first", async () => {
    // With only one OpenAI tier, a rate-limited or unscoped Terra left the low-confidence safety
    // latch unresolved. Any OpenAI Luna in scope is still a vendor-independent second opinion.
    const registryLookups = [];
    const features = conservativeFeatures("fixture");
    await classifyTaskSecondaryWithPi({
      ctx: {
        modelRegistry: {
          find: (provider, modelId) => {
            registryLookups.push(`${provider}/${modelId}`);
            return undefined;
          },
        },
      },
      registry: [
        snapshot("anthropic", "claude-haiku-4-5"),
        snapshot("amazon-bedrock", "us.openai.gpt-5.6-luna"),
        snapshot("amazon-bedrock", "global.openai.gpt-5.6-terra"),
        snapshot("anthropic", "claude-sonnet-5"),
      ],
      prompt: "Implement the change",
      synopsis: {},
      primary: {
        features,
        primaryFeatures: features,
        escalated: true,
        failedClosed: false,
        attempts: [],
        primaryVendor: "anthropic",
      },
    });
    assert.deepEqual(
      [...new Set(registryLookups)],
      ["amazon-bedrock/global.openai.gpt-5.6-terra", "amazon-bedrock/us.openai.gpt-5.6-luna"],
    );
  });

  it("chooses the independent tier from the vendor that answered the primary, not the first candidate", async () => {
    const registryLookups = [];
    const features = conservativeFeatures("fixture");
    await classifyTaskSecondaryWithPi({
      ctx: {
        modelRegistry: {
          find: (provider, modelId) => {
            registryLookups.push(`${provider}/${modelId}`);
            return undefined;
          },
        },
      },
      registry: [
        snapshot("openai", "gpt-6-luna"),
        snapshot("anthropic", "claude-haiku-4-5"),
        snapshot("anthropic", "claude-sonnet-5"),
        snapshot("openai", "gpt-5.6-terra"),
      ],
      prompt: "Implement the change",
      synopsis: {},
      // Luna is the first primary candidate, but Haiku answered after Luna failed over.
      primary: {
        features,
        primaryFeatures: features,
        escalated: true,
        failedClosed: false,
        attempts: [],
        primaryVendor: "anthropic",
      },
    });
    assert.ok(registryLookups.length > 0, "the secondary stage must consult at least one endpoint");
    // Terra is tried first; when it fails the stage falls through to the other OpenAI tiers, but it
    // must never consult an Anthropic endpoint for an Anthropic-answered primary.
    assert.deepEqual([...new Set(registryLookups)], ["openai/gpt-5.6-terra", "openai/gpt-6-luna"]);
  });
});

describe("transportFromCandidates", () => {
  it("falls back to the next configured endpoint when the first is rate limited", async () => {
    const attempted = [];
    const transport = transportFromCandidates(
      [candidate("openai-codex", "gpt-6-luna", "openai"), candidate("openai", "gpt-6-luna", "openai")],
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
      candidate("openai-codex", "gpt-6-luna", "openai"),
      candidate("openai", "gpt-6-luna", "openai"),
      candidate("amazon-bedrock", "openai.gpt-6-luna", "openai"),
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
    const candidates = [candidate("openai-codex", "gpt-6-luna", "openai"), candidate("openai", "gpt-6-luna", "openai")];
    const transport = transportFromCandidates(candidates, async (candidateEntry) => {
      throw rateLimitError(candidateEntry.model.provider);
    });

    await assert.rejects(transport(request()), (error) => {
      assert.match(error.message, /openai-codex\/gpt-6-luna/);
      assert.match(error.message, /openai\/gpt-6-luna/);
      assert.match(error.message, /rate limit/);
      return true;
    });
  });

  it("does not retry another endpoint after the caller aborts the request", async () => {
    const attempted = [];
    const candidates = [candidate("openai-codex", "gpt-6-luna", "openai"), candidate("openai", "gpt-6-luna", "openai")];
    const transport = transportFromCandidates(candidates, async (candidateEntry) => {
      attempted.push(candidateEntry.model.provider);
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    });

    await assert.rejects(transport(request()), /aborted/i);
    assert.deepEqual(attempted, ["openai-codex"]);
  });

  it("does not retry another endpoint after a transport timeout", async () => {
    const attempted = [];
    const candidates = [candidate("openai-codex", "gpt-6-luna", "openai"), candidate("openai", "gpt-6-luna", "openai")];
    const timeout = new Error("Classifier transport timed out");
    timeout.name = "TimeoutError";
    const transport = transportFromCandidates(candidates, async (candidateEntry) => {
      attempted.push(candidateEntry.model.provider);
      throw timeout;
    });

    await assert.rejects(transport(request()), (error) => error === timeout);
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
