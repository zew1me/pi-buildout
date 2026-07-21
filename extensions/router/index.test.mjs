import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { conservativeFeatures } from "./core/features.ts";
import routerExtension, { automaticRoutingBlockReason, deterministicCheckCommand } from "./index.ts";

describe("automatic routing gate", () => {
  it("requires validated semantic evidence instead of promoting classifier failure to a premium route", () => {
    assert.match(automaticRoutingBlockReason({ failedClosed: true }), /validated semantic evidence/);
    assert.equal(automaticRoutingBlockReason({ failedClosed: false }), undefined);
  });
});

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
      "session_shutdown",
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

  it("repairs one missing planning validation before fallback and reports exhaustion once", async () => {
    const hooks = new Map();
    const commands = new Map();
    const appended = [];
    const sent = [];
    const selectedModels = [];
    const notifications = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-plan-repair-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = join(telemetryDirectory, "events.jsonl");
    const now = new Date().toISOString();
    const primaryChoice = {
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      vendor: "anthropic",
      effort: "high",
      ability: 3,
      profileId: "anthropic-claude-planning-v1",
      contextWindow: 1_000_000,
      rankReason: "bootstrap",
    };
    const fallbackChoice = {
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      vendor: "openai",
      effort: "high",
      ability: 3,
      profileId: "openai-gpt-5.6-agent-v1",
      contextWindow: 1_000_000,
      rankReason: "bootstrap",
    };
    const lease = {
      version: 1,
      taskId: "planning-task",
      startedAt: now,
      updatedAt: now,
      archetype: "implementation_planning",
      features: conservativeFeatures("planning validation repair test"),
      selected: primaryChoice,
      fallbacks: [fallbackChoice],
      attemptIndex: 0,
      promptProfileId: primaryChoice.profileId,
      modelSnapshotId: "snapshot",
      policyVersion: "router-policy-v3",
      lastPromptFingerprint: "fingerprint",
      manualOverride: false,
      reviewRequired: false,
      reviewCompleted: false,
    };
    const makeModel = (choice) => ({
      provider: choice.provider,
      id: choice.modelId,
      name: choice.modelId,
      api: choice.vendor === "anthropic" ? "anthropic-messages" : "openai-responses",
      baseUrl: "https://models.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
      contextWindow: choice.contextWindow,
      maxTokens: 128_000,
    });
    const models = [makeModel(primaryChoice), makeModel(fallbackChoice)];
    const branch = [
      {
        type: "custom",
        customType: "model-router-state",
        data: { mode: "active", manualOverride: false, active: lease },
      },
    ];
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: () => {},
      appendEntry: (customType, data) => appended.push({ customType, data }),
      sendMessage: (message, options) => sent.push({ message, options }),
      setModel: async (model) => {
        selectedModels.push(model);
        return true;
      },
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
        getSessionId: () => "plan-repair-session",
      },
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_000_000, percent: 1 }),
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        notify: (message, type) => notifications.push({ message, type }),
      },
    };
    const latestLease = () => appended.findLast((entry) => entry.customType === "model-router-state")?.data.active;
    const completeRun = async (model) => {
      ctx.model = model;
      hooks.get("agent_start")();
      await hooks.get("agent_end")(
        {
          messages: [
            {
              role: "assistant",
              provider: model.provider,
              model: model.id,
              stopReason: "stop",
              usage: { input: 100, output: 20, cacheRead: 0, cost: { total: 0.01 } },
            },
          ],
        },
        ctx,
      );
    };
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);

      await completeRun(models[0]);
      assert.equal(latestLease().attemptIndex, 0, "contract repair must not consume the fallback");
      assert.equal(latestLease().planValidationRepairAttempted, true);
      assert.match(sent[0].message.content, /submit_implementation_plan/);
      assert.equal(sent[0].message.details.repairReason, "missing_plan_validation");
      assert.equal(selectedModels.length, 0);

      await completeRun(models[0]);
      assert.equal(latestLease().attemptIndex, 1, "a repeated omission must use the existing fallback");
      assert.equal(latestLease().selected.modelId, fallbackChoice.modelId);
      assert.equal(selectedModels[0].id, fallbackChoice.modelId);
      assert.match(sent[1].message.content, /previous routed attempt failed/i);

      await completeRun(models[1]);
      assert.equal(latestLease().executionFailed, true);
      assert.equal(notifications.length, 1);
      assert.match(notifications[0].message, /all authorized ordinary provider choices exhausted/);

      await completeRun(models[1]);
      await commands.get("route").handler("fail deterministic_verification", ctx);
      assert.equal(notifications.length, 1, "an exhausted lease must not repeat its error notification");
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
    }
  });

  it("tries every leased provider after an invalidated OpenAI Codex token", async () => {
    const hooks = new Map();
    const appended = [];
    const selectedModels = [];
    const notifications = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-auth-failover-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = join(telemetryDirectory, "events.jsonl");
    const now = new Date().toISOString();
    const choices = [
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-terra",
        vendor: "openai",
        effort: "high",
        ability: 2,
        profileId: "openai-gpt-5.6-agent-v1",
        contextWindow: 1_000_000,
        rankReason: "bootstrap",
      },
      {
        provider: "openai",
        modelId: "gpt-5.6-terra",
        vendor: "openai",
        effort: "high",
        ability: 2,
        profileId: "openai-gpt-5.6-agent-v1",
        contextWindow: 1_000_000,
        rankReason: "bootstrap",
      },
      {
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        vendor: "anthropic",
        effort: "high",
        ability: 3,
        profileId: "anthropic-claude-fast-agent-v1",
        contextWindow: 1_000_000,
        rankReason: "bootstrap",
      },
    ];
    const lease = {
      version: 1,
      taskId: "auth-failover-task",
      startedAt: now,
      updatedAt: now,
      archetype: "median_repository_implementation",
      features: conservativeFeatures("authentication failover test"),
      selected: choices[0],
      fallbacks: choices.slice(1),
      attemptIndex: 0,
      promptProfileId: choices[0].profileId,
      modelSnapshotId: "snapshot",
      policyVersion: "router-policy-v3",
      lastPromptFingerprint: "fingerprint",
      manualOverride: false,
    };
    const makeModel = (choice) => ({
      provider: choice.provider,
      id: choice.modelId,
      name: choice.modelId,
      api: choice.vendor === "anthropic" ? "anthropic-messages" : "openai-responses",
      baseUrl: "https://models.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
      contextWindow: choice.contextWindow,
      maxTokens: 128_000,
    });
    const models = choices.map(makeModel);
    const branch = [
      {
        type: "custom",
        customType: "model-router-state",
        data: { mode: "active", manualOverride: false, active: lease },
      },
    ];
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
      appendEntry: (customType, data) => appended.push({ customType, data }),
      sendMessage: () => {},
      setModel: async (model) => {
        selectedModels.push(model);
        return true;
      },
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
        getSessionId: () => "auth-failover-session",
      },
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_000_000, percent: 1 }),
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        notify: (message, type) => notifications.push({ message, type }),
      },
    };
    const latestLease = () => appended.findLast((entry) => entry.customType === "model-router-state")?.data.active;
    const failForInvalidToken = async (model) => {
      ctx.model = model;
      hooks.get("agent_start")();
      hooks.get("after_provider_response")({ status: 401 });
      await hooks.get("agent_end")(
        {
          messages: [
            {
              role: "assistant",
              provider: model.provider,
              model: model.id,
              stopReason: "error",
              usage: { input: 100, output: 0, cacheRead: 0, cost: { total: 0 } },
            },
          ],
        },
        ctx,
      );
    };
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      await failForInvalidToken(models[0]);
      assert.equal(latestLease().selected.provider, "openai");
      assert.equal(latestLease().attemptIndex, 1);
      await failForInvalidToken(models[1]);
      assert.equal(latestLease().selected.provider, "anthropic");
      assert.equal(latestLease().attemptIndex, 2);
      await failForInvalidToken(models[2]);
      assert.equal(latestLease().executionFailed, true);
      assert.deepEqual(
        selectedModels.map((model) => model.provider),
        ["openai", "anthropic"],
      );
      assert.match(notifications[0].message, /all authorized ordinary provider choices exhausted/);
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
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
