import assert from "node:assert/strict";
import test from "node:test";
import {
  appendBoundedTail,
  boundContextForModel,
  clampThinkingLevel,
  excludeCurrentDelegationTurn,
  findRequestedModel,
  formatModelCatalog,
  parseClassifierDecision,
  parseModelRequest,
  safeTerminalText,
  supportedThinkingLevels,
  truncateMiddle,
} from "./helpers.ts";

test("classifier parser accepts fenced JSON and rejects invalid effort", () => {
  assert.deepEqual(
    parseClassifierDecision(
      'analysis\n```json\n{"model":"openai/gpt-5.6-luna","effort":"high","rationale":"hard"}\n```',
    ),
    { model: "openai/gpt-5.6-luna", effort: "high", rationale: "hard" },
  );
  assert.equal(parseClassifierDecision('{"model":"x/y","effort":"extreme"}'), undefined);
  assert.equal(parseClassifierDecision("not json"), undefined);
});

test("model requests parse effort suffixes without breaking provider ids that contain colons", () => {
  assert.deepEqual(parseModelRequest("openai-codex/gpt-5.6-luna:high"), {
    reference: "openai-codex/gpt-5.6-luna",
    effort: "high",
  });
  assert.deepEqual(parseModelRequest("amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0"), {
    reference: "amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0",
  });
});

test("model request resolution accepts qualified ids and preferred-provider bare ids", () => {
  const models = [
    { provider: "openai", id: "gpt-5.5" },
    { provider: "openai-codex", id: "gpt-5.5" },
    { provider: "openai-codex", id: "gpt-5.6-luna" },
  ];
  assert.deepEqual(findRequestedModel("openai-codex/gpt-5.5", models).model, models[1]);
  assert.deepEqual(findRequestedModel("gpt-5.5", models, "openai-codex").model, models[1]);
  assert.deepEqual(findRequestedModel("gpt-5.6-luna", models).model, models[2]);
  assert.match(findRequestedModel("gpt-5.5", models).error ?? "", /ambiguous/);
});

test("thinking support follows model maps and clamps safely", () => {
  const model = {
    provider: "test",
    id: "reasoner",
    reasoning: true,
    thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: null },
  };
  assert.deepEqual(supportedThinkingLevels(model), ["off", "low", "medium", "high", "xhigh"]);
  assert.equal(clampThinkingLevel("minimal", model), "low");
  assert.equal(clampThinkingLevel("max", model), "xhigh");
  assert.equal(clampThinkingLevel("high", { provider: "x", id: "plain", reasoning: false }), "off");
  const directLuna = {
    provider: "openai",
    id: "gpt-5.6-luna",
    reasoning: true,
    thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
  };
  assert.deepEqual(supportedThinkingLevels(directLuna), ["off", "low", "medium", "high", "xhigh"]);
  assert.equal(clampThinkingLevel("minimal", directLuna), "low");
  assert.equal(clampThinkingLevel("max", directLuna), "xhigh");
});

test("model catalog exposes exact ids, effort choices, context and cost", () => {
  const catalog = formatModelCatalog([
    {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
      reasoning: true,
      contextWindow: 272000,
      cost: { input: 2.5, output: 15 },
    },
  ]);
  assert.match(catalog, /openai-codex\/gpt-5\.6-luna/);
  assert.match(catalog, /effort=off\|minimal\|low\|medium\|high/);
  assert.match(catalog, /context=272000/);
  assert.match(catalog, /input=\$2\.5\/M/);
});

test("bounded text helpers retain useful tails without exceeding limits", () => {
  const source = `begin-${"x".repeat(500)}-end`;
  const compact = truncateMiddle(source, 120);
  assert.ok(compact.length <= 120);
  assert.match(compact, /^begin-/);
  assert.match(compact, /-end$/);
  assert.equal(appendBoundedTail("abcdef", "ghij", 5), "fghij");
});

test("terminal display text escapes controls without discarding safe surrounding lines", () => {
  const safe = safeTerminalText(
    "status: running\nchild: \u001b]8;;https://example.invalid\u0007link \u202e\nsummary: retained\n\0",
  );
  for (const codePoint of [0x1b, 0x07, 0x202e, 0x00]) {
    assert.equal(safe.includes(String.fromCodePoint(codePoint)), false);
  }
  // Assert the whole transformation rather than only the neighbouring lines: a
  // sanitizer that discarded the offending line outright, instead of escaping it
  // in place, would still satisfy per-line spot checks.
  assert.equal(
    safe,
    "status: running\n" +
      "child: [U+001B]]8;;https://example.invalid[U+0007]link [U+202E]\n" +
      "summary: retained\n" +
      "[U+0000]",
  );
});

test("current delegation turn is excluded from child context compaction", () => {
  const prior = { role: "assistant", content: "prior decision" };
  const currentUser = { role: "user", content: "create a subagent" };
  const toolCall = { role: "assistant", content: "subagent tool call" };
  assert.deepEqual(excludeCurrentDelegationTurn([prior, currentUser, toolCall]), [prior]);
  assert.deepEqual(excludeCurrentDelegationTurn([prior]), [prior]);
});

test("child context is bounded to a conservative fraction of its model window", () => {
  const summary = "x".repeat(50_000);
  const bounded = boundContextForModel(summary, "short task", {
    provider: "local",
    id: "small",
    contextWindow: 8_000,
  });
  assert.ok(bounded.length <= 9_590);
  assert.equal(
    boundContextForModel(summary, "x".repeat(10_000), {
      provider: "local",
      id: "tiny",
      contextWindow: 1_000,
    }),
    "",
  );
});

test("auth bridge forwards api key and headers, and rejects header injection", async () => {
  const { default: subagentAuthBridge } = await import("./auth-bridge.ts");
  /** @param {Record<string, string>} env */
  const run = (env) => {
    /** @type {[string, unknown][]} */
    const registered = [];
    Object.assign(process.env, env);
    const pi = /** @type {import("@earendil-works/pi-coding-agent").ExtensionAPI} */ (
      /** @type {unknown} */ ({
        /** @param {string} name @param {unknown} config */
        registerProvider: (name, config) => {
          registered.push([name, config]);
        },
      })
    );
    subagentAuthBridge(pi);
    for (const key of Object.keys(env)) delete process.env[key];
    return registered;
  };

  assert.deepEqual(
    run({
      PI_SIMPLE_SUBAGENT_AUTH_PROVIDER: "corporate-ai",
      PI_SIMPLE_SUBAGENT_API_KEY: "secret",
      PI_SIMPLE_SUBAGENT_AUTH_HEADERS: JSON.stringify({ Authorization: "Bearer secret" }),
    }),
    [["corporate-ai", { apiKey: "secret", headers: { Authorization: "Bearer secret" } }]],
  );
  assert.deepEqual(
    run({
      PI_SIMPLE_SUBAGENT_AUTH_PROVIDER: "corporate-ai",
      PI_SIMPLE_SUBAGENT_AUTH_HEADERS: JSON.stringify({ "X-Key": "abc" }),
    }),
    [["corporate-ai", { headers: { "X-Key": "abc" } }]],
  );
  assert.deepEqual(
    run({
      PI_SIMPLE_SUBAGENT_AUTH_PROVIDER: "corporate-ai",
      PI_SIMPLE_SUBAGENT_AUTH_HEADERS: JSON.stringify({ "X-Key": "abc\r\nX-Injected: 1" }),
    }),
    [],
  );
  assert.deepEqual(run({ PI_SIMPLE_SUBAGENT_AUTH_PROVIDER: "corporate-ai" }), []);
  assert.equal(process.env.PI_SIMPLE_SUBAGENT_API_KEY, undefined);
});

// `ExtensionContext.modelRegistry` is a synchronous compatibility facade whose
// underlying `ModelRuntime` is a private field. `modelRuntimeFromContext` in
// index.ts reaches it via `Reflect.get(ctx.modelRegistry, "runtime")` because Pi
// exposes no public accessor (checked against the minimum supported Pi 1.0.3). If a Pi upgrade renames or
// removes that field, targeted compaction silently falls back to fresh child
// context, so pin the shape here and fail loudly at test time instead.
test("Pi's ModelRegistry still exposes the ModelRuntime that compaction reaches for", async () => {
  const { ModelRegistry, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  assert.equal(Reflect.get(registry, "runtime"), runtime);
});
