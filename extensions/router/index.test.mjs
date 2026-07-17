import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { conservativeFeatures } from "./core/features.ts";
import routerExtension, { deterministicCheckCommand } from "./index.ts";

describe("deterministicCheckCommand", () => {
  it("accepts exit-preserving checks and rejects shell constructs that can mask failure", () => {
    assert.equal(deterministicCheckCommand("npm test && npm run lint"), "npm test && npm run lint");
    assert.equal(deterministicCheckCommand("npm test; true"), undefined);
    assert.equal(deterministicCheckCommand("npm test || true"), undefined);
    assert.equal(deterministicCheckCommand("npm test | tee test.log"), undefined);
    assert.equal(deterministicCheckCommand("npm test & wait"), undefined);
    assert.equal(deterministicCheckCommand("echo hello"), undefined);
  });
});

describe("routerExtension", () => {
  it("registers the routing lifecycle and status command without starting background work", () => {
    const hooks = new Map();
    const commands = new Map();
    const tools = new Map();
    routerExtension({
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: (tool) => tools.set(tool.name, tool),
    });
    for (const event of [
      "session_start",
      "session_compact",
      "session_before_fork",
      "input",
      "before_agent_start",
      "model_select",
      "thinking_level_select",
      "agent_start",
      "turn_start",
      "tool_execution_end",
      "tool_call",
      "after_provider_response",
      "agent_end",
      "agent_settled",
    ]) {
      assert.equal(hooks.has(event), true, `missing ${event}`);
    }
    assert.match(commands.get("route").description, /model-router mode/);
    assert.equal(tools.has("submit_implementation_plan"), true);
  });

  it("acknowledges input immediately and shows the routing spinner before repository I/O finishes", async () => {
    const hooks = new Map();
    const workingMessages = [];
    const visibility = [];
    const never = new Promise(() => {});
    routerExtension({
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
      appendEntry: () => {},
      exec: () => never,
    });
    const result = await hooks.get("input")(
      { text: "New task", source: "interactive" },
      {
        cwd: "/repo",
        sessionManager: { getBranch: () => [] },
        ui: {
          setWorkingMessage: (message) => workingMessages.push(message),
          setWorkingVisible: (visible) => visibility.push(visible),
        },
      },
    );
    assert.deepEqual(result, { action: "continue" });
    assert.deepEqual(workingMessages, ["Routing..."]);
    assert.deepEqual(visibility, [true]);
  });

  it("fails active mode back to shadow when the audit log cannot append", async () => {
    const hooks = new Map();
    const commands = new Map();
    const appended = [];
    const notifications = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-telemetry-failure-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    const previousMode = process.env.PI_ROUTER_MODE;
    process.env.PI_ROUTER_TELEMETRY_PATH = telemetryDirectory;
    process.env.PI_ROUTER_MODE = "active";
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: () => {},
      appendEntry: (customType, data) => appended.push({ customType, data }),
    };
    routerExtension(pi);
    const ctx = {
      sessionManager: { getSessionId: () => "telemetry-failure" },
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        notify: (message, type) => notifications.push({ message, type }),
      },
    };
    try {
      await hooks.get("model_select")({ source: "set", model: { provider: "openai-codex", id: "gpt-5.6-terra" } }, ctx);
      assert.equal(appended.at(-1).data.mode, "shadow");
      assert.match(notifications.at(-1).message, /telemetry failed/i);
      await commands.get("route").handler("active", ctx);
      assert.match(notifications.at(-1).message, /cannot enter active mode/i);
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
      if (previousMode === undefined) delete process.env.PI_ROUTER_MODE;
      else process.env.PI_ROUTER_MODE = previousMode;
    }
  });

  it("runs a required review as a read-only child lease and restores the builder", async () => {
    const hooks = new Map();
    const appended = [];
    const sent = [];
    const selectedModels = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-adapter-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = join(telemetryDirectory, "events.jsonl");
    const now = new Date().toISOString();
    const features = {
      ...conservativeFeatures("required review test"),
      actionMode: "reversible_mutation",
      risk: "critical",
      confidence: 0.99,
    };
    const parent = {
      version: 1,
      taskId: "parent-task",
      startedAt: now,
      updatedAt: now,
      archetype: "highest_risk_advisory",
      features,
      selected: {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        vendor: "openai",
        effort: "high",
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
      attemptIndex: 0,
      promptProfileId: "openai-gpt-5.6-agent-v1",
      modelSnapshotId: "snapshot",
      policyVersion: "router-policy-v1",
      lastPromptFingerprint: "fingerprint",
      manualOverride: false,
      reviewRequired: true,
      reviewCompleted: false,
    };
    const makeModel = (provider, id, api) => ({
      provider,
      id,
      name: id,
      api,
      baseUrl: "https://models.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    const models = [
      makeModel("openai-codex", "gpt-5.6-sol", "openai-responses"),
      makeModel("anthropic", "claude-fable-5", "anthropic-messages"),
      makeModel("google", "gemini-3.5-flash", "google-generative-ai"),
    ];
    const branch = [
      {
        type: "custom",
        customType: "model-router-state",
        data: { mode: "active", manualOverride: false, active: parent },
      },
    ];
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
      appendEntry: (customType, data) => appended.push({ customType, data }),
      sendMessage: (message, options) => sent.push({ message, options }),
      setModel: async (model) => selectedModels.push(model),
      setThinkingLevel: () => {},
      getThinkingLevel: () => "high",
      exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    };
    routerExtension(pi);
    const ctx = {
      cwd: telemetryDirectory,
      model: models[0],
      modelRegistry: {
        getAll: () => models,
        getAvailable: () => models,
        find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
      },
      sessionManager: {
        getBranch: () => branch,
        getSessionId: () => "review-session",
      },
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_000_000, percent: 1 }),
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        notify: () => {},
      },
    };
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      await hooks.get("agent_settled")({}, ctx);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].options.triggerTurn, true);
      const child = appended.at(-1).data.active;
      assert.equal(child.parentTaskId, parent.taskId);
      assert.equal(child.archetype, "code_review");
      assert.notEqual(child.selected.vendor, "openai");
      assert.deepEqual(hooks.get("tool_call")({ toolName: "edit", input: {} }), {
        block: true,
        reason: "Independent review lease is read-only",
      });
      assert.equal(hooks.get("tool_call")({ toolName: "bash", input: { command: "git diff --stat" } }), undefined);
      assert.deepEqual(hooks.get("tool_call")({ toolName: "bash", input: { command: "git diff | sh" } }), {
        block: true,
        reason: "Independent review lease is read-only",
      });
      assert.deepEqual(hooks.get("tool_call")({ toolName: "custom_mutator", input: {} }), {
        block: true,
        reason: "Independent review lease is read-only",
      });
      await hooks.get("agent_settled")({}, ctx);
      assert.equal(appended.at(-1).data.active.taskId, child.taskId, "pending review must not restore its parent");
      ctx.model = selectedModels[0];
      hooks.get("agent_start")();
      hooks.get("turn_start")();
      await hooks.get("agent_end")(
        {
          messages: [
            {
              role: "assistant",
              provider: child.selected.provider,
              model: child.selected.modelId,
              stopReason: "stop",
              usage: { input: 100, output: 20, cacheRead: 0, cost: { total: 0.01 } },
            },
          ],
        },
        ctx,
      );
      await hooks.get("agent_settled")({}, ctx);
      const restored = appended.at(-1).data.active;
      assert.equal(restored.taskId, parent.taskId);
      assert.equal(restored.reviewCompleted, true);
      assert.equal(restored.selected.modelId, "gpt-5.6-sol");
      assert.equal(selectedModels[0].id, "claude-fable-5");
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
    }
  });
});
