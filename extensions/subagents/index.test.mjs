import assert from "node:assert/strict";
import test from "node:test";
import {
  appendBoundedTail,
  boundContextForModel,
  buildChildArgs,
  clampThinkingLevel,
  escalationGate,
  excludeCurrentDelegationTurn,
  findRequestedModel,
  formatModelCatalog,
  isEscalationClassModel,
  modelStrengthRank,
  parseClassifierDecision,
  parseRouterDecision,
  readRegisteredRouter,
  ROUTING_LADDER_GUIDANCE,
  routingCeiling,
  SUBAGENT_ROUTER_KEY,
  parseModelRequest,
  resolveCandidateModel,
  resolveRoutedEffort,
  routingCandidates,
  safeTerminalText,
  scopeFallbackModel,
  scopedThinkingLevel,
  serializeModelScope,
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

test("routing candidates honor a nonempty session scope and otherwise use available models", () => {
  const gpt54 = { provider: "openai-codex", id: "gpt-5.4" };
  const luna = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const available = [gpt54, luna];
  /** @type {import("./helpers.ts").ScopedModelLike[]} */
  const scopedModels = [{ model: luna, thinkingLevel: "high" }];

  assert.deepEqual(routingCandidates(scopedModels, available), {
    candidates: [luna],
    scoped: true,
  });
  assert.deepEqual(routingCandidates([], available), { candidates: available, scoped: false });
});

test("strict candidate resolution rejects out-of-scope explicit and classifier model ids", () => {
  const scoped = [
    { provider: "openai-codex", id: "gpt-5.6-luna" },
    { provider: "openai-codex", id: "gpt-5.6-terra" },
  ];

  assert.equal(resolveCandidateModel("gpt-5.6-luna", scoped, "openai-codex", true).model, scoped[0]);
  const rejected = resolveCandidateModel("openai-codex/gpt-5.4", scoped, "openai-codex", true);
  assert.equal(rejected.model, undefined);
  assert.match(rejected.error ?? "", /outside this session's model scope/);
  assert.match(rejected.error ?? "", /gpt-5\.6-luna/);
  assert.equal(resolveCandidateModel("openai-codex/gpt-5.4", scoped, "openai-codex", false).model, undefined);
  assert.doesNotMatch(
    resolveCandidateModel("openai-codex/gpt-5.4", scoped, "openai-codex", false).error ?? "",
    /scope/,
  );
});

test("scope fallback keeps the parent when eligible and otherwise chooses the first scoped model", () => {
  const parent = { provider: "openai-codex", id: "gpt-5.4" };
  const luna = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const terra = { provider: "openai-codex", id: "gpt-5.6-terra" };
  const scope = [{ model: luna }, { model: terra }];

  assert.deepEqual(scopeFallbackModel(luna, scope), { model: luna, substitutedParent: false });
  assert.deepEqual(scopeFallbackModel(parent, scope), { model: luna, substitutedParent: true });
  assert.deepEqual(scopeFallbackModel(parent, []), { model: parent, substitutedParent: false });
});

test("scoped effort pins override classification, yield to explicit effort, and are clamped", () => {
  const model = {
    provider: "test",
    id: "reasoner",
    reasoning: true,
    thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: null },
  };
  /** @type {import("./helpers.ts").ScopedModelLike[]} */
  const scoped = [{ model, thinkingLevel: "minimal" }];

  assert.equal(scopedThinkingLevel(model, scoped), "minimal");
  assert.equal(resolveRoutedEffort(model, scoped, "medium", "high"), "low");
  assert.equal(resolveRoutedEffort(model, scoped, "medium", "high", "xhigh"), "xhigh");
  assert.equal(resolveRoutedEffort(model, [], "medium", "high"), "high");
  assert.equal(resolveRoutedEffort(model, [], "medium"), "medium");
});

test("serialized model scope preserves pins and child arguments propagate it", () => {
  const luna = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const bedrock = { provider: "amazon-bedrock", id: "anthropic.claude-v1:0" };
  /** @type {import("./helpers.ts").ScopedModelLike[]} */
  const scope = [
    { model: luna, thinkingLevel: "high" },
    { model: bedrock, thinkingLevel: "low" },
    { model: luna, thinkingLevel: "max" },
    { model: { provider: "invalid", id: "comma,id" } },
  ];
  const serialized = serializeModelScope(scope, luna);
  assert.equal(serialized, "openai-codex/gpt-5.6-luna:high,amazon-bedrock/anthropic.claude-v1:0:low");

  const args = buildChildArgs({
    sessionDir: "/tmp/session",
    name: "reviewer",
    model: luna,
    effort: "high",
    modelScope: serialized,
    extensionPaths: ["/tmp/subagents.ts", "/tmp/auth-bridge.ts"],
    approve: false,
  });
  assert.deepEqual(args.slice(args.indexOf("--models"), args.indexOf("--models") + 2), ["--models", serialized]);
  assert.deepEqual(args.slice(-5), [
    "--extension",
    "/tmp/subagents.ts",
    "--extension",
    "/tmp/auth-bridge.ts",
    "--no-approve",
  ]);
  assert.equal(
    buildChildArgs({
      sessionDir: "/tmp/session",
      name: "reviewer",
      model: luna,
      effort: "high",
      extensionPaths: [],
      approve: true,
    }).includes("--models"),
    false,
  );
});

test("selected comma-bearing model ids fail instead of launching an unscoped child", () => {
  const model = { provider: "invalid", id: "comma,id" };
  assert.throws(() => serializeModelScope([{ model }], model), /cannot be propagated/);
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
  const model = {
    provider: "openai-codex",
    id: "gpt-5.6-luna",
    reasoning: true,
    contextWindow: 272000,
    cost: { input: 2.5, output: 15 },
  };
  const catalog = formatModelCatalog([model], [{ model, thinkingLevel: "high" }]);
  assert.match(catalog, /openai-codex\/gpt-5\.6-luna/);
  assert.match(catalog, /effort=off\|minimal\|low\|medium\|high/);
  assert.match(catalog, /effort-pin=high/);
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
// exposes no public accessor (checked through 0.84.2). If a Pi upgrade renames or
// removes that field, targeted compaction silently falls back to fresh child
// context, so pin the shape here and fail loudly at test time instead.
test("Pi's ModelRegistry still exposes the ModelRuntime that compaction reaches for", async () => {
  const { ModelRegistry, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  assert.equal(Reflect.get(registry, "runtime"), runtime);
});

test("escalation-class detection matches the Astra family across every provider that exposes it", () => {
  for (const model of [
    { provider: "openai", id: "gpt-6-astra" },
    { provider: "openrouter", id: "openai/gpt-6-astra" },
    { provider: "vercel-ai-gateway", id: "astra-fast" },
    { provider: "openrouter", id: "astra-pro" },
  ]) {
    assert.equal(isEscalationClassModel(model), true, `${model.provider}/${model.id} should be escalation class`);
  }
  for (const model of [
    { provider: "openai", id: "gpt-5.6-sol" },
    { provider: "openai", id: "gpt-5.6-terra" },
    { provider: "openai", id: "gpt-5.4-mini" },
    { provider: "meta", id: "muse-spark-1.3" },
  ]) {
    assert.equal(isEscalationClassModel(model), false, `${model.provider}/${model.id} should not be escalation class`);
  }
});

test("gpt-5.4-mini ranks below Luna because it is dominated head-to-head, not by price", () => {
  const luna = { provider: "openai", id: "gpt-5.6-luna", cost: { input: 0.2, output: 1.2 } };
  const mini = { provider: "openai", id: "gpt-5.4-mini", cost: { input: 0.75, output: 4.5 } };
  // Price alone would order these backwards: mini costs 3.75x more per token.
  assert.ok(mini.cost.output > luna.cost.output);
  assert.ok(modelStrengthRank(mini) < modelStrengthRank(luna));
  const sol = { provider: "openai", id: "gpt-5.6-sol" };
  const terra = { provider: "openai", id: "gpt-5.6-terra" };
  const astra = { provider: "openai", id: "gpt-6-astra" };
  assert.ok(modelStrengthRank(luna) < modelStrengthRank(terra));
  assert.ok(modelStrengthRank(terra) < modelStrengthRank(sol));
  assert.ok(modelStrengthRank(sol) < modelStrengthRank(astra));
  // An unknown expensive model must not outrank the frontier tier.
  const unknown = { provider: "other", id: "mystery-1", cost: { input: 500, output: 900 } };
  assert.ok(modelStrengthRank(unknown) < modelStrengthRank(astra));
});

test("the routing ceiling excludes escalation models and uses the highest effort Sol truly supports", () => {
  const luna = { provider: "openai", id: "gpt-5.6-luna" };
  const sol = { provider: "openai", id: "gpt-5.6-sol" };
  const astra = { provider: "openai", id: "gpt-6-astra" };
  const ceiling = routingCeiling([luna, astra, sol]);
  assert.deepEqual(ceiling?.model, sol);
  // The direct OpenAI GPT-5.6 endpoint rejects `max`, so the ceiling is xhigh.
  // The escalation trigger and its fallback must agree on this exact value.
  assert.equal(ceiling?.effort, "xhigh");
  assert.equal(clampThinkingLevel("max", sol), ceiling?.effort);
  assert.equal(routingCeiling([astra]), undefined);
  assert.equal(routingCeiling([]), undefined);
});

test("routing ladder guidance states the cheapest-sufficient policy and both escalation criteria", () => {
  assert.match(ROUTING_LADDER_GUIDANCE, /cheapest model and effort/i);
  assert.match(ROUTING_LADDER_GUIDANCE, /gpt-5\.4-mini/);
  assert.match(ROUTING_LADDER_GUIDANCE, /hallucinat/i);
  assert.match(ROUTING_LADDER_GUIDANCE, /approval/i);
});

test("a routing plugin is read only when it matches the contract", () => {
  const key = SUBAGENT_ROUTER_KEY;
  assert.equal(readRegisteredRouter({}), undefined);
  assert.equal(readRegisteredRouter({ [key]: "nope" }), undefined);
  assert.equal(readRegisteredRouter({ [key]: { name: "x" } }), undefined);
  const router = readRegisteredRouter({ [key]: { name: " tiered ", route: () => undefined } });
  assert.equal(router?.name, "tiered");
  assert.equal(typeof router?.route, "function");
});

test("router decisions are validated and leave effort to the normal precedence chain", () => {
  assert.deepEqual(parseRouterDecision({ model: " openai/gpt-5.6-luna " }), { model: "openai/gpt-5.6-luna" });
  assert.deepEqual(parseRouterDecision({ model: "openai/gpt-5.6-sol", effort: "high", rationale: " deep " }), {
    model: "openai/gpt-5.6-sol",
    effort: "high",
    rationale: "deep",
  });
  assert.equal(parseRouterDecision({ model: "x/y", effort: "extreme" }), undefined);
  assert.equal(parseRouterDecision({ model: "" }), undefined);
  assert.equal(parseRouterDecision(undefined), undefined);
  assert.equal(parseRouterDecision("openai/gpt-5.6-sol"), undefined);
});

test("a router cannot widen the session scope because its choice resolves strictly in scope", () => {
  const scoped = [{ provider: "openai", id: "gpt-5.6-luna" }];
  const decision = parseRouterDecision({ model: "openai/gpt-6-astra" });
  assert.equal(decision?.model, "openai/gpt-6-astra");
  // The same strict path classifier output takes rejects it, so routing falls through.
  const resolved = resolveCandidateModel(decision.model, scoped, "openai", true);
  assert.equal(resolved.model, undefined);
  assert.match(resolved.error ?? "", /outside this session's model scope/);
});

test("the escalation gate prompts only where a human can actually answer", () => {
  const base = { escalation: true, hasCeiling: true, depth: 0, hasUI: true };
  assert.deepEqual(escalationGate(base), { action: "prompt" });
  // Non-escalation selections pass straight through with no reason attached.
  assert.deepEqual(escalationGate({ ...base, escalation: false }), { action: "allow" });
  // A nested child has no human on its RPC channel; it must not burn the 30s timeout.
  assert.deepEqual(escalationGate({ ...base, depth: 2 }), {
    action: "decline",
    reason: "is not available to a nested subagent",
  });
  assert.deepEqual(escalationGate({ ...base, hasUI: false }), {
    action: "decline",
    reason: "needs approval and this session has no interactive UI",
  });
  // A scope holding only escalation models is itself the authorization.
  assert.deepEqual(escalationGate({ ...base, hasCeiling: false }), {
    action: "allow",
    reason: "no non-escalation model is in scope",
  });
  // Depth is only consulted for escalation-class selections.
  assert.deepEqual(escalationGate({ escalation: false, hasCeiling: false, depth: 3, hasUI: false }), {
    action: "allow",
  });
});
