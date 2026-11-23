import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerSignaling } from "../subagents/signaling.ts";

// The router derives candidates from the operator's model scope, so tests pin it explicitly rather
// than reading whatever the developer happens to have enabled.
process.env.PI_ROUTER_MODEL_SCOPE = "*";
process.env.PI_ROUTER_ENDPOINT_HEALTH_PATH = "/nonexistent-router-health.json";
// Recording the last known mode is a real filesystem write; keep every test out of the developer's
// agent directory unless the test points it somewhere itself.
process.env.PI_ROUTER_LAST_MODE_PATH = join(await mkdtemp(join(tmpdir(), "pi-router-last-mode-")), "last-mode.jsonl");
import { classifyTask, classifyTaskPrimary } from "./classifier.ts";
import { deriveArchetype } from "./core/archetype.ts";
import { POLICY_VERSION } from "./core/policy.ts";
import { PROMPT_PROFILES } from "./core/profiles.ts";
import { conservativeFeatures } from "./core/features.ts";
import { validateActionPlan } from "./core/safety.ts";
import { transportFromCandidates } from "./pi-classifier.ts";
import { restoreLeaseState } from "./pi-state.ts";
import { JsonlTelemetryStore, runClassifierInvocation } from "./telemetry.ts";
import routerExtensionImpl, {
  CLASSIFICATION_STAGE_TIMEOUT_MS,
  activeToolsForSafetyLifecycle,
  automaticRoutingBlockReason,
  deterministicCheckCommand,
  advisoryPhasePausedByOff,
  resumeCompletedLifecycle,
  routeChoicesForNewLease,
  routerOffNotice,
  routerReenabledNotice,
  stageDeadlineDescription,
  supportsRouterPiVersion,
} from "./index.ts";

// Lightweight Pi stubs in unrelated tests do not model the tool loadout. Supply that part of the
// ExtensionAPI only when a test has not provided a stateful implementation of its own.
// Likewise, input contexts default to idle unless a test models a busy run explicitly.
function routerExtension(pi, options) {
  pi.getActiveTools ??= () => [];
  pi.setActiveTools ??= () => {};
  pi.getThinkingLevel ??= () => "high";
  const on = pi.on.bind(pi);
  pi.on = (event, handler) =>
    on(
      event,
      event === "input"
        ? (input, ctx) => {
            ctx.isIdle ??= () => true;
            return handler(input, ctx);
          }
        : handler,
    );
  return routerExtensionImpl(pi, {
    reviewRunner: { start: () => ({ result: new Promise(() => {}), cancel() {} }) },
    ...options,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function implementationFeatures(overrides = {}) {
  return {
    ...conservativeFeatures("fixture"),
    intent: "implement",
    workflowType: "coding_implementation",
    actionMode: "reversible_mutation",
    horizon: "single_pr",
    risk: "medium",
    ambiguity: "low",
    confidence: 0.95,
    taskContinuity: "new_task",
    independenceRequirement: "none",
    interactivity: "developer_loop",
    expectedAgentTurns: 3,
    expectedFilesRead: 4,
    expectedFilesChanged: 1,
    expectedToolOutputTokens: 2_000,
    verificationStrength: "unit_tests",
    decompositionRecommended: false,
    ...overrides,
  };
}

function classificationResult(attempts = 1, overrides = {}) {
  const features = implementationFeatures(overrides);
  return {
    features,
    archetype: deriveArchetype(features),
    escalated: attempts > 1,
    failedClosed: false,
    attempts: Array.from({ length: attempts }, (_, index) => ({
      stage: index === 0 ? "primary" : "secondary",
      try: 1,
      valid: true,
      provider: index === 0 ? "openai-codex" : "anthropic",
      modelId: index === 0 ? "gpt-6-luna" : "claude-sonnet-5",
      vendor: index === 0 ? "openai" : "anthropic",
      latencyMs: 1,
      errors: [],
    })),
    primaryVendor: "openai",
    ...(attempts > 1 ? { secondaryVendor: "anthropic" } : {}),
    primaryFeatures: features,
    ...(attempts > 1 ? { secondaryFeatures: features } : {}),
  };
}

function primaryClassificationResult(overrides = {}) {
  const features = implementationFeatures(overrides);
  return {
    features,
    archetype: deriveArchetype(features),
    escalated: features.confidence < 0.8 || features.risk === "high" || features.risk === "critical",
    failedClosed: false,
    attempts: [
      {
        stage: "primary",
        try: 1,
        valid: true,
        provider: "openai-codex",
        modelId: "gpt-6-luna",
        vendor: "openai",
        latencyMs: 1,
        errors: [],
      },
    ],
    primaryVendor: "openai",
    primaryFeatures: features,
  };
}

function successfulClassifier(attempts = 1, overrides = {}) {
  return async ({ onAttempt }) => {
    for (let index = 0; index < attempts; index++) {
      const stage = index === 0 ? "primary" : "secondary";
      onAttempt?.({ stage, try: 1, state: "started" });
      onAttempt?.({
        stage,
        try: 1,
        state: "completed",
        outcome: "valid",
        provider: index === 0 ? "openai-codex" : "anthropic",
        modelId: index === 0 ? "gpt-6-luna" : "claude-sonnet-5",
        latencyMs: 1,
      });
    }
    return classificationResult(attempts, overrides);
  };
}

function irreversibleActionPlan() {
  return {
    objective: "Rotate the production credential under a bounded overlap window.",
    targets: ["production/keyring"],
    assumptions: ["The old credential remains valid during overlap."],
    preconditions: ["Break-glass access has been tested."],
    steps: [
      {
        id: "rotate",
        action: "Create the replacement, activate it, then revoke the old credential.",
        target: "production/keyring",
        expectedEffect: "The old credential permanently stops authenticating.",
        potentiallyIrreversible: true,
      },
    ],
    verification: ["Authenticate with the replacement from two clients."],
    rollback: ["Reactivate the old credential before overlap ends."],
    abortConditions: ["Stop if break-glass access or replacement verification fails."],
    toolNames: ["bash"],
  };
}

async function waitForReview(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(Boolean(predicate()), true, "review condition did not settle");
}
function controlledRunner() {
  const calls = [];
  return {
    calls,
    start(request) {
      const completion = deferred();
      const call = { request, resolve: completion.resolve, cancelled: false };
      calls.push(call);
      return {
        result: completion.promise,
        cancel() {
          call.cancelled = true;
        },
      };
    },
  };
}
const validAdvice = (request) => ({
  reviewKind: request.kind,
  scopeFingerprint: request.scopeFingerprint,
  verdict: request.kind === "plan" ? "approve" : "pass",
  summary: "Bounded advice",
  evidence: ["Inspected evidence"],
  findings: ["Verify rollback"],
});

// A high-risk builder with an independent reviewer from a different vendor.
async function authorizationLifecycleFixture(options = {}, restoredState) {
  const hooks = new Map();
  const commands = new Map();
  const tools = new Map();
  const appended = [];
  const sent = [];
  const selectedModels = [];
  const hooksDuringSwitch = { duringBuilderSwitch: undefined };
  const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-authorization-"));
  const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
  process.env.PI_ROUTER_TELEMETRY_PATH = join(telemetryDirectory, "events.jsonl");
  const now = new Date().toISOString();
  const features = {
    ...conservativeFeatures("authorization lifecycle test"),
    intent: "operate",
    workflowType: "incident_or_operations",
    actionMode: "destructive",
    risk: "critical",
    confidence: 0.99,
  };
  const parent = {
    version: 2,
    taskId: "irreversible-parent",
    startedAt: now,
    updatedAt: now,
    archetype: "highest_risk_advisory",
    features,
    selected: {
      provider: "openai-codex",
      modelId: "gpt-6-sol",
      logicalModelId: "gpt-6-sol",
      vendor: "openai",
      effort: "high",
      ability: 4,
      profileId: "openai-gpt-6-agent-v1",
      contextWindow: 1_000_000,
      endpointTier: "manufacturer",
      rankReason: "bootstrap",
    },
    fallbacks: [
      {
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        logicalModelId: "claude-opus-5-5",
        vendor: "anthropic",
        effort: "high",
        ability: 4,
        profileId: "anthropic-claude-planning-v1",
        contextWindow: 1_000_000,
        endpointTier: "manufacturer",
        rankReason: "evidence_prior",
      },
    ],
    attemptIndex: 0,
    promptProfileId: "openai-gpt-6-agent-v1",
    modelSnapshotId: "snapshot",
    policyVersion: POLICY_VERSION,
    lastPromptFingerprint: "fingerprint",
    lifecycle: {
      phase: "planning",
      policy: "plan_review_then_completion_review",
      taskFingerprint: "task-fingerprint",
    },
    safetyEvidence: { baselineChangedFiles: [], checks: [], mutations: [] },
    manualOverride: false,
  };
  let activeTools = ["read", "bash", "submit_action_plan", "submit_safety_review", ...(options.activeExtra ?? [])];
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
    makeModel("openai-codex", "gpt-6-sol", "openai-responses"),
    makeModel("anthropic", "claude-opus-5-5", "anthropic-messages"),
    makeModel("google-vertex", "gemini-3.6-flash", "google-generative-ai"),
  ];
  const branch = [
    {
      type: "custom",
      customType: "model-router-state",
      data: restoredState ?? { secondarySafetyPending: false, mode: "active", manualOverride: false, active: parent },
    },
  ];
  const pi = {
    on: (event, handler) => hooks.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    appendEntry: (customType, data) => appended.push({ customType, data }),
    sendMessage: (message, options) => sent.push({ message, options }),
    ...(options.events ? { events: options.events } : {}),
    getAllTools: () => options.allTools?.() ?? [],
    setModel: async (model) => {
      selectedModels.push(model);
      // The interruption can land while settlement awaits the switch back to the builder.
      return (await hooksDuringSwitch.duringBuilderSwitch?.(model)) ?? true;
    },
    setThinkingLevel: () => {},
    getThinkingLevel: () => "high",
    getActiveTools: () => activeTools,
    setActiveTools: (tools) => {
      activeTools = tools;
    },
    exec: async (command, args) => {
      const result = await hooksDuringSwitch.duringExec?.(command, args);
      return result ?? { stdout: "", stderr: "", code: 1, killed: false };
    },
  };
  routerExtension(pi, options);
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
      getSessionId: () => "authorization-session",
    },
    getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_000_000, percent: 1 }),
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      notify: () => {},
    },
  };
  const latestLease = () =>
    appended.findLast((entry) => entry.customType === "model-router-state")?.data.active ?? parent;
  const restoreEnvironment = () => {
    if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
    else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
  };
  return {
    hooks,
    commands,
    tools,
    appended,
    sent,
    selectedModels,
    models,
    parent,
    ctx,
    latestLease,
    restoreEnvironment,
    onExec: (handler) => {
      hooksDuringSwitch.duringExec = handler;
    },
    onBuilderSwitch: (handler) => {
      hooksDuringSwitch.duringBuilderSwitch = handler;
    },
  };
}

describe("classifier deadline", () => {
  it("allows independent fifteen-second deadlines per classifier stage", () => {
    assert.equal(CLASSIFICATION_STAGE_TIMEOUT_MS, 15_000);
  });

  it("grants the secondary stage its own independent fifteen-second deadline", async () => {
    const endpointCalls = [];
    const signals = new Set();
    const candidate = (provider, id, vendor) => ({ model: { provider, id }, vendor });
    const response = (entry, argumentsValue) => ({
      arguments: argumentsValue,
      provider: entry.model.provider,
      modelId: entry.model.id,
      vendor: entry.vendor,
      latencyMs: 1,
    });
    const primary = transportFromCandidates(
      [candidate("primary-a", "gpt-6-luna", "openai")],
      async (entry, request) => {
        endpointCalls.push(`${request.stage}:${entry.model.provider}`);
        signals.add(request.signal);
        return response(entry, implementationFeatures({ risk: "high" }));
      },
    );
    const secondary = transportFromCandidates(
      [candidate("secondary-a", "claude-sonnet-5", "anthropic")],
      async (entry, request) => {
        endpointCalls.push(`${request.stage}:${entry.model.provider}`);
        signals.add(request.signal);
        return response(entry, implementationFeatures({ risk: "high" }));
      },
    );

    const run = await runClassifierInvocation({
      purpose: "fresh_task",
      timeoutMs: CLASSIFICATION_STAGE_TIMEOUT_MS,
      stageTimeoutMs: CLASSIFICATION_STAGE_TIMEOUT_MS,
      invoke: (signal, onAttempt) =>
        classifyTask({
          prompt: "Implement the change",
          synopsis: {},
          primary,
          secondary,
          primaryVendor: "openai",
          secondaryVendor: "anthropic",
          signal,
          onAttempt,
        }),
    });

    assert.equal(run.status, "completed");
    assert.equal(run.value.escalated, true);
    assert.deepEqual(endpointCalls, ["primary:primary-a", "secondary:secondary-a"]);
    assert.equal(run.summary.attemptCount, 2);
  });

  it("keeps retries and endpoint iteration inside the stage budget", async () => {
    const endpointCalls = [];
    const signals = new Set();
    const candidate = (provider, id, vendor) => ({ model: { provider, id }, vendor });
    const response = (entry, argumentsValue) => ({
      arguments: argumentsValue,
      provider: entry.model.provider,
      modelId: entry.model.id,
      vendor: entry.vendor,
      latencyMs: 1,
    });
    let primaryBCalls = 0;
    const primary = transportFromCandidates(
      [candidate("primary-a", "gpt-6-luna", "openai"), candidate("primary-b", "gpt-6-luna", "openai")],
      async (entry, request) => {
        endpointCalls.push(`${request.stage}:${entry.model.provider}`);
        signals.add(request.signal);
        if (entry.model.provider === "primary-a") throw new Error("retry endpoint");
        primaryBCalls++;
        return response(entry, primaryBCalls === 1 ? { invalid: true } : implementationFeatures({ risk: "high" }));
      },
    );
    const secondary = transportFromCandidates(
      [
        candidate("secondary-a", "claude-sonnet-5", "anthropic"),
        candidate("secondary-b", "claude-sonnet-5", "anthropic"),
      ],
      async (entry, request) => {
        endpointCalls.push(`${request.stage}:${entry.model.provider}`);
        signals.add(request.signal);
        if (entry.model.provider === "secondary-a") throw new Error("retry endpoint");
        return response(entry, implementationFeatures({ risk: "high" }));
      },
    );

    const run = await runClassifierInvocation({
      purpose: "fresh_task",
      timeoutMs: CLASSIFICATION_STAGE_TIMEOUT_MS,
      stageTimeoutMs: CLASSIFICATION_STAGE_TIMEOUT_MS,
      invoke: (signal, onAttempt) =>
        classifyTask({
          prompt: "Implement the change",
          synopsis: {},
          primary,
          secondary,
          primaryVendor: "openai",
          secondaryVendor: "anthropic",
          signal,
          onAttempt,
        }),
    });

    assert.equal(run.status, "completed");
    assert.equal(run.value.escalated, true);
    assert.deepEqual(endpointCalls, [
      "primary:primary-a",
      "primary:primary-b",
      "primary:primary-a",
      "primary:primary-b",
      "secondary:secondary-a",
      "secondary:secondary-b",
    ]);
    assert.equal(run.summary.attemptCount, 3, "two primary schema attempts and one secondary attempt were observed");
  });

  it("stops endpoint iteration and secondary escalation once the injected deadline expires", async () => {
    // The deadline is injected per invocation, so this exercises real expiration against a blocked
    // endpoint instead of asserting that an immediately settling fixture stayed under 15 seconds.
    const deadlineMs = 25;
    const endpointCalls = [];
    const candidate = (provider, id, vendor) => ({ model: { provider, id }, vendor });
    const blockUntilAborted = async (entry, request) => {
      endpointCalls.push(`${request.stage}:${entry.model.provider}`);
      await new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          const abort = new Error("router deadline aborted the endpoint call");
          abort.name = "AbortError";
          reject(abort);
        });
      });
      throw new Error("unreachable: the blocked endpoint must only end by abort");
    };
    const primary = transportFromCandidates(
      [candidate("primary-a", "gpt-6-luna", "openai"), candidate("primary-b", "gpt-6-luna", "openai")],
      blockUntilAborted,
    );
    const secondary = transportFromCandidates(
      [candidate("secondary-a", "claude-sonnet-5", "anthropic")],
      blockUntilAborted,
    );

    let classification;
    const startedAt = performance.now();
    const run = await runClassifierInvocation({
      purpose: "continuity",
      timeoutMs: deadlineMs,
      invoke: (signal, onAttempt) => {
        classification = classifyTask({
          prompt: "Implement the change",
          synopsis: {},
          primary,
          secondary,
          primaryVendor: "openai",
          secondaryVendor: "anthropic",
          signal,
          onAttempt,
        });
        return classification;
      },
    });

    assert.equal(run.status, "failed");
    assert.equal(run.summary.timedOut, true);
    assert.equal(run.summary.cancelled, true);
    assert.equal(run.summary.errorCategory, "deadline");
    // Timer scheduling and performance.now() rounding can differ by roughly one millisecond.
    assert.ok(run.summary.wallLatencyMs >= deadlineMs - 2, `expired after only ${String(run.summary.wallLatencyMs)}ms`);
    assert.ok(
      performance.now() - startedAt < CLASSIFICATION_STAGE_TIMEOUT_MS,
      "expiration must not wait for the full budget",
    );
    await assert.rejects(classification, (error) => error.name === "AbortError");
    assert.deepEqual(
      endpointCalls,
      ["primary:primary-a"],
      "an expired deadline must not try another endpoint or escalate to the secondary stage",
    );
  });
});

describe("automatic routing gate", () => {
  it("requires validated task features for automatic routing", () => {
    assert.ok(automaticRoutingBlockReason({ failedClosed: true }));
    assert.equal(automaticRoutingBlockReason({ failedClosed: false }), undefined);
  });

  for (const mode of ["shadow", "active"]) {
    it(`preserves the current selection and creates no lease after invalid classifier output in ${mode} mode`, async () => {
      const models = standardRoutingModels();
      const turn = { mode, prompt: "Say hello", models };
      // Control: this registry can route the task, so failure below cannot be explained by a lack of models.
      const valid = await runAdapterTurn({
        ...turn,
        sessionId: `classification-valid-${mode}`,
        classifyPrimaryTask: successfulClassifier(),
      });
      assert.notEqual(valid.events.findLast(({ kind }) => kind === "route_decision")?.data.kind, "unroutable");
      assert.ok(valid.appended.some(({ data }) => data.active));

      let attempts = 0;
      const result = await runAdapterTurn({
        ...turn,
        sessionId: `classification-invalid-${mode}`,
        classifyPrimaryTask: (input) =>
          classifyTaskPrimary({
            ...input,
            primary: async () => {
              attempts++;
              return {
                arguments: {}, // Real schema validation must reject this, not a hand-built failedClosed flag.
                provider: "anthropic",
                modelId: "claude-haiku-4-5",
                vendor: "anthropic",
                latencyMs: 1,
              };
            },
          }),
      });
      assert.equal(attempts, 2, "both schema attempts must be exhausted");
      const invocation = result.events.find(({ kind }) => kind === "classifier_invocation");
      assert.equal(invocation.data.validAttemptCount, 0);
      assert.equal(invocation.data.resolution, "failed_closed");
      assert.equal(result.events.findLast(({ kind }) => kind === "route_decision")?.data.kind, "unroutable");
      assert.equal(
        result.appended.some(({ data }) => data.active),
        false,
        "failure must not install a lease",
      );
      assert.equal(result.ctx.model, models[0], "the real current model must survive the failed route");
      assert.equal(result.pi.getThinkingLevel(), "high");
      assert.deepEqual(result.selectedModels, []);
      assert.deepEqual(result.selectedEfforts, []);
      assert.equal(result.beforeAgentStart, undefined, "no routed prompt may be installed");
      assert.equal(result.notifications.at(-1)?.type, "warning");
    });
  }
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

/** Runs a startup `session_start` against a session with no router history and returns persisted state. */
async function startupRouterState(overrides = {}) {
  const hooks = new Map();
  const appended = [];
  routerExtension({
    on: (event, handler) => hooks.set(event, handler),
    registerCommand: () => {},
    registerTool: () => {},
    appendEntry: (customType, data) => appended.push({ customType, data }),
    ...overrides,
  });
  await hooks.get("session_start")(
    { type: "session_start", reason: "startup" },
    {
      cwd: "/repo",
      sessionManager: { getSessionId: () => "startup-session", getBranch: () => [] },
      modelRegistry: { getAvailable: () => [], getAll: () => [] },
      model: undefined,
      getContextUsage: () => ({ tokens: 0, contextWindow: 128000 }),
      ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_color, text) => text } },
    },
  );
  return appended.filter((entry) => entry.customType === "model-router-state");
}

function adapterLease() {
  const now = new Date().toISOString();
  const features = implementationFeatures();
  const selected = {
    provider: "openai-codex",
    modelId: "gpt-6-sol",
    logicalModelId: "gpt-6-sol",
    vendor: "openai",
    effort: "high",
    ability: 3,
    profileId: "openai-gpt-6-agent-v1",
    contextWindow: 1_000_000,
    endpointTier: "manufacturer",
    rankReason: "bootstrap",
  };
  return {
    version: 2,
    taskId: "existing-task",
    startedAt: now,
    updatedAt: now,
    archetype: "median_repository_implementation",
    features,
    selected,
    fallbacks: [{ ...selected, provider: "openai" }],
    attemptIndex: 0,
    promptProfileId: selected.profileId,
    modelSnapshotId: "snapshot",
    policyVersion: POLICY_VERSION,
    lastPromptFingerprint: "fingerprint",
    lifecycle: { phase: "ordinary", policy: "ordinary", taskFingerprint: "task-fingerprint" },
    safetyEvidence: { baselineChangedFiles: [], checks: [], mutations: [] },
    manualOverride: false,
  };
}

/** Live registry entry for a leased choice, so an active-mode turn can actually apply that choice. */
function registryModelForChoice(choice) {
  return {
    provider: choice.provider,
    id: choice.modelId,
    name: choice.modelId,
    contextWindow: choice.contextWindow,
    maxTokens: 64_000,
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
    reasoning: true,
    input: ["text"],
  };
}

function routingModel(provider, id, cost = { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2 }) {
  return {
    provider,
    id,
    name: id,
    api: provider === "anthropic" ? "anthropic" : "openai-responses",
    baseUrl: "https://models.invalid",
    reasoning: true,
    thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    input: ["text"],
    cost,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  };
}

function standardRoutingModels() {
  return [
    routingModel("anthropic", "claude-opus-5-5", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }),
    routingModel("openai-codex", "gpt-6-sol", { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }),
    routingModel("openai-codex", "gpt-5.6-terra", { input: 4, output: 24, cacheRead: 0.4, cacheWrite: 5 }),
  ];
}

function cachedAssistantEntry({ input = 100_000, output = 100, cacheRead = 80_000 } = {}) {
  return {
    type: "message",
    message: {
      role: "assistant",
      usage: { input, output, cacheRead, cost: { total: 0.01 } },
    },
  };
}

async function flushMicrotasks() {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.equal(predicate(), true);
}

async function runAdapterTurn({
  classifyTask: classifyTaskFixture,
  classifyPrimaryTask,
  classifySecondaryTask,
  secondaryReconciliationPolicy,
  telemetry: telemetryOverride,
  active,
  prompt,
  sessionId,
  source = "interactive",
  streamingBehavior,
  reason = "reload",
  mode = "shadow",
  manualOverride = false,
  prepareTurn = true,
  models,
  branchEntries = [],
  contextUsage = { tokens: 0, contextWindow: 128_000 },
}) {
  const hooks = new Map();
  const commands = new Map();
  const tools = new Map();
  const events = [];
  const appended = [];
  const selectedModels = [];
  const selectedEfforts = [];
  const notifications = [];
  const sentMessages = [];
  let abortCount = 0;
  let runActive = false;
  let activeTools = [];
  const branch = [
    {
      type: "custom",
      customType: "model-router-state",
      data: { mode, manualOverride, ...(active ? { active } : {}) },
    },
    ...branchEntries,
  ];
  const pi = {
    on: (event, handler) => hooks.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => {
      tools.set(tool.name, tool);
      activeTools.push(tool.name);
    },
    appendEntry: (customType, data) => appended.push({ customType, data }),
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    getActiveTools: () => activeTools,
    setActiveTools: (tools) => {
      activeTools = tools;
    },
    getThinkingLevel: () => selectedEfforts.at(-1) ?? "high",
    setThinkingLevel: (effort) => selectedEfforts.push(effort),
    setModel: async (model) => {
      selectedModels.push(model);
      ctx.model = model;
      return true;
    },
    sendMessage: (message, options) => {
      sentMessages.push({ message, options });
    },
  };
  // A telemetry factory receives late-bound access to the adapter so a ledger write can interleave Pi events.
  const telemetry =
    typeof telemetryOverride === "function"
      ? telemetryOverride({ hooks, events, getCtx: () => ctx })
      : (telemetryOverride ?? {
          append: async (event) => {
            events.push(event);
          },
          read: async () => [],
        });
  // Active mode only means something when the leased choice is reachable, so the registry and the
  // current model mirror the lease. A retention assertion then proves the router left that selection
  // alone rather than merely never reaching the apply step.
  const registryModels = models ?? (mode === "active" && active ? [registryModelForChoice(active.selected)] : []);
  const ctx = {
    cwd: "/repo",
    model: registryModels[0],
    modelRegistry: {
      getAll: () => registryModels,
      getAvailable: () => registryModels,
      find: (provider, id) => registryModels.find((model) => model.provider === provider && model.id === id),
    },
    sessionManager: { getBranch: () => branch, getSessionId: () => sessionId },
    getContextUsage: () => contextUsage,
    isIdle: () => !runActive,
    abort: () => {
      abortCount++;
    },
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      notify: (message, type) => notifications.push({ message, type }),
    },
  };
  routerExtension(pi, {
    telemetry,
    ...(classifyTaskFixture ? { classifyTask: classifyTaskFixture } : {}),
    ...(classifyPrimaryTask ? { classifyPrimaryTask } : {}),
    ...(classifySecondaryTask ? { classifySecondaryTask } : {}),
    ...(secondaryReconciliationPolicy ? { secondaryReconciliationPolicy } : {}),
  });
  // Pi stays busy through agent_end. Settlement or preparation of a new run releases the old forced prompt.
  for (const event of ["agent_start", "agent_settled", "before_agent_start"]) {
    const handler = hooks.get(event);
    hooks.set(event, (...args) => {
      runActive = event === "agent_start";
      return handler(...args);
    });
  }
  await hooks.get("session_start")({ reason }, ctx);
  let beforeAgentStart;
  if (prepareTurn) {
    await hooks.get("input")({ text: prompt, source, ...(streamingBehavior ? { streamingBehavior } : {}) }, ctx);
    beforeAgentStart = await hooks.get("before_agent_start")({ prompt, systemPrompt: "system", images: [] }, ctx);
  }
  return {
    pi,
    hooks,
    commands,
    tools,
    ctx,
    events,
    appended,
    selectedModels,
    selectedEfforts,
    notifications,
    sentMessages,
    get abortCount() {
      return abortCount;
    },
    get activeTools() {
      return activeTools;
    },
    beforeAgentStart,
  };
}

// Drive the Pi agent-run boundaries the router observes, so a secondary result reaches the same
// drain points it would in production rather than settling in the gap before `agent_start`.
function startAgentRun(result) {
  result.hooks.get("agent_start")({}, result.ctx);
  result.hooks.get("turn_start")({}, result.ctx);
}

async function endAgentTurn(result) {
  await result.hooks.get("turn_end")(
    { message: { role: "assistant", stopReason: "stop" }, toolResults: [] },
    result.ctx,
  );
}

async function settleAgentRun(result, { stopReason = "stop" } = {}) {
  const active = result.appended.findLast((entry) => entry.customType === "model-router-state")?.data.active;
  result.ctx.model = result.ctx.modelRegistry.find(active.selected.provider, active.selected.modelId);
  await endAgentTurn(result);
  await result.hooks.get("agent_end")(
    {
      messages: [
        {
          role: "assistant",
          provider: active.selected.provider,
          model: active.selected.modelId,
          stopReason,
          usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
        },
      ],
    },
    result.ctx,
  );
  await result.hooks.get("agent_settled")({}, result.ctx);
}

function restoreEnv({ previousAgentDir, previousMode, previousLastModePath }) {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousMode === undefined) delete process.env.PI_ROUTER_MODE;
  else process.env.PI_ROUTER_MODE = previousMode;
  if (previousLastModePath === undefined) delete process.env.PI_ROUTER_LAST_MODE_PATH;
  else process.env.PI_ROUTER_LAST_MODE_PATH = previousLastModePath;
}
describe("resumeCompletedLifecycle", () => {
  it("resumes completed work without a session-bound grant", () => {
    const plan = {
      taskFingerprint: "task",
      planFingerprint: "f".repeat(64),
      submittedAt: "2026-07-28T00:00:00.000Z",
      plan: irreversibleActionPlan(),
    };
    const completed = {
      phase: "completed",
      policy: "plan_review_then_completion_review",
      taskFingerprint: "task",
      completionReview: {
        kind: "completion",
        verdict: "pass",
        summary: "done",
        completedAt: "2026-07-28T01:00:00.000Z",
      },
      plan,
      authorization: {
        taskFingerprint: "task",
        planFingerprint: plan.planFingerprint,
        reviewTaskId: "review",
        reviewerVendor: "anthropic",
        sessionId: "approving-session",
        approvedAt: "2026-07-28T00:01:00.000Z",
      },
    };
    assert.equal(resumeCompletedLifecycle(completed, "approving-session").phase, "executing");
    const elsewhere = resumeCompletedLifecycle(completed, "another-session");
    assert.equal(elsewhere.phase, "executing", "advice is not session-bound permission");
    assert.equal(elsewhere.authorization, undefined);
    assert.equal(elsewhere.plan.planFingerprint, plan.planFingerprint, "the submitted plan survives resumption");
  });
});

describe("router-off safety notice", () => {
  it("names advisory guidance paused by off and resumed by active mode", () => {
    for (const phase of ["planning"]) {
      assert.equal(advisoryPhasePausedByOff({ phase, policy: "ordinary", taskFingerprint: "t" }), phase);
      assert.ok(routerOffNotice(phase).includes(`Advisory ${phase} guidance is paused`), phase);
    }
    for (const phase of ["ordinary", "building", "executing", "executing", "completed"]) {
      assert.equal(advisoryPhasePausedByOff({ phase, policy: "ordinary", taskFingerprint: "t" }), undefined);
    }
    assert.equal(advisoryPhasePausedByOff(undefined), undefined);
    assert.match(routerReenabledNotice("planning"), /Advisory planning guidance has resumed/);
  });
});

describe("router-mode tool exposure", () => {
  for (const taskContinuity of ["clear_continuation", "possible_continuation", "streaming"]) {
    it(`validates the advertised plan on a retained research lease (${taskContinuity}, session 01a119bf)`, async () => {
      const research = {
        ...adapterLease(),
        archetype: "fast_classification",
        features: implementationFeatures({ intent: "research", actionMode: "local_read" }),
      };
      const result = await runAdapterTurn({
        active: research,
        mode: "active",
        prompt: "Please produce an implementation plan and a gh-stack PR stack for this research",
        sessionId: "01a119bf-regression",
        classifyTask: successfulClassifier(1, {
          intent: "plan",
          workflowType: "implementation_planning",
          taskContinuity,
        }),
        branchEntries: [cachedAssistantEntry()],
        contextUsage: { tokens: 100_000, contextWindow: 1_000_000 },
        ...(taskContinuity === "streaming" ? { streamingBehavior: "steer" } : {}),
      });
      const retained =
        result.appended.findLast((entry) => entry.customType === "model-router-state")?.data.active ?? research;
      // A queued steer stays inside the running lease. A classified continuation into planning re-routes (#103),
      // and this fixture offers no eligible planning endpoint, so the router retains the research lease and model.
      if (taskContinuity === "streaming") {
        assert.ok(result.beforeAgentStart);
        assert.equal(result.beforeAgentStart.message.details.taskId, research.taskId);
      } else {
        assert.equal(result.beforeAgentStart, undefined);
        assert.match(result.notifications.at(-1)?.message ?? "", /Router retained current model/);
      }
      assert.equal(retained.taskId, research.taskId);
      assert.equal(retained.archetype, "fast_classification");
      assert.deepEqual(retained.selected, research.selected);
      assert.ok(result.activeTools.includes("submit_implementation_plan"));
      assert.deepEqual([...result.tools.keys()].sort(), [
        "submit_action_plan",

        "submit_implementation_plan",
        "submit_safety_review",
      ]);
      const plan = {
        objective: "Implement the researched change as a PR stack.",
        assumptions: [],
        unknowns: [],
        pullRequests: [
          {
            id: "implementation",
            title: "Implement the change",
            goal: "Deliver the researched behavior",
            dependsOn: [],
            acceptanceCriteria: ["Regression passes"],
            rollout: "Merge the validated PR",
            rollback: "Revert the PR",
            risks: [],
            unknowns: [],
          },
        ],
      };
      assert.equal(result.hooks.get("tool_call")({ toolName: "submit_implementation_plan", input: plan }), undefined);
      const validation = await result.tools
        .get("submit_implementation_plan")
        .execute("plan", plan, undefined, undefined, result.ctx);
      assert.deepEqual(validation.details.topologicalOrder, ["implementation"]);
      assert.equal(result.events.findLast((event) => event.data.planValidated)?.data.planningLease, false);
    });
  }

  it("exposes only phase-valid safety validators and preserves their ordering", () => {
    const ordinaryTools = ["read", "bash", "submit_action_plan", "submit_safety_review"];
    assert.deepEqual(activeToolsForSafetyLifecycle(ordinaryTools, "off"), ["read", "bash"]);
    assert.deepEqual(activeToolsForSafetyLifecycle(ordinaryTools, "shadow"), ["read", "bash"]);
    for (const mode of ["active", "shadow", "off"]) {
      for (const phase of [
        undefined,
        "ordinary",
        "building",
        "executing",
        "executing",
        "completed",
        "planning",

        "planning",
        "review",
      ]) {
        const lifecycle = phase ? { phase, policy: "ordinary", taskFingerprint: "t" } : undefined;
        const expected = mode !== "active" ? [] : phase === "planning" ? ["submit_action_plan"] : [];
        assert.deepEqual(
          activeToolsForSafetyLifecycle(ordinaryTools, mode, lifecycle),
          ["read", "bash", ...expected],
          `${mode}/${phase}`,
        );
      }
    }
    assert.deepEqual(activeToolsForSafetyLifecycle(ordinaryTools, "active", { phase: "review", submission: {} }), [
      "read",
      "bash",
    ]);
    assert.deepEqual(activeToolsForSafetyLifecycle(ordinaryTools, "active", { phase: "planning" }, true), [
      "read",
      "bash",
    ]);
    assert.deepEqual(
      activeToolsForSafetyLifecycle(["read", "submit_action_plan", "bash", "submit_safety_review"], "active", {
        phase: "planning",
      }),
      ["read", "submit_action_plan", "bash"],
      "repeated syncs must not reorder the prompt's tool declarations",
    );
    for (const phase of ["planning", "review"]) {
      assert.deepEqual(activeToolsForSafetyLifecycle(ordinaryTools, "active", { phase }, true), ["read", "bash"]);
    }
  });
});

describe("manual route selection at a new task boundary", () => {
  it("preserves the explicit model and effort while replacing the stale task lease", () => {
    const current = {
      provider: "openai",
      modelId: "gpt-6-luna",
      logicalModelId: "gpt-6-luna",
      vendor: "openai",
      effort: "low",
      ability: 1,
      profileId: "openai-gpt-6-agent-v1",
      contextWindow: 272_000,
      endpointTier: "manufacturer",
      rankReason: "bootstrap",
    };
    const routed = { ...current, modelId: "gpt-6-sol", logicalModelId: "gpt-6-sol", effort: "high", ability: 3 };
    const fallback = {
      ...routed,
      provider: "anthropic",
      modelId: "claude-opus-5-5",
      logicalModelId: "claude-opus-5-5",
      vendor: "anthropic",
    };
    const preserved = routeChoicesForNewLease(routed, [fallback], current, true);
    assert.equal(preserved.selected, current);
    assert.equal(preserved.previousSelection, current);
    assert.deepEqual(preserved.fallbacks, [routed, fallback]);

    const automatic = routeChoicesForNewLease(routed, [fallback], current, false);
    assert.equal(automatic.selected, routed);
    assert.deepEqual(automatic.fallbacks, [fallback]);
  });

  it("does not duplicate the explicit selection in fallback order", () => {
    const selected = {
      provider: "openai",
      modelId: "gpt-6-sol",
      logicalModelId: "gpt-6-sol",
      vendor: "openai",
      effort: "high",
      ability: 3,
      profileId: "openai-gpt-6-agent-v1",
      contextWindow: 272_000,
      endpointTier: "manufacturer",
      rankReason: "bootstrap",
    };
    assert.deepEqual(routeChoicesForNewLease(selected, [selected], selected, true).fallbacks, []);
  });
});

describe("stageDeadlineDescription", () => {
  it("names the stage that consumed the budget when the router knows it", () => {
    assert.equal(stageDeadlineDescription({ deadlineStage: "primary" }), "in the primary stage");
    assert.equal(stageDeadlineDescription({ deadlineStage: "secondary" }), "in the secondary stage");
  });

  it("stays unattributed when the deadline fired before any stage started", () => {
    assert.equal(stageDeadlineDescription({}), "in one stage");
  });

  it("is wired into both classifier timeout notices", async () => {
    // The notices are only reachable behind a real 15s deadline, so pin the wording contract here
    // and assert the sources interpolate this helper rather than a hardcoded phrase.
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    const interpolations = source.match(/\$\{stageDeadlineDescription\(/g) ?? [];
    assert.equal(interpolations.length, 2, "continuity and fresh-task notices must both name the stage");
    assert.doesNotMatch(source, /s in one stage; keeping/, "no notice may hardcode the unattributed phrase");
  });
});

describe("advisory tool-call observation", () => {
  it("never blocks tools across lifecycle phases, modes, or manual overrides", async () => {
    const phases = [
      { phase: "ordinary", policy: "ordinary" },
      { phase: "building", policy: "completion_review" },
      { phase: "planning", policy: "plan_review_then_completion_review" },
      { phase: "executing", policy: "plan_review_then_completion_review" },
    ];
    for (const mode of ["active", "shadow", "off"]) {
      for (const manualOverride of [false, true]) {
        for (const lifecycle of phases) {
          const active = {
            ...adapterLease(),
            manualOverride,
            lifecycle: { ...lifecycle, taskFingerprint: "task-fingerprint" },
          };
          const result = await runAdapterTurn({
            active,
            mode,
            manualOverride,
            prepareTurn: false,
            sessionId: "advisory-tool-observation",
          });
          for (const toolName of [
            "read",
            "edit",
            "write",
            "bash",
            "subagent",
            "custom_mutator",
            "submit_action_plan",

            "submit_safety_review",
            "submit_implementation_plan",
          ]) {
            assert.equal(
              result.hooks.get("tool_call")(
                { toolCallId: `${mode}-${lifecycle.phase}-${toolName}`, toolName, input: { command: "deploy" } },
                result.ctx,
              ),
              undefined,
              `${mode}/${lifecycle.phase}/manualOverride=${String(manualOverride)}/${toolName}`,
            );
          }
        }
      }
    }
  });
  const finishRun = async (hooks, ctx, selected) => {
    await hooks.get("agent_end")(
      {
        messages: [
          {
            role: "assistant",
            provider: selected.provider,
            model: selected.modelId,
            stopReason: "stop",
            usage: { input: 100, output: 20, cacheRead: 0, cost: { total: 0.01 } },
          },
        ],
      },
      ctx,
    );
    await hooks.get("agent_settled")({}, ctx);
  };

  const recordingRunner = () => {
    const requests = [];
    return { requests, start: (request) => (requests.push(request), { result: new Promise(() => {}), cancel() {} }) };
  };

  for (const verdict of [undefined, "reject"]) {
    for (const reload of [false, true]) {
      it(`reviews executed work after ${verdict ?? "missing"} plan advice${reload ? " across reload" : ""}`, async () => {
        const transport = controlledRunner();
        const fixture = await authorizationLifecycleFixture({ reviewRunner: transport });
        let resumed;
        try {
          const { hooks, tools, ctx, parent } = fixture;
          const notes = [];
          ctx.ui.notify = (message) => notes.push(message);
          await hooks.get("session_start")({ reason: "reload" }, ctx);
          hooks.get("agent_start")({}, ctx);
          hooks.get("turn_start")({}, ctx);
          await tools.get("submit_action_plan").execute("plan", irreversibleActionPlan(), undefined, undefined, ctx);
          await finishRun(hooks, ctx, parent.selected);
          await waitForReview(() => transport.calls.length === 1);
          const planReview = transport.calls[0];
          assert.equal(planReview.request.kind, "plan");
          planReview.resolve({
            status: verdict ? "completed" : "failed",
            ...(verdict ? { verdict: { ...validAdvice(planReview.request), verdict } } : {}),
            // Exhaust the ladder deterministically when advice is missing.
            usage: { cost: verdict ? 0.01 : 1, inputTokens: 1, outputTokens: 1 },
          });
          await waitForReview(() =>
            verdict
              ? fixture.latestLease().lifecycle.planReview?.verdict === verdict
              : notes.some((message) => /did not return valid advice/.test(message)),
          );
          await flushMicrotasks();
          hooks.get("agent_start")({}, ctx);
          hooks.get("turn_start")({}, ctx);
          const write = { toolCallId: "planned-write", toolName: "write", input: { path: "x", content: "y" } };
          assert.equal(hooks.get("tool_call")(write, ctx), undefined);
          hooks.get("tool_execution_end")({ ...write, isError: false }, ctx);
          const returned = fixture.latestLease();
          assert.equal(returned.lifecycle.phase, "planning");
          assert.equal(returned.safetyEvidence.mutations.length, 1);
          if (verdict) assert.equal(returned.lifecycle.plan, undefined, "rejected plans are discarded");
          if (reload) {
            // A fresh extension sees only serialized entries, not in-memory review scheduling state.
            const entries = JSON.parse(JSON.stringify(fixture.appended)).map((entry) => ({ type: "custom", ...entry }));
            const state = restoreLeaseState(entries, "active");
            assert.equal(state.active?.taskId, parent.taskId);
            assert.deepEqual(state.active.safetyEvidence, returned.safetyEvidence);
            resumed = await authorizationLifecycleFixture({ reviewRunner: transport }, state);
            await resumed.hooks.get("session_start")({ reason: "reload" }, resumed.ctx);
          }
          const runner = resumed ?? fixture;
          const callsBeforeCompletion = transport.calls.length;
          runner.hooks.get("agent_start")({}, runner.ctx);
          runner.hooks.get("turn_start")({}, runner.ctx);
          await finishRun(runner.hooks, runner.ctx, parent.selected);
          await waitForReview(() => transport.calls.length > callsBeforeCompletion);
          const completion = transport.calls.at(-1);
          assert.equal(completion.request.kind, "completion", "recorded work gets review, not another plan review");
          assert.equal(runner.latestLease().taskId, parent.taskId, "the builder remains installed");
          assert.deepEqual(runner.latestLease().selected, parent.selected);
          assert.deepEqual(runner.latestLease().safetyEvidence, returned.safetyEvidence);
          completion.resolve({
            status: "completed",
            verdict: validAdvice(completion.request),
            usage: { cost: 0.01, inputTokens: 1, outputTokens: 1 },
          });
          await waitForReview(() => runner.latestLease().lifecycle.phase === "completed");
          const reviewCount = transport.calls.length;
          await runner.hooks.get("agent_settled")({}, runner.ctx);
          await flushMicrotasks();
          assert.equal(runner.latestLease().lifecycle.phase, "completed");
          assert.equal(transport.calls.length, reviewCount, "settlement cannot reopen completed or failed plan advice");
        } finally {
          resumed?.restoreEnvironment();
          fixture.restoreEnvironment();
        }
      });
    }
  }

  it("preserves the current plan attempt while pruning a full completion history and across reload", async () => {
    const transport = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: transport });
    const notes = [];
    fixture.ctx.ui.notify = (message) => notes.push(message);
    const failures = () => notes.filter((message) => /did not return valid advice/.test(message)).length;
    let resumed;
    try {
      await fixture.hooks.get("session_start")({ reason: "reload" }, fixture.ctx);
      await fixture.tools
        .get("submit_action_plan")
        .execute("plan", irreversibleActionPlan(), undefined, undefined, fixture.ctx);
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      await waitForReview(() => transport.calls.length === 1);
      const planAttempt = fixture.latestLease().reviewAttemptKeys[0];
      transport.calls[0].resolve({ status: "failed", usage: { cost: 1, inputTokens: 1, outputTokens: 1 } });
      await waitForReview(() => failures() === 1);
      for (let index = 0; index < 64; index++) {
        const write = {
          toolCallId: `work-${index}`,
          toolName: "write",
          input: { path: `file-${index}`, content: "x" },
        };
        fixture.hooks.get("tool_call")(write, fixture.ctx);
        fixture.hooks.get("tool_execution_end")({ ...write, isError: false }, fixture.ctx);
        await fixture.hooks.get("agent_settled")({}, fixture.ctx);
        await waitForReview(() => transport.calls.length === index + 2);
        const completion = transport.calls.at(-1);
        assert.equal(completion.request.kind, "completion");
        completion.resolve({ status: "failed", usage: { cost: 1, inputTokens: 1, outputTokens: 1 } });
        await waitForReview(() => failures() === index + 2);
      }
      const keys = fixture.latestLease().reviewAttemptKeys;
      assert.equal(keys.length, 64);
      assert.ok(keys.includes(planAttempt), "completion pruning must not evict the current plan attempt");
      const entries = JSON.parse(JSON.stringify(fixture.appended)).map((entry) => ({ type: "custom", ...entry }));
      const state = restoreLeaseState(entries, "active");
      resumed = await authorizationLifecycleFixture({ reviewRunner: transport }, state);
      await resumed.hooks.get("session_start")({ reason: "reload" }, resumed.ctx);
      const write = { toolCallId: "after-reload", toolName: "write", input: { path: "new-file", content: "x" } };
      resumed.hooks.get("tool_call")(write, resumed.ctx);
      resumed.hooks.get("tool_execution_end")({ ...write, isError: false }, resumed.ctx);
      await resumed.hooks.get("agent_settled")({}, resumed.ctx);
      await waitForReview(() => transport.calls.length === 66);
      assert.equal(
        transport.calls.at(-1).request.kind,
        "completion",
        "the old plan cannot monopolize settlement again",
      );
      assert.equal(resumed.latestLease().reviewAttemptKeys.length, 64);
      assert.ok(resumed.latestLease().reviewAttemptKeys.includes(planAttempt));
    } finally {
      resumed?.restoreEnvironment();
      fixture.restoreEnvironment();
    }
  });

  it("does not retry exhausted completion evidence after restoring a fresh extension", async () => {
    const transport = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: transport });
    fixture.parent.lifecycle = {
      phase: "executing",
      policy: "plan_review_then_completion_review",
      taskFingerprint: "task-fingerprint",
    };
    let resumed;
    try {
      const { hooks, ctx, parent } = fixture;
      const notes = [];
      ctx.ui.notify = (message) => notes.push(message);
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      hooks.get("agent_start")({}, ctx);
      hooks.get("turn_start")({}, ctx);
      const write = { toolCallId: "work", toolName: "write", input: { path: "x", content: "y" } };
      hooks.get("tool_call")(write, ctx);
      hooks.get("tool_execution_end")({ ...write, isError: false }, ctx);
      await finishRun(hooks, ctx, parent.selected);
      await waitForReview(() => transport.calls.length === 1);
      assert.equal(transport.calls[0].request.kind, "completion");
      transport.calls[0].resolve({
        status: "failed",
        usage: { cost: 1, inputTokens: 1, outputTokens: 1 },
      });
      await waitForReview(() => notes.some((message) => /did not return valid advice/.test(message)));
      const entries = JSON.parse(JSON.stringify(fixture.appended)).map((entry) => ({ type: "custom", ...entry }));
      const state = restoreLeaseState(entries, "active");
      resumed = await authorizationLifecycleFixture({ reviewRunner: transport }, state);
      await resumed.hooks.get("session_start")({ reason: "reload" }, resumed.ctx);
      resumed.hooks.get("agent_start")({}, resumed.ctx);
      resumed.hooks.get("turn_start")({}, resumed.ctx);
      await finishRun(resumed.hooks, resumed.ctx, parent.selected);
      await flushMicrotasks();
      assert.equal(transport.calls.length, 1, "a fresh instance must not repeat unchanged exhausted evidence");
      assert.equal(
        resumed.sent.some((s) => s.options?.triggerTurn),
        false,
      );
    } finally {
      resumed?.restoreEnvironment();
      fixture.restoreEnvironment();
    }
  });

  it("notes and reviews work executed during planning without an action plan", async () => {
    const reviewRunner = recordingRunner();
    const completion = deferred();
    reviewRunner.start = (request) => (
      reviewRunner.requests.push(request),
      { result: completion.promise, cancel() {} }
    );
    const fixture = await authorizationLifecycleFixture({ reviewRunner });
    const { hooks, ctx, appended, latestLease, sent, parent } = fixture;
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      hooks.get("agent_start")({}, ctx);
      hooks.get("turn_start")({}, ctx);
      const write = { toolCallId: "unplanned-write", toolName: "write", input: { path: "x", content: "y" } };
      assert.equal(hooks.get("tool_call")(write, ctx), undefined);
      hooks.get("tool_execution_end")({ ...write, isError: false }, ctx);
      await finishRun(hooks, ctx, parent.selected);
      for (let i = 0; i < 200 && reviewRunner.requests.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.deepEqual(
        reviewRunner.requests.map(({ kind }) => kind),
        ["completion"],
      );
      assert.equal(latestLease().taskId, parent.taskId);
      assert.equal(latestLease().lifecycle.phase, "planning");
      assert.deepEqual(latestLease().advisoryStepsNoted, ["action_plan"], "the skipped plan is still noted");
      assert.equal(
        sent.some(({ message }) => message.details?.repairReason === "missing_action_plan"),
        false,
        "executed work is reviewed rather than asked for a plan it no longer precedes",
      );
      // Settle the planless completion review, then prove the result survives reload and continuation.
      const [request] = reviewRunner.requests;
      completion.resolve({
        status: "completed",
        verdict: {
          reviewKind: "completion",
          scopeFingerprint: request.scopeFingerprint,
          verdict: "pass",
          summary: "The unplanned write matches the task.",
          evidence: ["Inspected the recorded mutation."],
          findings: [],
        },
        usage: { cost: 0, inputTokens: 0, outputTokens: 0 },
      });
      for (let i = 0; i < 200 && latestLease().lifecycle.phase !== "completed"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const completed = latestLease();
      assert.equal(completed.taskId, parent.taskId);
      assert.equal(completed.lifecycle.phase, "completed");
      assert.equal(completed.lifecycle.policy, "plan_review_then_completion_review");
      assert.equal(completed.lifecycle.plan, undefined);
      const reloaded = restoreLeaseState(
        appended
          .filter((entry) => entry.customType === "model-router-state")
          .map((entry) => ({ type: "custom", ...entry })),
        "shadow",
      );
      assert.equal(reloaded.active?.taskId, parent.taskId, "planless completed state survives reload");
      assert.deepEqual(reloaded.active.safetyEvidence, completed.safetyEvidence);
      const resumed = resumeCompletedLifecycle(completed.lifecycle);
      assert.deepEqual(
        resumed,
        {
          phase: "executing",
          policy: "plan_review_then_completion_review",
          taskFingerprint: completed.lifecycle.taskFingerprint,
        },
        "a continuation resumes the advisory workflow, not ordinary work",
      );
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("neither reviews nor sends a plan reminder when planning records no executed work", async () => {
    const reviewRunner = recordingRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner });
    const { hooks, ctx, latestLease, sent, parent } = fixture;
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      hooks.get("agent_start")({}, ctx);
      hooks.get("turn_start")({}, ctx);
      await finishRun(hooks, ctx, parent.selected);
      await flushMicrotasks();
      assert.deepEqual(reviewRunner.requests, []);
      assert.equal(latestLease().lifecycle.phase, "planning");
      assert.equal(latestLease().taskId, parent.taskId);
      assert.equal(
        sent.some(({ message }) => message.details?.repairReason === "missing_action_plan"),
        false,
      );
    } finally {
      fixture.restoreEnvironment();
    }
  });
});

describe("routerExtension", () => {
  it("requires the Pi release with custom-start preparation and busy-start semantics", () => {
    for (const version of ["1.0.1", "1.1.0", "1.2.0-rc.1", "1.2.0-beta.2", "broken"]) {
      assert.equal(supportsRouterPiVersion(version), false, version);
    }
    for (const version of ["1.2.0", "1.2.0+build.1", "1.2.1", "1.3.0", "2.0.0"]) {
      assert.equal(supportsRouterPiVersion(version), true, version);
    }
  });

  describe("pending start input", () => {
    const setup = (options = {}) =>
      runAdapterTurn({
        active: adapterLease(),
        prompt: "Continue",
        sessionId: "pending-start-input",
        classifyTask: successfulClassifier(),
        ...options,
      });
    const input = (result, text, extra = {}) =>
      result.hooks.get("input")({ text, source: "interactive", ...extra }, result.ctx);
    const prepare = (result, prompt) =>
      result.hooks.get("before_agent_start")(
        { messageType: "user", prompt, systemPrompt: "system", images: [] },
        result.ctx,
      );
    const boundaries = (result) => result.events.filter(({ kind }) => kind === "boundary");

    it("discards leftover input at agent_end before any telemetry await", async () => {
      const entered = deferred();
      const release = deferred();
      const result = await setup({
        telemetry: ({ events }) => ({
          append: async (event) => {
            events.push(event);
            if (event.kind === "attempt_completed") {
              entered.resolve();
              await release.promise;
            }
          },
          read: async () => [],
        }),
      });
      const initialBoundaries = boundaries(result).length;
      await input(result, "New task: stale input consumed inside the ending run");
      const ending = result.hooks.get("agent_end")({ messages: [] }, result.ctx);
      await entered.promise;
      try {
        // No input event for this start: stale input must not manufacture a task boundary.
        await prepare(result, "A start with no pending input");
        assert.equal(boundaries(result).length, initialBoundaries);
        assert.equal(result.events.filter(({ kind }) => kind === "classifier_invocation").length, 0);
      } finally {
        release.resolve();
        await ending;
      }
    });

    it("does not clear newer input that arrives during agent_end telemetry", async () => {
      const entered = deferred();
      const release = deferred();
      const result = await setup({
        telemetry: ({ events }) => ({
          append: async (event) => {
            events.push(event);
            if (event.kind === "attempt_completed") {
              entered.resolve();
              await release.promise;
            }
          },
          read: async () => [],
        }),
      });
      const ending = result.hooks.get("agent_end")({ messages: [] }, result.ctx);
      await entered.promise;
      try {
        await input(result, "New task: newer request", { source: "extension" });
      } finally {
        release.resolve();
        await ending;
      }
      await prepare(result, "New task: newer request");
      assert.equal(boundaries(result).at(-1).data.source, "extension");
      assert.equal(result.events.filter(({ kind }) => kind === "classifier_invocation").length, 1);
    });

    it("never stages queued input or overwrites the idle prompt awaiting preparation", async (t) => {
      for (const streamingBehavior of ["steer", "followUp"]) {
        for (const source of ["interactive", "rpc", "extension"]) {
          await t.test(`${source}/${streamingBehavior}`, async () => {
            const result = await setup();
            const initialBoundaries = boundaries(result).length;
            await input(result, "Queued input", { source, streamingBehavior });
            await prepare(result, "A start with no pending input");
            assert.equal(boundaries(result).length, initialBoundaries, "queued input has no separate start");
            await input(result, "New task: idle prompt");
            await input(result, "Queued input during pre-run compaction", { source, streamingBehavior });
            await prepare(result, "New task: idle prompt");
            assert.equal(boundaries(result).at(-1).data.source, "interactive");
            assert.equal(result.events.filter(({ kind }) => kind === "classifier_invocation").length, 1);
          });
        }
      }
    });

    it("does not stage busy input even when Pi will reject it for missing streamingBehavior", async () => {
      const result = await setup();
      const initialBoundaries = boundaries(result).length;
      result.ctx.isIdle = () => false;
      await input(result, "New task: rejected busy prompt");
      result.ctx.isIdle = () => true;
      await prepare(result, "A start with no pending input");
      assert.equal(boundaries(result).length, initialBoundaries);
      assert.equal(result.events.filter(({ kind }) => kind === "classifier_invocation").length, 0);
    });

    it("custom starts neither consume nor classify a pending user prompt", async () => {
      const result = await setup({ mode: "active" });
      const initialBoundaries = boundaries(result).length;
      await input(result, "New task: real user request");
      const beforeCustom = structuredClone({
        events: result.events,
        appended: result.appended,
        models: result.selectedModels,
        efforts: result.selectedEfforts,
      });
      for (const customType of ["model-router-context", "another-extension"]) {
        const custom = await result.hooks.get("before_agent_start")(
          {
            messageType: "custom",
            message: { role: "custom", customType, content: "Continue", display: false, timestamp: Date.now() },
            systemPrompt: "system",
          },
          result.ctx,
        );
        assert.ok(custom?.systemPrompt, "custom starts compile the active profile without consuming user input");
        assert.equal(boundaries(result).length, initialBoundaries);
        assert.deepEqual(
          {
            events: result.events,
            appended: result.appended,
            models: result.selectedModels,
            efforts: result.selectedEfforts,
          },
          beforeCustom,
          "custom starts must not classify, change the lease, or select a model/effort",
        );
      }
      await prepare(result, "New task: real user request");
      assert.equal(result.events.filter(({ kind }) => kind === "classifier_invocation").length, 1);
    });

    it("discards leftover input on session shutdown, startup, and route off", async (t) => {
      for (const boundary of ["session_shutdown", "session_start", "off"]) {
        await t.test(boundary, async () => {
          const result = await setup();
          await input(result, "New task: input from the previous context");
          if (boundary === "off") {
            await result.commands.get("route").handler("off", result.ctx);
            await result.commands.get("route").handler("shadow", result.ctx);
          } else {
            await result.hooks.get(boundary)({ reason: "reload" }, result.ctx);
          }
          const initialBoundaries = boundaries(result).length;
          await prepare(result, "A start with no pending input");
          assert.equal(boundaries(result).length, initialBoundaries);
          assert.equal(result.events.filter(({ kind }) => kind === "classifier_invocation").length, 0);
        });
      }
    });
  });

  it("retains the existing selection and lease for every fresh-task invocation failure class", async (t) => {
    for (const errorName of ["AbortError", "TimeoutError", "Error"]) {
      await t.test(errorName, async () => {
        const active = adapterLease();
        const failure = new Error(`${errorName} classifier fixture`);
        failure.name = errorName;
        const result = await runAdapterTurn({
          classifyTask: async () => {
            throw failure;
          },
          active,
          prompt: "New task: implement a separate change",
          sessionId: `fresh-failure-${errorName}`,
          // Shadow mode never applies a selection at all, so retention is only observable in active mode.
          mode: "active",
        });

        assert.equal(
          result.notifications.some(({ message }) => message.startsWith("Shadow route:")),
          false,
          "shadow mode would skip model application entirely, making the retention claim vacuous",
        );
        assert.equal(result.selectedModels.length, 0, "classification failure must not select a model");
        assert.equal(result.selectedEfforts.length, 0, "classification failure must not change effort");
        await result.commands.get("route").handler("", result.ctx);
        assert.ok((result.notifications.at(-1)?.message ?? "").includes("mode=active"));
        assert.ok((result.notifications.at(-1)?.message ?? "").includes(`task=${active.taskId}`));
        assert.ok(
          result.notifications.some(({ message }) => /keeping the current model selection/i.test(message)),
          `${errorName} must report fail-safe selection retention`,
        );
        assert.equal(result.events.filter(({ kind }) => kind === "classifier_invocation").length, 1);
        assert.equal(result.events.filter(({ kind }) => kind === "classifier_attempt").length, 0);
      });
    }
  });

  it("treats idle extension-generated input as new user intent that cannot inherit an approval", async (t) => {
    // pi labels a turn `source: "extension"` only when an extension called `sendUserMessage`, which
    // runs the ordinary prompt path and carries no streamingBehavior while the agent is idle. The
    // router's own continuations are custom messages that never reach the input hook, so extension
    // input is treated exactly like typed input: it invalidates a standing authorization and it
    // cannot outrank a pending hard boundary.
    const sessionId = "extension-input-authorization";
    const validated = validateActionPlan(irreversibleActionPlan());
    assert.equal(validated.success, true, "the authorization fixture needs a valid plan fingerprint");
    const plan = {
      taskFingerprint: "task-fingerprint",
      planFingerprint: validated.fingerprint,
      submittedAt: "2026-08-13T00:00:00.000Z",
      plan: irreversibleActionPlan(),
    };
    const authorizedLease = () => ({
      ...adapterLease(),
      lifecycle: {
        phase: "executing",
        policy: "plan_review_then_completion_review",
        taskFingerprint: plan.taskFingerprint,
        plan,
        authorization: {
          taskFingerprint: plan.taskFingerprint,
          planFingerprint: plan.planFingerprint,
          reviewTaskId: "review",
          reviewerVendor: "anthropic",
          sessionId,
          approvedAt: "2026-08-13T00:01:00.000Z",
        },
      },
    });

    await t.test("does not outrank a pending hard boundary", async () => {
      const result = await runAdapterTurn({
        classifyTask: successfulClassifier(1),
        active: authorizedLease(),
        prompt: "Continue",
        sessionId: `${sessionId}-boundary`,
        source: "extension",
        reason: "startup",
      });
      const boundary = result.events.find(({ kind }) => kind === "boundary");
      assert.equal(boundary.data.source, "extension");
      assert.equal(boundary.data.action, "new_task");
      assert.match(boundary.data.reason, /hard boundary: new_session/);
    });
  });

  it("enforces non-additive classifier invocation and legacy attempt cardinality", async (t) => {
    const scenarios = [
      {
        name: "retained continuity",
        active: adapterLease(),
        prompt: "Please inspect the remaining details",
        classifyTask: successfulClassifier(1, { taskContinuity: "clear_continuation" }),
        legacyAttempts: 0,
      },
      {
        name: "terminal failure",
        active: adapterLease(),
        prompt: "New task: inspect another change",
        classifyTask: async () => {
          const error = new Error("terminal fixture");
          error.name = "AbortError";
          throw error;
        },
        legacyAttempts: 0,
      },
      {
        name: "single-attempt success",
        prompt: "Implement one bounded change",
        classifyTask: successfulClassifier(1),
        legacyAttempts: 1,
      },
      {
        name: "escalated classification",
        prompt: "Implement one high-risk bounded change",
        classifyTask: successfulClassifier(2, { risk: "high" }),
        legacyAttempts: 2,
      },
    ];

    for (const scenario of scenarios) {
      await t.test(scenario.name, async () => {
        const result = await runAdapterTurn({
          ...scenario,
          sessionId: `cardinality-${scenario.name.replaceAll(" ", "-")}`,
        });
        const invocations = result.events.filter(({ kind }) => kind === "classifier_invocation");
        const legacyAttempts = result.events.filter(({ kind }) => kind === "classifier_attempt");
        assert.equal(invocations.length, 1, "one router request must emit exactly one request metric");
        assert.equal(invocations[0].data.invocationCount, 1);
        assert.equal(legacyAttempts.length, scenario.legacyAttempts);
        assert.equal(
          invocations[0].data.attemptCount,
          scenario.name === "terminal failure" ? 0 : scenario.name === "escalated classification" ? 2 : 1,
        );
      });
    }
  });

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
      "turn_end",
      "tool_execution_start",
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
    assert.equal(tools.has("submit_action_plan"), true);
    assert.equal(tools.has("submit_safety_review"), true);
  });

  it("pauses routing, selection tracking, and advisory guidance immediately on /route off", async () => {
    const hooks = new Map();
    const commands = new Map();
    const tools = new Map();
    const appended = [];
    const telemetryEvents = [];
    const selectedModels = [];
    const selectedEfforts = [];
    const workingMessages = [];
    const notifications = [];
    let classifications = 0;
    let activeTools = ["read", "bash", "submit_implementation_plan", "submit_action_plan"];
    const sentMessages = [];
    const active = {
      ...adapterLease(),
      lifecycle: {
        phase: "planning",
        policy: "plan_review_then_completion_review",
        taskFingerprint: "task-fingerprint",
      },
    };
    const branch = [
      {
        type: "custom",
        customType: "model-router-state",
        data: { secondarySafetyPending: false, mode: "active", manualOverride: false, active },
      },
    ];
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: (tool) => tools.set(tool.name, tool),
      appendEntry: (customType, data) => appended.push({ customType, data }),
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      getActiveTools: () => activeTools,
      setActiveTools: (tools) => {
        activeTools = tools;
      },
      sendMessage: (message, options) => sentMessages.push({ message, options }),
      getThinkingLevel: () => "high",
      setThinkingLevel: (effort) => selectedEfforts.push(effort),
      setModel: async (model) => {
        selectedModels.push(model);
        return true;
      },
    };
    const ctx = {
      cwd: "/repo",
      model: registryModelForChoice(active.selected),
      modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
      sessionManager: { getBranch: () => branch, getSessionId: () => "off-bypass-session" },
      getContextUsage: () => ({ tokens: 0, contextWindow: 128_000 }),
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        setWorkingMessage: (message) => workingMessages.push(message),
        setWorkingVisible: () => {},
        notify: (message, type) => notifications.push({ message, type }),
      },
    };
    routerExtension(pi, {
      telemetry: { append: async (event) => telemetryEvents.push(event), read: async () => [] },
      classifyTask: async () => {
        classifications++;
        return classificationResult();
      },
    });

    await hooks.get("session_start")({ reason: "reload" }, ctx);
    assert.deepEqual(activeTools, ["read", "bash", "submit_implementation_plan", "submit_action_plan"]);
    await commands.get("route").handler("off", ctx);
    assert.equal(sentMessages.length, 1, "off must tell the model preflight guidance is paused");
    assert.equal(sentMessages[0].options.deliverAs, "nextTurn");
    assert.equal(sentMessages[0].message.display, false);
    assert.match(sentMessages[0].message.content, /Advisory planning guidance is paused/);
    await commands.get("route").handler("off", ctx);
    assert.equal(sentMessages.length, 1, "a repeated off must not repeat the notice");
    const entriesAfterOff = appended.length;
    const telemetryAfterOff = telemetryEvents.length;

    assert.equal(
      hooks.get("tool_call")({ toolCallId: "off-edit", toolName: "edit", input: { path: "README.md" } }),
      undefined,
      "off mode must not enforce the persisted preflight lifecycle",
    );
    await hooks.get("model_select")({ source: "user", model: { provider: "anthropic", id: "claude-opus-5-5" } }, ctx);
    await hooks.get("thinking_level_select")({ level: "low" }, ctx);
    assert.deepEqual(activeTools, ["read", "bash"], "off mode must immediately remove router lifecycle tools");
    assert.equal(
      appended.length,
      entriesAfterOff,
      "off-mode selection hooks must not mutate the persisted router lease",
    );
    assert.equal(telemetryEvents.length, telemetryAfterOff, "off-mode selection hooks must not emit routing telemetry");

    for (const args of ["accept", "reject", "fail availability"]) {
      await commands.get("route").handler(args, ctx);
      assert.match(notifications.at(-1).message, /router is off/i, `/route ${args} must be inert while off`);
    }
    assert.equal(telemetryEvents.length, telemetryAfterOff, "off mode must not label or fail over a routed attempt");
    assert.deepEqual(selectedModels, []);

    await commands.get("route").handler("active", ctx);
    assert.equal(sentMessages.length, 2, "re-enabling must correct the earlier off notice");
    assert.equal(sentMessages[1].message.details.restoredPhase, "planning");
    assert.match(sentMessages[1].message.content, /Advisory planning guidance has resumed/);
    await hooks.get("input")({ text: "Queue a route, then disable it", source: "interactive" }, ctx);
    await commands.get("route").handler("off", ctx);
    const entriesAfterPendingOff = appended.length;
    const telemetryAfterPendingOff = telemetryEvents.length;
    const startResult = await hooks.get("before_agent_start")(
      { prompt: "Queue a route, then disable it", systemPrompt: "base", images: [] },
      ctx,
    );
    hooks.get("agent_start")();
    hooks.get("turn_start")();
    hooks.get("tool_execution_end")({ toolCallId: "off-edit", toolName: "edit", isError: false });
    hooks.get("after_provider_response")({ status: 500 });
    await hooks.get("agent_end")({ messages: [] }, ctx);
    await hooks.get("agent_settled")({}, ctx);

    assert.equal(startResult, undefined);
    assert.equal(classifications, 0);
    assert.deepEqual(selectedModels, []);
    assert.deepEqual(selectedEfforts, []);
    assert.deepEqual(workingMessages, ["Routing...", undefined]);
    assert.equal(appended.length, entriesAfterPendingOff, "off-mode hooks must not mutate the persisted router lease");
    assert.equal(telemetryEvents.length, telemetryAfterPendingOff, "off-mode hooks must not emit routing telemetry");

    await commands.get("route").handler("active", ctx);
    assert.deepEqual(
      activeTools,
      ["read", "bash", "submit_action_plan", "submit_implementation_plan"],
      "re-enabling restores preflight tools immediately",
    );
    await commands.get("route").handler("shadow", ctx);
    assert.deepEqual(activeTools, ["read", "bash"], "shadow must hide all router-only tools just like off");
    assert.equal(
      hooks.get("tool_call")({ toolCallId: "shadow-edit", toolName: "edit", input: { path: "README.md" } }),
      undefined,
      "shadow must not enforce the persisted preflight lifecycle",
    );
    await assert.rejects(
      tools.get("submit_action_plan").execute("shadow-plan", irreversibleActionPlan(), undefined, undefined, ctx),
      /available during active advisory planning/,
    );
    await assert.rejects(
      tools.get("submit_safety_review").execute("shadow-review", {}, undefined, undefined, ctx),
      /independent reviewer session/,
    );
    await commands.get("route").handler("active", ctx);
    assert.ok(activeTools.includes("submit_action_plan"));
    assert.equal(activeTools.includes("submit_safety_review"), false);
    assert.equal(
      hooks.get("tool_call")({ toolCallId: "active-edit", toolName: "edit", input: { path: "README.md" } }),
      undefined,
      "re-enabling restores advisory context without restricting tool calls",
    );
  });

  it("observes a shadow route without blocking a persisted safety lifecycle", async () => {
    const result = await runAdapterTurn({
      classifyTask: successfulClassifier(1, { taskContinuity: "clear_continuation" }),
      active: {
        ...adapterLease(),
        lifecycle: {
          phase: "planning",
          policy: "plan_review_then_completion_review",
          taskFingerprint: "shadow-task",
        },
      },
      prompt: "Continue",
      sessionId: "shadow-preflight-bypass",
    });

    assert.equal(result.beforeAgentStart, undefined);
    assert.deepEqual(result.selectedModels, []);
    assert.deepEqual(result.selectedEfforts, []);
    assert.deepEqual(result.sentMessages, []);
    assert.deepEqual(result.activeTools, []);
    assert.ok(result.events.some(({ kind }) => kind === "boundary"));
    for (const toolName of ["edit", "bash", "custom_mutator"]) {
      assert.equal(
        result.hooks.get("tool_call")({ toolCallId: `shadow-${toolName}`, toolName, input: { command: "deploy" } }),
        undefined,
        `${toolName} remains available in shadow`,
      );
    }
    startAgentRun(result);
    await result.hooks.get("agent_end")({ messages: [] }, result.ctx);
    assert.equal(result.events.findLast(({ kind }) => kind === "attempt_completed")?.data.shadow, true);
    assert.equal(result.abortCount, 0);
    assert.deepEqual(result.sentMessages, []);
  });

  it("discards routing work already in flight when /route off lands", async (t) => {
    // off → shadow proves the generation check, not merely the off-mode guards, discards the result.
    for (const reenable of [undefined, "shadow"]) {
      await t.test(reenable ?? "off", async () => {
        const hooks = new Map();
        const commands = new Map();
        const appended = [];
        const telemetryEvents = [];
        const selectedModels = [];
        const selectedEfforts = [];
        const classifierStarted = deferred();
        const classifierResult = deferred();
        let activeTools = ["read", "bash", "submit_implementation_plan"];
        const sentMessages = [];
        const active = {
          ...adapterLease(),
          lifecycle: {
            phase: "planning",
            policy: "plan_review_then_completion_review",
            taskFingerprint: "task-fingerprint",
          },
        };
        const leasedModel = registryModelForChoice(active.selected);
        const branch = [
          {
            type: "custom",
            customType: "model-router-state",
            data: { secondarySafetyPending: false, mode: "active", manualOverride: false, active },
          },
        ];
        const pi = {
          on: (event, handler) => hooks.set(event, handler),
          registerCommand: (name, command) => commands.set(name, command),
          registerTool: () => {},
          appendEntry: (customType, data) => appended.push({ customType, data }),
          exec: async () => ({ code: 1, stdout: "", stderr: "" }),
          getActiveTools: () => activeTools,
          setActiveTools: (tools) => {
            activeTools = tools;
          },
          sendMessage: (message, options) => sentMessages.push({ message, options }),
          getThinkingLevel: () => "low",
          setThinkingLevel: (effort) => selectedEfforts.push(effort),
          setModel: async (model) => {
            selectedModels.push(model);
            return true;
          },
        };
        const ctx = {
          cwd: "/repo",
          // The current model differs from the lease, so an applied route would have to call setModel.
          model: { ...leasedModel, provider: "openai" },
          modelRegistry: {
            getAll: () => [leasedModel],
            getAvailable: () => [leasedModel],
            find: (provider, id) =>
              provider === leasedModel.provider && id === leasedModel.id ? leasedModel : undefined,
          },
          sessionManager: { getBranch: () => branch, getSessionId: () => "in-flight-off-session" },
          getContextUsage: () => ({ tokens: 0, contextWindow: 128_000 }),
          ui: {
            theme: { fg: (_color, text) => text },
            setStatus: () => {},
            setWorkingMessage: () => {},
            setWorkingVisible: () => {},
            notify: () => {},
          },
        };
        routerExtension(pi, {
          telemetry: { append: async (event) => telemetryEvents.push(event), read: async () => [] },
          classifyTask: async () => {
            classifierStarted.resolve();
            return classifierResult.promise;
          },
        });

        await hooks.get("session_start")({ reason: "reload" }, ctx);
        const prompt = "Continue the credential rotation plan";
        await hooks.get("input")({ text: prompt, source: "interactive" }, ctx);
        const start = hooks.get("before_agent_start")({ prompt, systemPrompt: "base", images: [] }, ctx);
        await classifierStarted.promise;
        await commands.get("route").handler("off", ctx);
        // The in-flight hook has not started the agent run, so the notice waits for the next turn.
        assert.deepEqual(
          sentMessages.map(({ message, options }) => [message.details.liftedPhase, options.deliverAs]),
          [["planning", "nextTurn"]],
        );
        if (reenable) {
          await commands.get("route").handler(reenable, ctx);
          assert.deepEqual(
            sentMessages.map(({ message }) => message.details.reconciliation),
            ["router_off"],
            "shadow must not announce restored safety restrictions",
          );
        }
        const entriesAfterOff = appended.length;
        const telemetryAfterOff = telemetryEvents.length;
        classifierResult.resolve(classificationResult(1, { taskContinuity: "clear_continuation" }));

        assert.equal(await start, undefined, "a superseded hook must not return a compiled prompt");
        assert.deepEqual(selectedModels, [], "a superseded hook must not apply the leased model");
        assert.deepEqual(selectedEfforts, [], "a superseded hook must not apply the leased effort");
        assert.equal(appended.length, entriesAfterOff, "a superseded hook must not persist a lease");
        assert.equal(telemetryEvents.length, telemetryAfterOff, "a superseded hook must not emit routing telemetry");
        assert.equal(
          activeTools.includes("submit_action_plan"),
          false,
          "a superseded hook must not re-expose lifecycle validators",
        );
        assert.equal(activeTools.includes("submit_implementation_plan"), false);
        await commands.get("route").handler("active", ctx);
        assert.deepEqual(
          sentMessages.map(({ message }) => message.details.reconciliation),
          ["router_off", "router_reenabled"],
          "active must supersede the off notice even after passing through shadow",
        );
        assert.ok(activeTools.includes("submit_implementation_plan"));
      });
    }
  });

  it("dispatches no-cache secondary classification off the critical path", async () => {
    const secondary = deferred();
    let secondaryStartedAt = 0;
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () => {
        secondaryStartedAt = Date.now();
        return secondary.promise;
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-no-cache",
    });

    assert.ok(secondaryStartedAt > 0, "the provider-diverse secondary must start in the background");
    assert.equal(result.events.filter(({ kind }) => kind === "classifier_invocation").length, 1);
    assert.equal(result.events.filter(({ kind }) => kind === "secondary_reconciliation").length, 0);

    secondary.resolve(classificationResult(2, { confidence: 0.95 }));
    await flushMicrotasks();
  });

  it("does not start background reconciliation after an already reconciled continuity classification", async () => {
    let secondaryCalls = 0;
    const result = await runAdapterTurn({
      active: adapterLease(),
      classifyTask: successfulClassifier(2, { confidence: 0.6, risk: "high", taskContinuity: "new_task" }),
      classifySecondaryTask: async () => {
        secondaryCalls++;
        return classificationResult(2, { confidence: 0.95 });
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Please inspect the remaining details",
      sessionId: "async-secondary-already-reconciled",
    });

    assert.equal(secondaryCalls, 0);
    assert.equal(result.events.filter(({ kind }) => kind === "secondary_reconciliation").length, 0);
    assert.equal(
      result.events.filter(
        ({ kind, data }) => kind === "classifier_invocation" && data.purpose === "secondary_reconciliation",
      ).length,
      0,
    );
  });

  it("drops a previous input's secondary even when the new input continues the same task", async () => {
    const secondary = deferred();
    const continuity = successfulClassifier(1, { taskContinuity: "clear_continuation" });
    let continuityCalls = 0;
    const result = await runAdapterTurn({
      classifyTask: async (input) => {
        continuityCalls++;
        secondary.resolve(
          classificationResult(2, {
            confidence: 0.95,
            risk: "critical",
            verificationStrength: "security_and_policy",
            independenceRequirement: "different_vendor_review",
          }),
        );
        await flushMicrotasks();
        return continuity(input);
      },
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.9, risk: "high" }),
      classifySecondaryTask: async () => secondary.promise,
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one high-risk bounded repository change",
      sessionId: "async-secondary-stale-continuation",
    });
    const original = result.appended.findLast(({ customType }) => customType === "model-router-state").data.active;

    await result.hooks.get("input")({ text: "Continue with the same change", source: "interactive" }, result.ctx);
    const prepared = await result.hooks.get("before_agent_start")(
      { prompt: "Continue with the same change", systemPrompt: "system", images: [] },
      result.ctx,
    );
    const active = result.appended.findLast(({ customType }) => customType === "model-router-state").data.active;
    assert.equal(continuityCalls, 1);
    assert.equal(active.taskId, original.taskId);
    assert.deepEqual(active.features, original.features, "new input invalidates the captured secondary epoch");
    assert.deepEqual(active.selected, original.selected);
    assert.equal(prepared.message.details.profileId, original.promptProfileId);
    const outcomes = result.events.filter(({ kind }) => kind === "secondary_reconciliation");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].data.accepted, false);
    assert.equal(outcomes[0].data.reason, "routing_context_changed");
    assert.equal(outcomes[0].data.swapBoundary, "dropped");
    assert.equal(result.abortCount, 0);
  });

  it("aborts prior secondary work at a new-task boundary even when the new task keeps the old lease", async () => {
    const firstSecondary = deferred();
    let firstSignal;
    const result = await runAdapterTurn({
      classifyTask: successfulClassifier(1, { taskContinuity: "new_task" }),
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async ({ signal }) => {
        firstSignal = signal;
        return firstSecondary.promise;
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-new-task-retained-lease",
    });

    // The new task is unroutable, so the router keeps the previous lease; the previous task's
    // secondary must still stop rather than reconcile against the new prompt's run.
    result.ctx.modelRegistry = { ...result.ctx.modelRegistry, getAll: () => [], getAvailable: () => [] };
    await result.hooks.get("input")(
      { text: "Implement a different bounded repository change", source: "interactive" },
      result.ctx,
    );
    await result.hooks.get("before_agent_start")(
      { prompt: "Implement a different bounded repository change", systemPrompt: "system", images: [] },
      result.ctx,
    );

    assert.ok(
      result.events.some(({ kind, data }) => kind === "route_decision" && data.kind === "unroutable"),
      "the new task must take the retained-lease path",
    );
    assert.equal(firstSignal.aborted, true);
    assert.equal(
      result.events.findLast(({ kind }) => kind === "secondary_reconciliation")?.data.reason,
      "superseded_task",
    );
    firstSecondary.resolve(classificationResult(2, { confidence: 0.95 }));
    await flushMicrotasks();
  });

  it("aborts prior secondary work when a new lease supersedes it", async () => {
    const firstSecondary = deferred();
    const secondSecondary = deferred();
    let secondaryCalls = 0;
    let firstSignal;
    let secondSignal;
    const result = await runAdapterTurn({
      classifyTask: successfulClassifier(1, { taskContinuity: "new_task" }),
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async ({ signal }) => {
        secondaryCalls++;
        if (secondaryCalls === 1) {
          firstSignal = signal;
          return firstSecondary.promise;
        }
        secondSignal = signal;
        return secondSecondary.promise;
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-superseded-lease",
    });

    await result.hooks.get("input")(
      { text: "Implement a different bounded repository change", source: "interactive" },
      result.ctx,
    );
    await result.hooks.get("before_agent_start")(
      { prompt: "Implement a different bounded repository change", systemPrompt: "system", images: [] },
      result.ctx,
    );

    assert.equal(firstSignal.aborted, true);
    assert.equal(secondSignal?.aborted ?? false, false);
    assert.equal(
      result.events.findLast(({ kind }) => kind === "secondary_reconciliation")?.data.reason,
      "superseded_task",
    );

    firstSecondary.resolve(classificationResult(2, { confidence: 0.95 }));
    secondSecondary.resolve(classificationResult(2, { confidence: 0.95 }));
    await flushMicrotasks();
  });

  it("releases the low-confidence primary immediately even with reusable cached context", async () => {
    const secondary = deferred();
    let signal;
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async (input) => {
        signal = input.signal;
        return secondary.promise;
      },
      secondaryReconciliationPolicy: { secondaryDeadlineMs: 1_000, materialCorrectionBenefitUsd: 0.02 },
      branchEntries: [cachedAssistantEntry()],
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-cached-nonblocking",
    });
    const active = result.appended.findLast(({ customType }) => customType === "model-router-state").data.active;
    assert.equal(active.features.confidence, 0.6, "preparation must finish without waiting for the secondary");
    assert.equal(result.beforeAgentStart.message.details.profileId, active.promptProfileId);
    assert.equal(result.selectedModels.at(-1).id, active.selected.modelId);
    assert.equal(result.selectedEfforts.at(-1), active.selected.effort);
    assert.equal(signal.aborted, false);
    assert.equal(
      result.events.some(({ kind }) => kind === "secondary_reconciliation"),
      false,
    );
    assert.equal(result.abortCount, 0);
    assert.deepEqual(result.sentMessages, []);
    await result.hooks.get("session_shutdown")({ reason: "quit" });
    secondary.resolve(classificationResult(2));
    await flushMicrotasks();
  });

  it("does not block tools or abort the run while secondary classification is pending", async () => {
    const secondary = deferred();
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () => secondary.promise,
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-nonblocking",
    });
    startAgentRun(result);

    for (const [toolName, input] of [
      ["edit", { path: "README.md", oldString: "old", newString: "new" }],
      ["submit_implementation_plan", {}],
      ["bash", { command: "git status --short" }],
    ]) {
      assert.equal(result.hooks.get("tool_call")({ toolCallId: "while-pending", toolName, input }), undefined);
    }
    assert.equal(result.abortCount, 0);
    assert.deepEqual(result.sentMessages, []);
    secondary.resolve(classificationResult(2, { confidence: 0.95 }));
    await flushMicrotasks();
    await endAgentTurn(result);
    assert.equal(
      result.events.findLast(({ kind }) => kind === "secondary_reconciliation")?.data.reason,
      "no_material_delta",
    );
    assert.equal(result.abortCount, 0);
  });

  it("does not start secondary work when input supersedes preparation during the route ledger write", async () => {
    let secondaryCalls = 0;
    let injected = false;
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () => {
        secondaryCalls++;
        return classificationResult(2);
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "secondary-after-route-ledger",
      telemetry: ({ hooks, events, getCtx }) => ({
        append: async (event) => {
          events.push(event);
          if (event.kind === "route_decision" && !injected) {
            injected = true;
            await hooks.get("input")(
              { text: "Also cover the error path", source: "interactive", streamingBehavior: "steer" },
              getCtx(),
            );
          }
        },
        read: async () => [],
      }),
    });

    await flushMicrotasks();
    assert.equal(injected, true);
    assert.equal(secondaryCalls, 0, "secondary work begins only after the route ledger write is current");
    assert.equal(result.beforeAgentStart, undefined);
    assert.equal(
      result.events.some(
        ({ kind, data }) => kind === "classifier_invocation" && data.purpose === "secondary_reconciliation",
      ),
      false,
    );
    assert.equal(result.abortCount, 0);
  });

  it("records secondary failure without adding a tool block or interrupting the primary", async () => {
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () => {
        throw new Error("secondary transport failed");
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-failure-nonblocking",
    });
    startAgentRun(result);
    await settleAgentRun(result);
    const reconciliation = result.events.findLast(({ kind }) => kind === "secondary_reconciliation");
    assert.equal(reconciliation?.data.reason, "secondary_failed");
    assert.equal(reconciliation?.data.accepted, false);
    assert.equal(
      result.hooks.get("tool_call")({
        toolCallId: "edit-after-failure",
        toolName: "edit",
        input: { path: "README.md", oldString: "old", newString: "new" },
      }),
      undefined,
    );
    assert.equal(result.abortCount, 0);
    assert.deepEqual(result.sentMessages, []);
  });

  it("keeps the primary usable when secondary schema attempts produce no provider-diverse answer", async () => {
    const secondary = deferred();
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () => secondary.promise,
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-schema-exhausted",
    });
    startAgentRun(result);
    // Schema exhaustion returns primary features without secondaryFeatures or secondaryVendor.
    secondary.resolve({ ...classificationResult(1, { confidence: 0.6 }), escalated: true });
    await flushMicrotasks();
    await settleAgentRun(result);
    assert.equal(
      result.events.findLast(({ kind }) => kind === "secondary_reconciliation")?.data.reason,
      "no_material_delta",
    );
    assert.equal(
      result.hooks.get("tool_call")({
        toolCallId: "edit-after-schema-exhaustion",
        toolName: "edit",
        input: { path: "README.md", oldString: "old", newString: "new" },
      }),
      undefined,
    );
    assert.equal(result.abortCount, 0);
  });

  it("does not wait for secondary settlement telemetry before releasing the primary prompt", async () => {
    const telemetryStarted = deferred();
    const releaseTelemetry = deferred();
    const events = [];
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () =>
        classificationResult(2, {
          confidence: 0.95,
          risk: "critical",
          verificationStrength: "security_and_policy",
          independenceRequirement: "different_vendor_review",
        }),
      telemetry: {
        append: async (event) => {
          events.push(event);
          if (event.kind === "classifier_invocation" && event.data.purpose === "secondary_reconciliation") {
            telemetryStarted.resolve();
            await releaseTelemetry.promise;
          }
        },
        read: async () => [],
      },
      branchEntries: [cachedAssistantEntry()],
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-nonblocking-telemetry",
    });
    await telemetryStarted.promise;
    assert.ok(result.beforeAgentStart.systemPrompt, "the primary prompt is released while the ledger is stalled");
    const active = result.appended.findLast(({ customType }) => customType === "model-router-state").data.active;
    assert.equal(active.features.confidence, 0.6);
    assert.equal(result.beforeAgentStart.message.details.profileId, active.promptProfileId);
    assert.equal(result.abortCount, 0);
    assert.equal(
      events.some(({ kind }) => kind === "secondary_reconciliation"),
      false,
    );
    releaseTelemetry.resolve();
    await flushMicrotasks();
    await result.hooks.get("session_shutdown")({ reason: "quit" });
  });

  it("rejects a material correction whose cache-switch cost exceeds its benefit", async () => {
    const secondary = deferred();
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () => secondary.promise,
      secondaryReconciliationPolicy: { secondaryDeadlineMs: 15_000, materialCorrectionBenefitUsd: 0.000_001 },
      branchEntries: [cachedAssistantEntry()],
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-cost-rejection",
    });
    const original = result.appended.findLast(({ customType }) => customType === "model-router-state").data.active;
    const selections = result.selectedModels.length;
    const efforts = result.selectedEfforts.length;
    startAgentRun(result);
    await settleAgentRun(result, { stopReason: "aborted" });

    secondary.resolve(
      classificationResult(2, {
        confidence: 0.95,
        risk: "critical",
        verificationStrength: "security_and_policy",
        independenceRequirement: "different_vendor_review",
      }),
    );
    await waitUntil(() => result.events.some(({ kind }) => kind === "secondary_reconciliation"));
    const reconciliation = result.events.findLast(({ kind }) => kind === "secondary_reconciliation");
    assert.equal(reconciliation.data.accepted, false);
    assert.equal(reconciliation.data.reason, "cache_penalty_exceeds_benefit");
    assert.equal(reconciliation.data.swapBoundary, "rejected");
    assert.ok(reconciliation.data.estimatedCachePenaltyUsd > reconciliation.data.expectedBenefitUsd);
    const active = result.appended.findLast(({ customType }) => customType === "model-router-state").data.active;
    assert.equal(active, original);
    assert.equal(result.selectedModels.length, selections);
    assert.equal(result.selectedEfforts.length, efforts);
    assert.equal(result.abortCount, 0);
    assert.deepEqual(result.sentMessages, []);
  });

  for (const [shape, usage] of [
    ["partly cached", {}],
    ["fully cached (input 0)", { input: 0, cacheRead: 80_000 }],
  ]) {
    it(`prices a deferred correction against the cache accumulated by the primary run (${shape})`, async () => {
      const secondary = deferred();
      const result = await runAdapterTurn({
        classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
        classifySecondaryTask: async () => secondary.promise,
        secondaryReconciliationPolicy: { secondaryDeadlineMs: 15_000, materialCorrectionBenefitUsd: 0.000_001 },
        models: standardRoutingModels(),
        mode: "active",
        prompt: "Implement one bounded repository change",
        sessionId: `async-secondary-cost-after-primary-cache-${shape}`,
      });
      const original = result.appended.findLast(({ customType }) => customType === "model-router-state").data.active;
      startAgentRun(result);
      // The task was routed without cached context; the primary run then builds it on the incumbent.
      result.ctx.sessionManager.getBranch().push(cachedAssistantEntry(usage));
      await settleAgentRun(result, { stopReason: "aborted" });

      secondary.resolve(
        classificationResult(2, {
          confidence: 0.95,
          risk: "critical",
          verificationStrength: "security_and_policy",
          independenceRequirement: "different_vendor_review",
        }),
      );
      await waitUntil(() => result.events.some(({ kind }) => kind === "secondary_reconciliation"));
      const reconciliation = result.events.findLast(({ kind }) => kind === "secondary_reconciliation");
      assert.equal(reconciliation.data.accepted, false);
      assert.equal(reconciliation.data.reason, "cache_penalty_exceeds_benefit");
      assert.ok(reconciliation.data.estimatedCachePenaltyUsd > reconciliation.data.expectedBenefitUsd);
      const active = result.appended.findLast(({ customType }) => customType === "model-router-state").data.active;
      assert.equal(active, original);
      assert.equal(result.abortCount, 0);
    });
  }

  it("cancels stale secondary work at compaction without adding a tool block", async () => {
    const secondary = deferred();
    let signal;
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async (input) => {
        signal = input.signal;
        return secondary.promise;
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-compaction",
    });
    await result.hooks.get("session_compact")({}, result.ctx);
    assert.equal(signal.aborted, true);
    assert.equal(
      result.hooks.get("tool_call")({
        toolCallId: "edit-after-compaction",
        toolName: "edit",
        input: { path: "README.md", oldString: "old", newString: "new" },
      }),
      undefined,
    );
    const count = result.events.filter(({ kind }) => kind === "secondary_reconciliation").length;
    secondary.resolve(classificationResult(2));

    await flushMicrotasks();
    assert.equal(result.events.filter(({ kind }) => kind === "secondary_reconciliation").length, count);
    assert.equal(result.abortCount, 0);
  });

  it("discards a secondary result abandoned by shutdown during its settlement telemetry", async () => {
    const secondary = deferred();
    const telemetryStarted = deferred();
    const releaseTelemetry = deferred();
    const events = [];
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () => secondary.promise,
      telemetry: {
        append: async (event) => {
          events.push(event);
          if (event.kind === "classifier_invocation" && event.data.purpose === "secondary_reconciliation") {
            telemetryStarted.resolve();
            await releaseTelemetry.promise;
          }
        },
        read: async () => [],
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-abandoned-during-settlement",
    });

    secondary.resolve(classificationResult(2, { confidence: 0.95, risk: "critical" }));
    await telemetryStarted.promise;
    // The task must remain discoverable while its settlement telemetry awaits, so this abort
    // consumes it instead of leaving a continuation that queues against the old session.
    await result.hooks.get("session_shutdown")({ reason: "quit" });
    releaseTelemetry.resolve();
    await flushMicrotasks();

    // Shutdown aborts without an extension context, so no reconciliation outcome is recorded at
    // all; the point is that the abandoned continuation neither queues nor applies its correction.
    assert.equal(events.filter(({ kind }) => kind === "secondary_reconciliation").length, 0);
    const persisted = result.appended.findLast((entry) => entry.customType === "model-router-state")?.data;
    assert.notEqual(persisted?.active?.features.risk, "critical");
  });

  it("lets a manual override during awaited reconciliation work win over the captured correction", async () => {
    const secondary = deferred();
    const overrideApplied = deferred();
    const routeReadReached = deferred();
    let blockRouteRead = false;
    const events = [];
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () => secondary.promise,
      telemetry: {
        append: async (event) => {
          events.push(event);
        },
        // `route()` inside the drain awaits this read. Take the override during that await so the
        // drain resumes with a snapshot that is no longer valid.
        read: async () => {
          if (blockRouteRead) {
            blockRouteRead = false;
            routeReadReached.resolve();
            await overrideApplied.promise;
          }
          return [];
        },
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-late-override",
    });

    result.hooks.get("agent_start")({}, result.ctx);
    result.hooks.get("turn_start")({}, result.ctx);
    secondary.resolve(
      classificationResult(2, {
        confidence: 0.95,
        risk: "critical",
        verificationStrength: "security_and_policy",
        independenceRequirement: "different_vendor_review",
      }),
    );
    await waitUntil(() =>
      events.some(
        (event) => event.kind === "classifier_invocation" && event.data.purpose === "secondary_reconciliation",
      ),
    );

    // A continuing turn boundary is the path that reaches the lease mutation, so block inside the
    // drain's awaited route telemetry and override while it is suspended there.
    blockRouteRead = true;
    const turnEnd = result.hooks.get("turn_end")(
      { message: { role: "assistant", stopReason: "toolUse" }, toolResults: [] },
      result.ctx,
    );
    await routeReadReached.promise;
    await result.hooks.get("model_select")({ source: "user", model: standardRoutingModels()[1] }, result.ctx);
    overrideApplied.resolve();
    await turnEnd;
    await flushMicrotasks();

    // The captured correction must not be installed after the override, and the task records exactly
    // one reconciliation outcome rather than one per drain path.
    const reconciliations = events.filter(({ kind }) => kind === "secondary_reconciliation");
    assert.equal(reconciliations.length, 1);
    assert.equal(reconciliations[0].data.accepted, false);
    assert.equal(reconciliations[0].data.reason, "manual_override");
    const persisted = result.appended.findLast((entry) => entry.customType === "model-router-state")?.data;
    assert.notEqual(persisted?.active?.features.risk, "critical");
  });

  it("reports a secondary arrival during tool execution as during_tool_execution", async () => {
    const secondary = deferred();
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.9, risk: "high" }),
      classifySecondaryTask: async () => secondary.promise,
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one high-risk bounded repository change",
      sessionId: "async-secondary-arrival-during-tool",
    });

    // pi emits tool_execution_start/tool_call/tool_execution_end inside the turn, so the provider
    // turn is still open while a tool runs; the narrower arrival category must still win.
    result.hooks.get("agent_start")({}, result.ctx);
    result.hooks.get("turn_start")({}, result.ctx);
    result.hooks.get("tool_execution_start")({ toolCallId: "arrival-tool" });
    secondary.resolve(classificationResult(2, { confidence: 0.95, risk: "high" }));
    await waitUntil(() =>
      result.events.some(
        (event) => event.kind === "classifier_invocation" && event.data.purpose === "secondary_reconciliation",
      ),
    );
    result.hooks.get("tool_execution_end")({ toolCallId: "arrival-tool", isError: false });
    await result.hooks.get("turn_end")(
      { message: { role: "assistant", stopReason: "toolUse" }, toolResults: [] },
      result.ctx,
    );

    assert.equal(
      result.events.findLast(({ kind }) => kind === "secondary_reconciliation")?.data.secondaryArrival,
      "during_tool_execution",
    );
  });

  it("does not block tools while secondary settlement telemetry is pending", async () => {
    const secondary = deferred();
    const telemetryStarted = deferred();
    const releaseTelemetry = deferred();
    const events = [];
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () => secondary.promise,
      telemetry: {
        append: async (event) => {
          events.push(event);
          if (event.kind === "classifier_invocation" && event.data.purpose === "secondary_reconciliation") {
            telemetryStarted.resolve();
            await releaseTelemetry.promise;
          }
        },
        read: async () => [],
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-pending-telemetry-gate",
    });
    startAgentRun(result);

    secondary.resolve(classificationResult(2, { confidence: 0.95 }));
    await telemetryStarted.promise;
    const observed = result.hooks.get("tool_call")({
      toolCallId: "edit-during-settlement-telemetry",
      toolName: "edit",
      input: { path: "README.md", oldString: "old", newString: "new" },
    });
    assert.equal(observed, undefined);
    assert.equal(result.abortCount, 0);

    releaseTelemetry.resolve();
    await flushMicrotasks();
    await endAgentTurn(result);
    await waitUntil(() => events.some(({ kind }) => kind === "secondary_reconciliation"));
    const allowed = result.hooks.get("tool_call")({
      toolCallId: "edit-after-settlement-telemetry",
      toolName: "edit",
      input: { path: "README.md", oldString: "old", newString: "new" },
    });
    assert.equal(allowed, undefined);
  });

  it("drops secondary reconciliation after an ordinary evidence update replaces the lease owner", async () => {
    const secondary = deferred();
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.9, risk: "high" }),
      classifySecondaryTask: async () => secondary.promise,
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one high-risk bounded repository change",
      sessionId: "async-secondary-owner-update",
    });
    const latest = () => result.appended.findLast(({ customType }) => customType === "model-router-state").data.active;
    const original = latest();
    startAgentRun(result);
    assert.equal(
      result.hooks.get("tool_call")({
        toolCallId: "edit-before-secondary",
        toolName: "edit",
        input: { path: "README.md", oldString: "old", newString: "new" },
      }),
      undefined,
    );
    result.hooks.get("tool_execution_start")({ toolCallId: "edit-before-secondary" });
    result.hooks.get("tool_execution_end")({ toolCallId: "edit-before-secondary", isError: false });
    const updated = latest();
    assert.notEqual(updated, original);
    assert.deepEqual(updated.selected, original.selected);
    secondary.resolve(
      classificationResult(2, {
        confidence: 0.95,
        risk: "critical",
        independenceRequirement: "different_vendor_review",
      }),
    );
    await flushMicrotasks();
    await endAgentTurn(result);
    assert.equal(latest(), updated, "the old owner's secondary must not overwrite evidence or its timestamp");
    const outcome = result.events.findLast(({ kind }) => kind === "secondary_reconciliation");
    assert.equal(outcome.data.accepted, false);
    assert.equal(outcome.data.reason, "lease_owner_changed");
    assert.equal(outcome.data.swapBoundary, "dropped");
    assert.equal(result.abortCount, 0);
  });

  it("drains queued secondary reconciliation at agent settlement despite a stuck tool counter", async () => {
    const secondary = deferred();
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.9, risk: "high" }),
      classifySecondaryTask: async () => secondary.promise,
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one high-risk bounded repository change",
      sessionId: "async-secondary-stuck-tool-counter",
    });

    startAgentRun(result);
    result.hooks.get("tool_execution_start")({ toolCallId: "stuck-tool" });
    secondary.resolve(classificationResult(2, { confidence: 0.95, risk: "high" }));
    await flushMicrotasks();
    // A turn boundary with a tool still counted as running must not drain the result.
    await endAgentTurn(result);
    assert.equal(
      result.events.some(({ kind }) => kind === "secondary_reconciliation"),
      false,
    );
    // An aborted attempt skips the settlement lifecycle work, so this isolates the terminal drain
    // from a lease revision the evidence-repair path would otherwise install first.
    await settleAgentRun(result, { stopReason: "aborted" });
    assert.equal(
      result.events.findLast(({ kind }) => kind === "secondary_reconciliation")?.data.reason,
      "no_material_delta",
    );
  });

  for (const superseded of [false, true]) {
    it(`${superseded ? "skips" : "runs"} settlement lifecycle work when input ${superseded ? "arrives" : "does not arrive"} during the pre-settlement drain`, async () => {
      const secondary = deferred();
      const drainWrite = deferred();
      const drainReached = deferred();
      const events = [];
      const result = await runAdapterTurn({
        classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.9, risk: "high" }),
        classifySecondaryTask: async () => secondary.promise,
        models: standardRoutingModels(),
        mode: "active",
        prompt: "Implement one high-risk bounded repository change",
        sessionId: `superseded-settlement-${superseded}`,
        telemetry: {
          append: async (event) => {
            // Hold settlement inside its secondary drain, where newer input can arrive.
            if (event.kind === "secondary_reconciliation") {
              drainReached.resolve();
              await drainWrite.promise;
            }
            events.push(event);
          },
          read: async () => [],
        },
      });
      const lease = () =>
        result.appended.findLast(({ customType }) => customType === "model-router-state")?.data.active;
      assert.equal(lease().lifecycle.phase, "building");
      startAgentRun(result);
      // A counted tool keeps turn_end from draining, so the reconciliation waits for settlement.
      result.hooks.get("tool_execution_start")({ toolCallId: "stuck-tool" });
      secondary.resolve(classificationResult(2, { confidence: 0.95, risk: "high" }));
      await flushMicrotasks();
      await endAgentTurn(result);
      const active = lease();
      result.ctx.model = result.ctx.modelRegistry.find(active.selected.provider, active.selected.modelId);
      await result.hooks.get("agent_end")(
        {
          messages: [
            {
              role: "assistant",
              provider: active.selected.provider,
              model: active.selected.modelId,
              stopReason: "stop",
              usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          ],
        },
        result.ctx,
      );
      const messages = result.sentMessages.length;
      const settling = result.hooks.get("agent_settled")({}, result.ctx);
      await drainReached.promise;
      if (superseded) {
        await result.hooks.get("input")(
          { text: "Actually, explain the plan first", source: "interactive", streamingBehavior: "followUp" },
          result.ctx,
        );
      }
      drainWrite.resolve();
      await settling;

      assert.ok(
        events.some(({ kind }) => kind === "secondary_reconciliation"),
        "same-epoch reconciliation still applies",
      );
      const repairs = result.sentMessages.slice(messages).filter(({ message }) => message.details?.repairReason);
      if (superseded) {
        assert.deepEqual(repairs, [], "a superseded run starts no router-generated repair turn");
        assert.equal(lease().lifecycle.evidenceRepairAttempted, undefined);
      } else {
        assert.equal(repairs.length, 0, "missing advisory evidence sends no model repair");
        assert.ok(events.some((e) => e.kind === "advisory_step_skipped" && e.data.step === "completion_evidence"));
      }
    });
  }

  it("skips settlement lifecycle work when input arrives after the run ends but before settlement", async () => {
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.95, risk: "high" }),
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one high-risk bounded repository change",
      sessionId: "input-before-settlement",
    });
    const lease = () => result.appended.findLast(({ customType }) => customType === "model-router-state")?.data.active;
    assert.equal(lease().lifecycle.phase, "building");
    startAgentRun(result);
    await endAgentTurn(result);
    const active = lease();
    result.ctx.model = result.ctx.modelRegistry.find(active.selected.provider, active.selected.modelId);
    await result.hooks.get("agent_end")(
      {
        messages: [
          {
            role: "assistant",
            provider: active.selected.provider,
            model: active.selected.modelId,
            stopReason: "stop",
            usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        ],
      },
      result.ctx,
    );
    const messages = result.sentMessages.length;
    // The user's follow-up lands after the run ended but before Pi delivers agent_settled.
    await result.hooks.get("input")(
      { text: "Actually, explain the plan first", source: "interactive", streamingBehavior: "followUp" },
      result.ctx,
    );
    await result.hooks.get("agent_settled")({}, result.ctx);
    assert.deepEqual(
      result.sentMessages.slice(messages).filter(({ message }) => message.details?.repairReason),
      [],
      "a superseded run starts no router-generated repair turn",
    );
    assert.equal(lease().lifecycle.evidenceRepairAttempted, undefined);
  });

  it("keeps a secondary result that settles before agent_start queued until a run boundary", async () => {
    const secondary = deferred();
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.9, risk: "high" }),
      classifySecondaryTask: async () => secondary.promise,
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one high-risk bounded repository change",
      sessionId: "async-secondary-before-agent-start",
    });

    // `before_agent_start` has released the run, but Pi has not fired `agent_start` yet. The run has
    // not settled, so this must not drain as if it had.
    secondary.resolve(classificationResult(2, { confidence: 0.95, risk: "high" }));
    await flushMicrotasks();
    assert.equal(
      result.events.some(({ kind }) => kind === "secondary_reconciliation"),
      false,
    );

    startAgentRun(result);
    await endAgentTurn(result);
    const reconciliation = result.events.findLast(({ kind }) => kind === "secondary_reconciliation");
    assert.equal(reconciliation?.data.reason, "no_material_delta");
    assert.equal(reconciliation?.data.secondaryArrival, "before_agent_run");
  });

  it("lets manual overrides win by aborting pending secondary work", async () => {
    const secondary = deferred();
    let secondarySignal;
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async ({ signal }) => {
        secondarySignal = signal;
        return secondary.promise;
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-manual-override",
    });

    await result.hooks.get("model_select")({ source: "user", model: standardRoutingModels()[1] }, result.ctx);
    assert.equal(secondarySignal.aborted, true);
    assert.equal(
      result.events.findLast(({ kind }) => kind === "secondary_reconciliation")?.data.reason,
      "manual_override",
    );
    const reconciliationCount = result.events.filter(({ kind }) => kind === "secondary_reconciliation").length;
    secondary.resolve(classificationResult(2, { risk: "critical" }));
    await flushMicrotasks();
    assert.equal(result.events.filter(({ kind }) => kind === "secondary_reconciliation").length, reconciliationCount);
  });

  it("aborts pending secondary work on /route off and applies nothing that settles afterwards", async () => {
    const secondary = deferred();
    let secondarySignal;
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async ({ signal }) => {
        secondarySignal = signal;
        return secondary.promise;
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-route-off",
    });

    await result.commands.get("route").handler("off", result.ctx);
    assert.equal(secondarySignal.aborted, true, "off must abort in-flight secondary classification");
    const eventCount = result.events.length;
    const entryCount = result.appended.length;
    const modelCount = result.selectedModels.length;
    secondary.resolve(classificationResult(2, { risk: "critical" }));
    await flushMicrotasks();
    await result.hooks.get("turn_end")(
      { message: { role: "assistant", stopReason: "stop" }, toolResults: [] },
      result.ctx,
    );
    await result.hooks.get("agent_settled")({}, result.ctx);

    assert.equal(result.events.length, eventCount, "off must record no secondary reconciliation telemetry");
    assert.equal(result.appended.length, entryCount, "off must not install a secondary correction");
    assert.equal(result.selectedModels.length, modelCount, "off must not apply a secondary correction");
    assert.deepEqual(result.sentMessages, [], "off must not trigger a secondary handoff turn");
  });

  it("aborts and consumes pending secondary work on shutdown", async () => {
    const secondary = deferred();
    let secondarySignal;
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async ({ signal }) => {
        secondarySignal = signal;
        return secondary.promise;
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-shutdown",
    });

    await result.hooks.get("session_shutdown")({ reason: "quit" });
    assert.equal(secondarySignal.aborted, true);
    const reconciliationCount = result.events.filter(({ kind }) => kind === "secondary_reconciliation").length;
    secondary.resolve(classificationResult(2, { risk: "critical" }));
    await flushMicrotasks();
    assert.equal(result.events.filter(({ kind }) => kind === "secondary_reconciliation").length, reconciliationCount);
  });

  it("uses the configured secondary deadline for background reconciliation", async () => {
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("configured secondary deadline expired");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
      secondaryReconciliationPolicy: {
        secondaryDeadlineMs: 5,
        materialCorrectionBenefitUsd: 0.02,
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-configured-deadline",
    });
    startAgentRun(result);

    await new Promise((resolve) => setTimeout(resolve, 25));
    await flushMicrotasks();
    await settleAgentRun(result);
    await waitUntil(() => result.events.some(({ kind }) => kind === "secondary_reconciliation"));
    const invocation = result.events.find(
      (event) => event.kind === "classifier_invocation" && event.data.purpose === "secondary_reconciliation",
    );
    assert.equal(invocation?.data.timedOut, true);
    const reconciliation = result.events.findLast(({ kind }) => kind === "secondary_reconciliation");
    assert.equal(reconciliation?.data.reason, "secondary_timeout");
    // The reconciliation record must name the budget that actually expired: background
    // reconciliation answers to the configurable secondary deadline, not the stage constant.
    assert.equal(reconciliation?.data.secondaryDeadlineMs, 5);
    assert.equal(reconciliation?.data.secondaryEnforcedBudgetMs, 5);
    assert.equal(reconciliation?.data.secondaryErrorCategory, "deadline");
    assert.equal(reconciliation?.data.secondaryDeadlineStage, undefined, "no stage reported a start");
    assert.equal(reconciliation?.data.secondaryOutcome, "timeout");
    assert.equal(typeof reconciliation?.data.secondaryWallLatencyMs, "number");
    assert.ok(reconciliation.data.secondaryWallLatencyMs >= 0);
  });

  it("omits router budget attribution when the secondary failure is transport-owned", async () => {
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () => {
        // A provider-thrown timeout is the transport's deadline, not the router's budget.
        const error = new Error("provider timed out");
        error.name = "TimeoutError";
        throw error;
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-transport-timeout-budget",
    });
    startAgentRun(result);
    await settleAgentRun(result);

    await waitUntil(() => result.events.some(({ kind }) => kind === "secondary_reconciliation"));
    const reconciliation = result.events.findLast(({ kind }) => kind === "secondary_reconciliation");
    assert.equal(reconciliation?.data.reason, "secondary_timeout");
    assert.equal(reconciliation?.data.secondaryOutcome, "timeout");
    assert.equal(reconciliation?.data.secondaryErrorCategory, "transport_timeout");
    assert.equal(typeof reconciliation?.data.secondaryWallLatencyMs, "number");
    // The configured budget is still reported, but nothing claims the router enforced a deadline.
    assert.equal(reconciliation?.data.secondaryDeadlineMs, 15_000);
    assert.equal(reconciliation?.data.secondaryEnforcedBudgetMs, undefined);
    assert.equal(reconciliation?.data.secondaryDeadlineStage, undefined);
  });

  it("keeps failure attribution when an abort consumes a settled secondary during its telemetry write", async () => {
    const telemetryStarted = deferred();
    const releaseTelemetry = deferred();
    const events = [];
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () => {
        const error = new Error("provider timed out");
        error.name = "TimeoutError";
        throw error;
      },
      telemetry: {
        append: async (event) => {
          events.push(event);
          if (event.kind === "classifier_invocation" && event.data.purpose === "secondary_reconciliation") {
            telemetryStarted.resolve();
            await releaseTelemetry.promise;
          }
        },
        read: async () => [],
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-abort-during-settlement-telemetry",
    });

    // The run has settled and its invocation telemetry is in flight when compaction discards it.
    await telemetryStarted.promise;
    await result.hooks.get("session_compact")({}, result.ctx);
    releaseTelemetry.resolve();
    await waitUntil(() => events.some(({ kind }) => kind === "secondary_reconciliation"));

    const reconciliation = events.findLast(({ kind }) => kind === "secondary_reconciliation");
    assert.equal(reconciliation?.data.accepted, false);
    assert.equal(reconciliation?.data.secondaryOutcome, "timeout");
    assert.equal(reconciliation?.data.secondaryErrorCategory, "transport_timeout");
    assert.equal(typeof reconciliation?.data.secondaryWallLatencyMs, "number");
    assert.equal(reconciliation?.data.secondaryEnforcedBudgetMs, undefined);
  });

  it("omits router budget attribution when a cancelled secondary is discarded", async () => {
    const secondary = deferred();
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async ({ signal }) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            secondary.reject(error);
          },
          { once: true },
        );
        return secondary.promise;
      },
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-cancelled-budget",
    });

    await result.hooks.get("session_compact")({}, result.ctx);
    await waitUntil(() => result.events.some(({ kind }) => kind === "secondary_reconciliation"));
    const reconciliation = result.events.findLast(({ kind }) => kind === "secondary_reconciliation");
    assert.equal(reconciliation?.data.accepted, false);
    assert.equal(reconciliation?.data.secondaryDeadlineMs, 15_000);
    assert.equal(reconciliation?.data.secondaryEnforcedBudgetMs, undefined);
    assert.equal(reconciliation?.data.secondaryDeadlineStage, undefined);
  });

  it("records the secondary budget without failure attribution for a completed classification", async () => {
    const secondary = deferred();
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () => secondary.promise,
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-budget-on-success",
    });

    startAgentRun(result);
    secondary.resolve(classificationResult(2, { confidence: 0.95 }));
    await flushMicrotasks();
    await endAgentTurn(result);
    await waitUntil(() => result.events.some(({ kind }) => kind === "secondary_reconciliation"));

    const reconciliation = result.events.findLast(({ kind }) => kind === "secondary_reconciliation");
    // A completed run consumed no deadline, so only the configured budget is recorded.
    assert.equal(reconciliation?.data.secondaryDeadlineMs, 15_000);
    assert.equal(reconciliation?.data.secondaryOutcome, undefined);
    assert.equal(reconciliation?.data.secondaryErrorCategory, undefined);
    assert.equal(reconciliation?.data.secondaryEnforcedBudgetMs, undefined);
    assert.equal(reconciliation?.data.secondaryDeadlineStage, undefined);
  });

  for (const { changeAt, changeKind, delivery } of ["correction", "recovery"].flatMap((changeAt) =>
    ["model", "effort"].flatMap((changeKind) =>
      ["direct", "after a preceding observer"].map((delivery) => ({ changeAt, changeKind, delivery })),
    ),
  )) {
    it(`preserves an off-mode operator ${changeKind} selection during ${changeAt} authentication (${delivery})`, async () => {
      const secondary = deferred();
      const switching = deferred();
      const releaseSwitch = deferred();
      const restoring = deferred();
      const releaseRestore = deferred();
      const models = standardRoutingModels();
      const result = await runAdapterTurn({
        classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
        classifySecondaryTask: async () => secondary.promise,
        models,
        mode: "active",
        prompt: "Implement one bounded repository change",
        sessionId: `operator-${changeKind}-choice-during-${changeAt}-${delivery === "direct" ? "direct" : "observed"}`,
      });
      const latest = () => result.appended.findLast(({ customType }) => customType === "model-router-state").data;
      const original = latest().active;
      startAgentRun(result);
      await settleAgentRun(result, { stopReason: "aborted" });
      const select = result.pi.setModel;
      const setEffort = result.pi.setThinkingLevel;
      // Pi records every model and effort change in the session transcript synchronously, in order.
      const transcript = result.ctx.sessionManager.getBranch();
      let entryId = 0;
      // Pi emits thinking_level_select without awaiting it and awaits each earlier handler, so even a
      // synchronous observer registered before the router delays the router's delivery.
      const deliverEffort = async (event) => {
        if (delivery !== "direct") await (() => {})();
        await result.hooks.get("thinking_level_select")(event, result.ctx);
      };
      result.pi.setThinkingLevel = (level) => {
        const previousLevel = result.pi.getThinkingLevel();
        setEffort(level);
        if (level === previousLevel) return;
        transcript.push({ type: "thinking_level_change", id: `effort-${++entryId}`, thinkingLevel: level });
        void deliverEffort({ level, previousLevel });
      };
      let switchCount = 0;
      let correctionModel;
      result.pi.setModel = async (model) => {
        switchCount++;
        if (switchCount === 1) {
          correctionModel = model;
          switching.resolve();
          await releaseSwitch.promise;
        } else if (switchCount === 2 && changeAt === "recovery") {
          restoring.resolve();
          await releaseRestore.promise;
        }
        const selected = await select(model);
        transcript.push({
          type: "model_change",
          id: `model-${++entryId}`,
          provider: model.provider,
          modelId: model.id,
        });
        // Pi also resets effort synchronously after authentication, before model_select.
        result.pi.setThinkingLevel("high");
        await result.hooks.get("model_select")({ source: "set", model }, result.ctx);
        return selected;
      };
      secondary.resolve(
        classificationResult(2, {
          confidence: 0.95,
          risk: "critical",
          verificationStrength: "security_and_policy",
          independenceRequirement: "different_vendor_review",
        }),
      );
      await switching.promise;
      await result.commands.get("route").handler("off", result.ctx);
      if (changeAt === "recovery") {
        releaseSwitch.resolve();
        await restoring.promise;
      }
      const operatorModel =
        changeKind === "model"
          ? models.find((model) => model.id !== original.selected.modelId && model.id !== correctionModel.id)
          : result.ctx.model;
      assert.ok(operatorModel);
      if (changeKind === "model") {
        await select(operatorModel);
        transcript.push({
          type: "model_change",
          id: `model-${++entryId}`,
          provider: operatorModel.provider,
          modelId: operatorModel.id,
        });
        await result.hooks.get("model_select")({ source: "set", model: operatorModel }, result.ctx);
      } else {
        assert.equal(result.pi.getThinkingLevel(), "high");
        result.pi.setThinkingLevel("low");
      }
      const eventsWhileOff = result.events.length;
      const stateWhileOff = result.appended.length;
      if (changeAt === "correction") releaseSwitch.resolve();
      else releaseRestore.resolve();
      await waitUntil(() => switchCount >= (changeKind === "model" && changeAt === "recovery" ? 3 : 2));
      await flushMicrotasks();
      assert.equal(
        result.ctx.model.id,
        operatorModel.id,
        "uncancellable recovery must not overwrite a newer off-mode choice",
      );
      assert.equal(result.ctx.model.provider, operatorModel.provider);
      if (changeKind === "effort") assert.equal(result.pi.getThinkingLevel(), "low");
      assert.equal(result.events.length, eventsWhileOff, "off-mode effort changes must not emit router telemetry");
      assert.equal(result.appended.length, stateWhileOff, "off-mode effort changes must not persist routing state");
      assert.equal(latest().mode, "off");
      assert.equal(latest().active.selected.modelId, original.selected.modelId);
      assert.equal(
        result.events.some(({ kind, data }) => kind === "secondary_reconciliation" && data.accepted),
        false,
      );
      assert.equal(result.abortCount, 0);
    });
  }

  it("recognizes a correction's default-effort echo held through recovery authentication after an off-mode effort change", async () => {
    const secondary = deferred();
    const switching = deferred();
    const releaseSwitch = deferred();
    const restoring = deferred();
    const releaseRestore = deferred();
    const releaseEcho = deferred();
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () => secondary.promise,
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "held-correction-effort-echo-through-recovery",
    });
    const latest = () => result.appended.findLast(({ customType }) => customType === "model-router-state").data;
    const original = latest().active;
    startAgentRun(result);
    await settleAgentRun(result, { stopReason: "aborted" });
    // Pi records every model and effort change in the session transcript synchronously, in order.
    const transcript = result.ctx.sessionManager.getBranch();
    let entryId = 0;
    const select = result.pi.setModel;
    const setEffort = result.pi.setThinkingLevel;
    const delivered = [];
    let holdNextEcho = false;
    result.pi.setThinkingLevel = (level) => {
      const previousLevel = result.pi.getThinkingLevel();
      setEffort(level);
      if (level === previousLevel) return;
      transcript.push({ type: "thinking_level_change", id: `effort-${++entryId}`, thinkingLevel: level });
      const held = holdNextEcho;
      holdNextEcho = false;
      void (async () => {
        // An earlier asynchronous subscriber holds only the correction's default-effort event.
        if (held) await releaseEcho.promise;
        else await (() => {})();
        await result.hooks.get("thinking_level_select")({ level, previousLevel }, result.ctx);
        delivered.push({ level, previousLevel });
      })();
    };
    let switchCount = 0;
    let correctionModel;
    result.pi.setModel = async (model) => {
      switchCount++;
      if (switchCount === 1) {
        correctionModel = model;
        switching.resolve();
        await releaseSwitch.promise;
      } else if (switchCount === 2) {
        restoring.resolve();
        await releaseRestore.promise;
      }
      const selected = await select(model);
      transcript.push({ type: "model_change", id: `model-${++entryId}`, provider: model.provider, modelId: model.id });
      // Pi resets effort to the target's default synchronously after authentication.
      holdNextEcho = switchCount === 1;
      result.pi.setThinkingLevel("high");
      holdNextEcho = false;
      await result.hooks.get("model_select")({ source: "set", model }, result.ctx);
      return selected;
    };
    secondary.resolve(
      classificationResult(2, {
        confidence: 0.95,
        risk: "critical",
        verificationStrength: "security_and_policy",
        independenceRequirement: "different_vendor_review",
      }),
    );
    await switching.promise;
    await result.commands.get("route").handler("off", result.ctx);
    const operatorModel = result.ctx.model;
    assert.equal(operatorModel.id, original.selected.modelId);
    assert.equal(result.pi.getThinkingLevel(), "high");
    // The operator lowers effort on the current model while the correction authenticates.
    result.pi.setThinkingLevel("low");
    await flushMicrotasks();
    const eventsWhileOff = result.events.length;
    const stateWhileOff = result.appended.length;
    releaseSwitch.resolve();
    await restoring.promise;
    assert.equal(result.ctx.model.id, correctionModel.id);
    // The correction's low -> high default-effort echo lands while recovery is authenticating.
    releaseEcho.resolve();
    await flushMicrotasks();
    assert.deepEqual(delivered, [
      { level: "low", previousLevel: "high" },
      { level: "high", previousLevel: "low" },
    ]);
    releaseRestore.resolve();
    await waitUntil(() => switchCount >= 2);
    await flushMicrotasks();
    assert.equal(switchCount, 2, "recovery must not switch back to the rejected correction");
    assert.equal(result.ctx.model.id, operatorModel.id);
    assert.equal(result.ctx.model.provider, operatorModel.provider);
    assert.equal(result.pi.getThinkingLevel(), "low");
    assert.equal(result.events.length, eventsWhileOff, "off-mode changes must not emit router telemetry");
    assert.equal(result.appended.length, stateWhileOff, "off-mode changes must not persist routing state");
    assert.equal(latest().mode, "off");
    assert.equal(result.abortCount, 0);
  });

  for (const { changeAt, targetDefault } of ["correction", "recovery"].flatMap((changeAt) =>
    ["changed", "unchanged"].map((targetDefault) => ({ changeAt, targetDefault })),
  )) {
    it(`records an off-mode operator effort change on the ${changeAt} target while model_select delivery is paused (${targetDefault} default effort)`, async () => {
      const secondary = deferred();
      const switching = deferred();
      const releaseSwitch = deferred();
      const committed = deferred();
      const releaseModelSelect = deferred();
      const pauseAt = changeAt === "correction" ? 1 : 2;
      const pausedDefault = targetDefault === "changed" ? "medium" : "high";
      const result = await runAdapterTurn({
        classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
        classifySecondaryTask: async () => secondary.promise,
        models: standardRoutingModels(),
        mode: "active",
        prompt: "Implement one bounded repository change",
        sessionId: `paused-model-select-operator-effort-${changeAt}-${targetDefault}`,
      });
      // Pi derives a switch's effort from these settings: the per-model level, else the default.
      let pausedTarget;
      result.pi.getSettings = () => ({
        defaultThinkingLevel: "high",
        modelThinkingLevels: pausedTarget ? { [`${pausedTarget.provider}/${pausedTarget.id}`]: pausedDefault } : {},
      });
      const latest = () => result.appended.findLast(({ customType }) => customType === "model-router-state").data;
      const original = latest().active;
      startAgentRun(result);
      await settleAgentRun(result, { stopReason: "aborted" });
      // Pi records every model and effort change in the session transcript synchronously, in order.
      const transcript = result.ctx.sessionManager.getBranch();
      let entryId = 0;
      const select = result.pi.setModel;
      const setEffort = result.pi.setThinkingLevel;
      const delivered = [];
      result.pi.setThinkingLevel = (level) => {
        const previousLevel = result.pi.getThinkingLevel();
        setEffort(level);
        if (level === previousLevel) return;
        transcript.push({ type: "thinking_level_change", id: `effort-${++entryId}`, thinkingLevel: level });
        void (async () => {
          await (() => {})();
          await result.hooks.get("thinking_level_select")({ level, previousLevel }, result.ctx);
          delivered.push({ level, previousLevel });
        })();
      };
      let switchCount = 0;
      let correctionModel;
      result.pi.setModel = async (model) => {
        const switchNumber = ++switchCount;
        if (switchNumber === pauseAt) pausedTarget = model;
        if (switchNumber === 1) {
          correctionModel = model;
          switching.resolve();
          await releaseSwitch.promise;
        }
        const selected = await select(model);
        transcript.push({
          type: "model_change",
          id: `model-${++entryId}`,
          provider: model.provider,
          modelId: model.id,
        });
        // Pi resets effort to the target's default synchronously after committing the target.
        const settings = result.pi.getSettings();
        result.pi.setThinkingLevel(
          settings.modelThinkingLevels[`${model.provider}/${model.id}`] ?? settings.defaultThinkingLevel,
        );
        if (switchNumber === pauseAt) {
          // An earlier model_select subscriber pauses delivery after Pi committed the target.
          committed.resolve();
          await releaseModelSelect.promise;
        }
        await result.hooks.get("model_select")({ source: "set", model }, result.ctx);
        return selected;
      };
      secondary.resolve(
        classificationResult(2, {
          confidence: 0.95,
          risk: "critical",
          verificationStrength: "security_and_policy",
          independenceRequirement: "different_vendor_review",
        }),
      );
      await switching.promise;
      await result.commands.get("route").handler("off", result.ctx);
      releaseSwitch.resolve();
      await committed.promise;
      await flushMicrotasks();
      const operatorModel = result.ctx.model;
      assert.equal(operatorModel.id, changeAt === "correction" ? correctionModel.id : original.selected.modelId);
      assert.equal(result.pi.getThinkingLevel(), pausedDefault);
      const eventsWhileOff = result.events.length;
      const stateWhileOff = result.appended.length;
      // The operator lowers effort on the committed target before model_select reaches the router.
      result.pi.setThinkingLevel("low");
      await flushMicrotasks();
      // An unchanged default writes no effort entry, so the operator's change follows the model change.
      assert.deepEqual(
        delivered,
        targetDefault === "changed"
          ? [
              { level: "medium", previousLevel: "high" },
              { level: "low", previousLevel: "medium" },
            ]
          : [{ level: "low", previousLevel: "high" }],
      );
      releaseModelSelect.resolve();
      await waitUntil(() => switchCount >= pauseAt);
      await flushMicrotasks();
      assert.equal(switchCount, pauseAt, "recovery must not switch away from the operator's choice");
      assert.equal(result.ctx.model.id, operatorModel.id);
      assert.equal(result.ctx.model.provider, operatorModel.provider);
      assert.equal(result.pi.getThinkingLevel(), "low", "the operator's effort choice must win");
      assert.equal(result.events.length, eventsWhileOff, "off-mode changes must not emit router telemetry");
      assert.equal(result.appended.length, stateWhileOff, "off-mode changes must not persist routing state");
      assert.equal(latest().mode, "off");
      assert.equal(result.abortCount, 0);
    });
  }

  it("recovers an off-mode operator model selection made while custom-start preparation authenticates", async () => {
    const active = adapterLease();
    const models = standardRoutingModels();
    const result = await runAdapterTurn({
      active,
      prepareTurn: false,
      mode: "active",
      models,
      sessionId: "custom-start-authentication-race",
    });
    await result.commands.get("route").handler("off", result.ctx);
    const earlierModel = models.find(({ id }) => id !== active.selected.modelId);
    await result.pi.setModel(earlierModel);
    await result.hooks.get("model_select")({ source: "set", model: earlierModel }, result.ctx);
    await result.commands.get("route").handler("active", result.ctx);
    const select = result.pi.setModel;
    const authenticating = deferred();
    const releaseAuthentication = deferred();
    let switches = 0;
    result.pi.setModel = async (model) => {
      if (++switches === 1) {
        authenticating.resolve();
        await releaseAuthentication.promise;
      }
      const selected = await select(model);
      await result.hooks.get("model_select")({ source: "set", model }, result.ctx);
      return selected;
    };
    const preparing = result.hooks.get("before_agent_start")(
      { messageType: "custom", systemPrompt: "system" },
      result.ctx,
    );
    await authenticating.promise;
    // Pi cannot cancel the pending switch to the lease's model; the operator turns routing off and picks a model.
    await result.commands.get("route").handler("off", result.ctx);
    const operatorModel = models.find(({ id }) => id !== active.selected.modelId && id !== earlierModel.id);
    await select(operatorModel);
    await result.hooks.get("model_select")({ source: "set", model: operatorModel }, result.ctx);
    releaseAuthentication.resolve();
    assert.equal(await preparing, undefined);
    await flushMicrotasks();
    assert.equal(result.ctx.model.id, operatorModel.id, "a stale custom-start switch must not override the operator");
    assert.equal(result.ctx.model.provider, operatorModel.provider);
    const latest = result.appended.findLast(({ customType }) => customType === "model-router-state").data;
    assert.equal(latest.mode, "off");
    assert.equal(result.abortCount, 0);
  });

  it("prepares the dormant lease before compiling a re-enabled custom run", async () => {
    const active = adapterLease();
    const result = await runAdapterTurn({
      active,
      prepareTurn: false,
      mode: "active",
      models: standardRoutingModels(),
      sessionId: "custom-reenabled-profile",
    });
    await result.commands.get("route").handler("off", result.ctx);
    const operatorModel = standardRoutingModels().find(({ id }) => id !== active.selected.modelId);
    await result.pi.setModel(operatorModel);
    await result.hooks.get("model_select")({ source: "set", model: operatorModel }, result.ctx);
    await result.commands.get("route").handler("active", result.ctx);
    const prepared = await result.hooks.get("before_agent_start")(
      { messageType: "custom", systemPrompt: "system" },
      result.ctx,
    );
    assert.equal(result.ctx.model.id, active.selected.modelId);
    assert.equal(result.ctx.model.provider, active.selected.provider);
    assert.equal(result.pi.getThinkingLevel(), active.selected.effort);
    const profile = PROMPT_PROFILES.find(({ id }) => id === active.promptProfileId);
    assert.ok(prepared.systemPrompt.includes(profile.guidelines[0]));
    assert.equal(result.abortCount, 0);
  });

  it("recognizes its own effort echo when an earlier observer delays delivery", async () => {
    const active = adapterLease();
    const result = await runAdapterTurn({
      active,
      prepareTurn: false,
      mode: "active",
      models: standardRoutingModels(),
      sessionId: "delayed-router-effort-echo",
    });
    await result.commands.get("route").handler("off", result.ctx);
    const operatorModel = standardRoutingModels().find(({ id }) => id !== active.selected.modelId);
    await result.pi.setModel(operatorModel);
    await result.hooks.get("model_select")({ source: "set", model: operatorModel }, result.ctx);
    result.pi.setThinkingLevel("low");
    await result.hooks.get("thinking_level_select")({ level: "low", previousLevel: "high" }, result.ctx);
    await result.commands.get("route").handler("active", result.ctx);
    // Pi emits thinking_level_select without awaiting it and awaits each earlier handler, so a
    // synchronous observer registered before the router delays delivery past the setter's return.
    const setEffort = result.pi.setThinkingLevel;
    const delivered = [];
    result.pi.setThinkingLevel = (level) => {
      const previousLevel = result.pi.getThinkingLevel();
      setEffort(level);
      if (level === previousLevel) return;
      void (async () => {
        await (() => {})();
        await result.hooks.get("thinking_level_select")({ level, previousLevel }, result.ctx);
        delivered.push(level);
      })();
    };
    await result.hooks.get("before_agent_start")({ messageType: "custom", systemPrompt: "system" }, result.ctx);
    await flushMicrotasks();
    assert.deepEqual(delivered, [active.selected.effort]);
    assert.equal(result.pi.getThinkingLevel(), active.selected.effort);
    assert.equal(
      result.events.some(({ kind, data }) => kind === "outcome" && data.manualOverride === "effort"),
      false,
      "the router's own delayed effort echo is not an operator override",
    );
    const latest = result.appended.findLast(({ customType }) => customType === "model-router-state").data;
    assert.equal(latest.manualOverride, false);
    assert.equal(latest.active?.taskId, active.taskId);
    assert.equal(result.abortCount, 0);
  });

  it("recognizes a model switch's default-effort echo released after selection completes", async () => {
    const active = adapterLease();
    const result = await runAdapterTurn({
      active,
      prepareTurn: false,
      mode: "active",
      models: standardRoutingModels(),
      sessionId: "delayed-model-default-effort-echo",
    });
    await result.commands.get("route").handler("off", result.ctx);
    const operatorModel = standardRoutingModels().find(({ id }) => id !== active.selected.modelId);
    await result.pi.setModel(operatorModel);
    await result.hooks.get("model_select")({ source: "set", model: operatorModel }, result.ctx);
    result.pi.setThinkingLevel("low");
    await result.hooks.get("thinking_level_select")({ level: "low", previousLevel: "high" }, result.ctx);
    await result.commands.get("route").handler("active", result.ctx);
    // An asynchronous subscriber registered before the router holds Pi's unawaited
    // default-effort event until after model selection has completed.
    const release = deferred();
    const delivered = [];
    const setEffort = result.pi.setThinkingLevel;
    result.pi.setThinkingLevel = (level) => {
      const previousLevel = result.pi.getThinkingLevel();
      setEffort(level);
      if (level === previousLevel) return;
      void (async () => {
        await release.promise;
        await result.hooks.get("thinking_level_select")({ level, previousLevel }, result.ctx);
        delivered.push(level);
      })();
    };
    const select = result.pi.setModel;
    result.pi.setModel = async (model) => {
      const selected = await select(model);
      // The target model's default effort equals the routed effort, so the router sets none itself.
      result.pi.setThinkingLevel(active.selected.effort);
      await result.hooks.get("model_select")({ source: "set", model }, result.ctx);
      return selected;
    };
    await result.hooks.get("before_agent_start")({ messageType: "custom", systemPrompt: "system" }, result.ctx);
    assert.equal(result.ctx.model.id, active.selected.modelId);
    release.resolve();
    await flushMicrotasks();
    assert.deepEqual(delivered, [active.selected.effort]);
    assert.equal(
      result.events.some(({ kind, data }) => kind === "outcome" && data.manualOverride === "effort"),
      false,
      "the model switch's own delayed default-effort echo is not an operator override",
    );
    const latest = result.appended.findLast(({ customType }) => customType === "model-router-state").data;
    assert.equal(latest.manualOverride, false);
    assert.equal(latest.active?.taskId, active.taskId);
    assert.equal(result.abortCount, 0);
  });

  it("does not force an exhausted lease's profile onto a custom run", async () => {
    const active = { ...adapterLease(), executionFailed: true };
    const result = await runAdapterTurn({
      active,
      prepareTurn: false,
      mode: "active",
      models: standardRoutingModels(),
      sessionId: "custom-exhausted-profile",
    });
    const model = result.ctx.model;
    const selections = result.selectedModels.length;
    const prepared = await result.hooks.get("before_agent_start")(
      { messageType: "custom", systemPrompt: "system" },
      result.ctx,
    );
    assert.equal(prepared, undefined);
    assert.equal(result.ctx.model, model);
    assert.equal(result.selectedModels.length, selections);
    assert.equal(result.abortCount, 0);
  });

  it("swaps the whole route tuple while idle and compiles its profile on the next custom run", async () => {
    const secondary = deferred();
    let primaryCalls = 0;
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => {
        primaryCalls++;
        return primaryClassificationResult({ confidence: 0.6 });
      },
      classifySecondaryTask: async () => secondary.promise,
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-idle-swap",
    });
    const latest = () => result.appended.findLast(({ customType }) => customType === "model-router-state").data.active;
    const original = latest();
    startAgentRun(result);
    await settleAgentRun(result, { stopReason: "aborted" });
    secondary.resolve(
      classificationResult(2, {
        confidence: 0.95,
        risk: "critical",
        verificationStrength: "security_and_policy",
        independenceRequirement: "different_vendor_review",
      }),
    );
    await waitUntil(() => result.events.some(({ kind, data }) => kind === "secondary_reconciliation" && data.accepted));
    const corrected = latest();
    assert.notDeepEqual(corrected.selected, original.selected);
    assert.notEqual(corrected.promptProfileId, original.promptProfileId);
    assert.notEqual(corrected.archetype, original.archetype);
    assert.equal(corrected.features.risk, "critical");
    assert.equal(result.selectedModels.at(-1).id, corrected.selected.modelId);
    assert.equal(result.selectedModels.at(-1).provider, corrected.selected.provider);
    assert.equal(result.selectedEfforts.at(-1), corrected.selected.effort);
    const reconciliation = result.events.findLast(({ kind }) => kind === "secondary_reconciliation");
    assert.equal(reconciliation.data.reason, "accepted");
    assert.equal(reconciliation.data.swapBoundary, "idle");
    assert.equal(reconciliation.data.secondaryArrival, "after_agent_run");
    assert.deepEqual(
      reconciliation.data.secondaryClassifierAttempts.map(({ stage }) => stage),
      ["secondary"],
    );
    const prepared = await result.hooks.get("before_agent_start")(
      { messageType: "custom", systemPrompt: "system" },
      result.ctx,
    );
    const profile = PROMPT_PROFILES.find(({ id }) => id === corrected.promptProfileId);
    assert.ok(prepared.systemPrompt.includes(profile.guidelines[0]));
    assert.notEqual(prepared.systemPrompt, result.beforeAgentStart.systemPrompt);
    assert.equal(primaryCalls, 1, "a custom run refreshes the profile without classifying");
    assert.equal(result.abortCount, 0);
    assert.deepEqual(result.sentMessages, []);
  });

  it("defers the entire midrun correction until idle without aborting or sending a continuation", async () => {
    const secondary = deferred();
    let ledgerReads = 0;
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () => secondary.promise,
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-deferred-tuple",
      telemetry: ({ events }) => ({
        append: async (event) => {
          events.push(event);
        },
        read: async () => {
          ledgerReads++;
          return [];
        },
      }),
    });
    const latest = () => result.appended.findLast(({ customType }) => customType === "model-router-state").data.active;
    const original = latest();
    const selections = result.selectedModels.length;
    const efforts = result.selectedEfforts.length;
    startAgentRun(result);
    secondary.resolve(
      classificationResult(2, {
        confidence: 0.95,
        risk: "critical",
        verificationStrength: "security_and_policy",
        independenceRequirement: "different_vendor_review",
      }),
    );
    await flushMicrotasks();
    for (let turn = 0; turn < 2; turn++) {
      const readsBeforeBoundary = ledgerReads;
      await result.hooks.get("turn_end")(
        { message: { role: "assistant", stopReason: "toolUse" }, toolResults: [] },
        result.ctx,
      );
      if (turn > 0) assert.equal(ledgerReads, readsBeforeBoundary, "already-deferred turns do not reread the ledger");
      assert.equal(latest(), original, "Pi's forced prompt cannot change midrun, so no lease field may change");
      assert.equal(result.selectedModels.length, selections, "do not switch only the model");
      assert.equal(result.selectedEfforts.length, efforts, "do not switch only the effort");
      result.hooks.get("turn_start")({}, result.ctx);
    }
    const deferredEvents = result.events.filter(
      ({ kind, data }) => kind === "secondary_reconciliation" && data.reason === "deferred_until_prompt_boundary",
    );
    assert.equal(deferredEvents.length, 1);
    assert.equal(deferredEvents[0].data.swapBoundary, "next_run");
    assert.equal(deferredEvents[0].data.accepted, false);
    assert.equal(result.abortCount, 0);
    assert.deepEqual(result.sentMessages, []);
    await settleAgentRun(result, { stopReason: "aborted" });
    const corrected = latest();
    assert.notEqual(corrected, original);
    assert.equal(corrected.features.risk, "critical");
    assert.equal(result.selectedModels.at(-1).id, corrected.selected.modelId);
    assert.equal(result.selectedEfforts.at(-1), corrected.selected.effort);
    assert.equal(
      result.events.filter(({ kind, data }) => kind === "secondary_reconciliation" && data.accepted).length,
      1,
    );
    assert.equal(result.events.findLast(({ kind }) => kind === "secondary_reconciliation").data.swapBoundary, "idle");
    const prepared = await result.hooks.get("before_agent_start")(
      { messageType: "custom", systemPrompt: "system" },
      result.ctx,
    );
    const profile = PROMPT_PROFILES.find(({ id }) => id === corrected.promptProfileId);
    assert.ok(prepared.systemPrompt.includes(profile.guidelines[0]));
    assert.equal(result.abortCount, 0);
    assert.deepEqual(result.sentMessages, []);
  });

  it("drains the deferred whole tuple before compiling the next custom run's forced prompt", async () => {
    const secondary = deferred();
    let primaryCalls = 0;
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => {
        primaryCalls++;
        return primaryClassificationResult({ confidence: 0.6 });
      },
      classifySecondaryTask: async () => secondary.promise,
      models: standardRoutingModels(),
      mode: "active",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-next-run-tuple",
    });
    const latest = () => result.appended.findLast(({ customType }) => customType === "model-router-state").data.active;
    const original = latest();
    startAgentRun(result);
    secondary.resolve(
      classificationResult(2, {
        confidence: 0.95,
        risk: "critical",
        verificationStrength: "security_and_policy",
        independenceRequirement: "different_vendor_review",
      }),
    );
    await flushMicrotasks();
    await endAgentTurn(result);
    assert.equal(latest(), original);
    await result.hooks.get("agent_end")(
      {
        messages: [
          {
            role: "assistant",
            provider: original.selected.provider,
            model: original.selected.modelId,
            stopReason: "aborted",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
          },
        ],
      },
      result.ctx,
    );
    // A generated next run carries no user input and preserves the binding, unlike a new input epoch.
    const prepared = await result.hooks.get("before_agent_start")(
      { messageType: "custom", systemPrompt: "system" },
      result.ctx,
    );
    const corrected = latest();
    assert.notEqual(corrected.promptProfileId, original.promptProfileId);
    assert.equal(result.selectedModels.at(-1).id, corrected.selected.modelId);
    assert.equal(result.selectedModels.at(-1).provider, corrected.selected.provider);
    assert.equal(result.selectedEfforts.at(-1), corrected.selected.effort);
    const profile = PROMPT_PROFILES.find(({ id }) => id === corrected.promptProfileId);
    assert.ok(prepared.systemPrompt.includes(profile.guidelines[0]));
    assert.equal(
      result.events.findLast(({ kind }) => kind === "secondary_reconciliation").data.swapBoundary,
      "next_run",
    );
    assert.equal(primaryCalls, 1, "custom preparation must not reclassify");
    assert.equal(result.abortCount, 0);
    assert.deepEqual(result.sentMessages, []);
  });

  for (const pauseAt of ["route_read", "set_model"]) {
    it(`keeps exactly one fallback owner when reconciliation races at ${pauseAt}`, async () => {
      const secondary = deferred();
      const reached = deferred();
      const release = deferred();
      let pauseRead = false;
      const events = [];
      const result = await runAdapterTurn({
        classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
        classifySecondaryTask: async () => secondary.promise,
        models: standardRoutingModels(),
        mode: "active",
        prompt: "Implement one bounded repository change",
        sessionId: `secondary-fallback-race-${pauseAt}`,
        telemetry: {
          append: async (event) => {
            events.push(event);
          },
          read: async () => {
            if (pauseRead) {
              pauseRead = false;
              reached.resolve();
              await release.promise;
            }
            return [];
          },
        },
      });
      const latest = () =>
        result.appended.findLast(({ customType }) => customType === "model-router-state").data.active;
      const original = latest();
      assert.ok(original.fallbacks.length > 0);
      startAgentRun(result);
      await settleAgentRun(result, { stopReason: "aborted" });
      const persistedBefore = result.appended.length;
      if (pauseAt === "route_read") {
        pauseRead = true;
      } else {
        const setModel = result.pi.setModel;
        let pauseModel = true;
        result.pi.setModel = async (model) => {
          if (pauseModel) {
            pauseModel = false;
            reached.resolve();
            await release.promise;
          }
          return setModel(model);
        };
      }
      secondary.resolve(
        classificationResult(2, {
          confidence: 0.95,
          risk: "critical",
          verificationStrength: "security_and_policy",
          independenceRequirement: "different_vendor_review",
        }),
      );
      await reached.promise;
      const failing = result.commands.get("route").handler("fail availability", result.ctx);
      await waitUntil(() => events.some(({ kind }) => kind === "fallback"));
      if (pauseAt === "route_read") await failing;
      release.resolve();
      await failing;
      await waitUntil(() => events.some(({ kind }) => kind === "secondary_reconciliation"));
      await flushMicrotasks();
      const winner = latest();
      assert.notEqual(winner, original);
      if (pauseAt === "route_read") assert.equal(winner.attemptIndex, original.attemptIndex + 1);
      const installed = result.appended
        .slice(persistedBefore)
        .filter(({ customType }) => customType === "model-router-state");
      assert.equal(installed.length, 1, "only one candidate may replace the captured owner");
      const outcomes = events.filter(({ kind }) => kind === "secondary_reconciliation");
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].data.accepted, winner.attemptIndex === original.attemptIndex);
      if (!outcomes[0].data.accepted) assert.equal(outcomes[0].data.swapBoundary, "dropped");
      assert.equal(
        result.ctx.model.id,
        winner.selected.modelId,
        "a stale setModel completion must not leave Pi on the losing candidate",
      );
      assert.equal(result.ctx.model.provider, winner.selected.provider);
      assert.equal(result.pi.getThinkingLevel(), winner.selected.effort);
      assert.equal(result.abortCount, 0);
      assert.equal(
        result.sentMessages.length,
        winner.attemptIndex > original.attemptIndex ? 1 : 0,
        "only a winning fallback may queue its continuation",
      );
    });
  }

  it("observes an idle secondary tuple correction in shadow mode without selecting or aborting", async () => {
    const secondary = deferred();
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ confidence: 0.6 }),
      classifySecondaryTask: async () => secondary.promise,
      models: standardRoutingModels(),
      mode: "shadow",
      prompt: "Implement one bounded repository change",
      sessionId: "async-secondary-shadow-idle",
    });
    startAgentRun(result);
    await settleAgentRun(result, { stopReason: "aborted" });
    secondary.resolve(
      classificationResult(2, {
        confidence: 0.95,
        risk: "critical",
        verificationStrength: "security_and_policy",
        independenceRequirement: "different_vendor_review",
      }),
    );
    await waitUntil(() => result.events.some(({ kind }) => kind === "secondary_reconciliation"));
    const reconciliation = result.events.findLast(({ kind }) => kind === "secondary_reconciliation");
    assert.equal(reconciliation.data.accepted, true);
    assert.equal(reconciliation.data.swapBoundary, "idle");
    assert.equal(result.selectedModels.length, 0);
    assert.equal(result.selectedEfforts.length, 0);
    assert.equal(result.abortCount, 0);
    assert.deepEqual(result.sentMessages, []);
  });

  it("bounds stalled telemetry, fails active routing safe, and consumes late settlement", async (t) => {
    for (const lateOutcome of ["resolve", "reject"]) {
      await t.test(lateOutcome, async () => {
        const hooks = new Map();
        const appended = [];
        const notifications = [];
        const attempts = [];
        const stalledInvocation = deferred();
        const telemetryDirectory = await mkdtemp(join(tmpdir(), `pi-router-stalled-telemetry-${lateOutcome}-`));
        const previousMode = process.env.PI_ROUTER_MODE;
        process.env.PI_ROUTER_MODE = "active";
        const telemetry = new JsonlTelemetryStore(join(telemetryDirectory, "events.jsonl"), {
          appendTimeoutMs: 20,
          persist: async (item) => {
            attempts.push(item);
            if (item.kind === "classifier_invocation") await stalledInvocation.promise;
          },
        });
        let activeTools = [];
        const pi = {
          on: (event, handler) => hooks.set(event, handler),
          registerCommand: () => {},
          registerTool: () => {},
          appendEntry: (customType, data) => appended.push({ customType, data }),
          exec: async () => ({ code: 1, stdout: "", stderr: "" }),
          getActiveTools: () => activeTools,
          setActiveTools: (tools) => {
            activeTools = tools;
          },
          getThinkingLevel: () => "high",
        };
        const ctx = {
          cwd: telemetryDirectory,
          model: undefined,
          modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
          sessionManager: { getBranch: () => [], getSessionId: () => `stalled-telemetry-${lateOutcome}` },
          getContextUsage: () => ({ tokens: 0, contextWindow: 128_000 }),
          ui: {
            theme: { fg: (_color, text) => text },
            setStatus: () => {},
            setWorkingMessage: () => {},
            setWorkingVisible: () => {},
            notify: (message, type) => notifications.push({ message, type }),
          },
        };
        const unhandled = [];
        const onUnhandledRejection = (reason) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandledRejection);
        try {
          routerExtension(pi, { telemetry });
          const prompt = "Implement the bounded telemetry regression";
          hooks.get("input")({ text: prompt, source: "interactive" }, ctx);
          const startedAt = Date.now();
          await hooks.get("before_agent_start")({ prompt, systemPrompt: "system", images: [] }, ctx);
          const elapsedMs = Date.now() - startedAt;

          assert.ok(elapsedMs < 1_000, `before_agent_start remained blocked for ${String(elapsedMs)}ms`);
          assert.equal(
            appended.findLast((entry) => entry.customType === "model-router-state")?.data.mode,
            "shadow",
            "a telemetry deadline must disable active routing",
          );
          assert.deepEqual(
            attempts.map((item) => item.kind),
            ["boundary", "classifier_invocation"],
            "later diagnostics must not overtake the stalled invocation",
          );
          assert.equal(new Set(attempts.map((item) => item.eventId)).size, attempts.length);
          assert.equal(attempts.filter((item) => item.kind === "classifier_invocation").length, 1);
          assert.equal(attempts[1].data.invocationCount, 1);
          const telemetryFailureNotifications = notifications.filter(({ message }) =>
            message.includes("Router telemetry failed"),
          ).length;
          assert.equal(telemetryFailureNotifications, 1);

          if (lateOutcome === "resolve") stalledInvocation.resolve();
          else stalledInvocation.reject(new Error("late persistence failure"));
          await new Promise(setImmediate);
          await new Promise(setImmediate);

          assert.deepEqual(
            attempts.map((item) => item.kind),
            ["boundary", "classifier_invocation"],
          );
          assert.equal(unhandled.length, 0, "late persistence rejection must be consumed by the queue");
          assert.equal(
            notifications.filter(({ message }) => message.includes("Router telemetry failed")).length,
            telemetryFailureNotifications,
            "late settlement must not apply the failure policy twice",
          );
        } finally {
          process.off("unhandledRejection", onUnhandledRejection);
          if (previousMode === undefined) delete process.env.PI_ROUTER_MODE;
          else process.env.PI_ROUTER_MODE = previousMode;
        }
      });
    }
  });

  it("renders /route scope from the scoped registry in endpoint selection order", async () => {
    const commands = new Map();
    const notifications = [];
    routerExtension({
      on: () => {},
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: () => {},
    });
    const makeModel = (provider, id) => ({
      provider,
      id,
      name: id,
      api: "openai-responses",
      baseUrl: "https://models.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    const models = [makeModel("openai-codex", "gpt-6-sol"), makeModel("amazon-bedrock", "openai.gpt-6-sol")];
    await commands.get("route").handler("scope", {
      modelRegistry: { getAll: () => models, getAvailable: () => models },
      ui: { notify: (message, type) => notifications.push({ message, type }) },
    });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, "info");
    assert.equal(
      notifications[0].message,
      [
        "route scope",
        "patterns (0):",
        "  - source=default pattern=<all registry models>",
        "unmatched patterns (0):",
        "logical models (1):",
        "  gpt-6-sol (2 eligible endpoints):",
        "    1. endpoint=openai-codex/gpt-6-sol listCost=23.750000 appliedWeight=1.000000 weightBasis=preference weightSource=built-in cacheWrite=priced_write effectiveCost=23.750000",
        "    2. endpoint=amazon-bedrock/openai.gpt-6-sol listCost=23.750000 appliedWeight=1.000010 weightBasis=preference weightSource=built-in cacheWrite=priced_write effectiveCost=23.750238",
        "excluded endpoints (0):",
        "provider-weight rejections (0):",
      ].join("\n"),
    );
  });

  it("enriches endpoint-tagged telemetry without changing the event payload", async () => {
    const hooks = new Map();
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-endpoint-telemetry-"));
    const telemetryPath = join(telemetryDirectory, "events.jsonl");
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = telemetryPath;
    const model = {
      provider: "amazon-bedrock",
      id: "openai.gpt-6-sol",
      name: "gpt-6-sol",
      api: "openai-responses",
      baseUrl: "https://models.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    };
    try {
      routerExtension({
        on: (event, handler) => hooks.set(event, handler),
        registerCommand: () => {},
        registerTool: () => {},
        appendEntry: () => {},
      });
      await hooks.get("model_select")(
        { source: "user", model },
        {
          modelRegistry: { find: () => model },
          sessionManager: { getSessionId: () => "endpoint-telemetry" },
          ui: { theme: { fg: (_color, text) => text }, setStatus: () => {}, notify: () => {} },
        },
      );

      const event = JSON.parse((await readFile(telemetryPath, "utf8")).trim());
      assert.equal(event.kind, "outcome");
      assert.deepEqual(event.data, {
        manualOverride: "model",
        provider: "amazon-bedrock",
        modelId: "openai.gpt-6-sol",
      });
      assert.equal(event.endpointEffectiveCost, 23.7502375);
      assert.equal(event.appliedProviderWeight, 1.00001);
      assert.equal(event.providerWeightBasis, "preference");
      assert.equal(event.cacheWriteClassification, "priced_write");
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
    }
  });

  it("uses one scoped registry snapshot for classification and the resulting route decision", async () => {
    const hooks = new Map();
    const notifications = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-shared-snapshot-"));
    const telemetryPath = join(telemetryDirectory, "events.jsonl");
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    const previousMode = process.env.PI_ROUTER_MODE;
    process.env.PI_ROUTER_TELEMETRY_PATH = telemetryPath;
    process.env.PI_ROUTER_MODE = "shadow";
    let activeTools = [];
    let snapshotReads = 0;
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
      appendEntry: () => {},
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      getActiveTools: () => activeTools,
      getThinkingLevel: () => "high",
      setActiveTools: (tools) => {
        activeTools = tools;
      },
    };
    const ctx = {
      cwd: telemetryDirectory,
      // Defined so builder-provenance resolution also runs; with an undefined model that branch
      // never reads the registry and could not observe a duplicate snapshot build.
      model: { provider: "openai-codex", id: "gpt-6-sol" },
      modelRegistry: {
        getAvailable: () => [],
        getAll: () => {
          snapshotReads++;
          return [];
        },
      },
      sessionManager: { getBranch: () => [], getSessionId: () => "shared-snapshot" },
      getContextUsage: () => ({ tokens: 0, contextWindow: 128_000 }),
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        setWorkingMessage: () => {},
        setWorkingVisible: () => {},
        notify: (message, type) => notifications.push({ message, type }),
      },
    };
    try {
      routerExtension(pi);
      await hooks.get("input")({ text: "Implement the change", source: "interactive" }, ctx);
      await hooks.get("before_agent_start")(
        { prompt: "Implement the change", systemPrompt: "system", images: [] },
        ctx,
      );
      assert.equal(snapshotReads, 1, "classification, builder provenance, and routing must share one scoped snapshot");
      // One copy contract for the user-reported warning; routing behavior is covered separately above.
      assert.equal(
        notifications.at(-1)?.message,
        "Shadow routing skipped: classification did not produce validated task features",
      );
      const events = (await readFile(telemetryPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const invocations = events.filter((item) => item.kind === "classifier_invocation");
      assert.equal(invocations.length, 1, "one fresh-task request emits one invocation metric");
      assert.equal(invocations[0].data.purpose, "fresh_task");
      assert.equal(invocations[0].data.outcome, "success");
      assert.equal(invocations[0].data.resolution, "failed_closed");
      assert.equal(invocations[0].data.invocationCount, 1);
      assert.equal(invocations[0].data.attemptCount, 2);
      assert.doesNotMatch(JSON.stringify(invocations[0]), /Implement the change|system|No configured/);
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
      if (previousMode === undefined) delete process.env.PI_ROUTER_MODE;
      else process.env.PI_ROUTER_MODE = previousMode;
    }
  });

  it("records retained continuity explicitly without persisting request or classifier errors", async () => {
    const hooks = new Map();
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-continuity-telemetry-"));
    const telemetryPath = join(telemetryDirectory, "events.jsonl");
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = telemetryPath;
    const now = new Date().toISOString();
    const choice = {
      provider: "openai-codex",
      modelId: "gpt-6-sol",
      logicalModelId: "gpt-6-sol",
      vendor: "openai",
      effort: "high",
      ability: 3,
      profileId: "openai-gpt-6-agent-v1",
      contextWindow: 1_000_000,
      endpointTier: "manufacturer",
      rankReason: "bootstrap",
    };
    const lease = {
      version: 2,
      taskId: "continuity-task",
      startedAt: now,
      updatedAt: now,
      archetype: "median_repository_implementation",
      features: conservativeFeatures("fixture"),
      selected: choice,
      fallbacks: [{ ...choice, provider: "openai" }],
      attemptIndex: 0,
      promptProfileId: choice.profileId,
      modelSnapshotId: "snapshot",
      policyVersion: POLICY_VERSION,
      lastPromptFingerprint: "fingerprint",
      lifecycle: { phase: "ordinary", policy: "ordinary", taskFingerprint: "task-fingerprint" },
      safetyEvidence: { baselineChangedFiles: [], checks: [], mutations: [] },
      manualOverride: false,
    };
    const branch = [
      {
        type: "custom",
        customType: "model-router-state",
        data: { secondarySafetyPending: false, mode: "shadow", manualOverride: false, active: lease },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 40_000, output: 100, cacheRead: 30_000, cost: { total: 0.01 } },
        },
      },
    ];
    let activeTools = [];
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
      appendEntry: () => {},
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      getActiveTools: () => activeTools,
      setActiveTools: (tools) => {
        activeTools = tools;
      },
      getThinkingLevel: () => "high",
    };
    const ctx = {
      cwd: telemetryDirectory,
      model: undefined,
      modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
      sessionManager: { getBranch: () => branch, getSessionId: () => "continuity-session" },
      getContextUsage: () => ({ tokens: 40_100, contextWindow: 1_000_000, percent: 4 }),
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        setWorkingMessage: () => {},
        setWorkingVisible: () => {},
        notify: () => {},
      },
    };
    try {
      routerExtension(pi);
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      const request = "Please address the remaining verification details credential=do-not-record";
      await hooks.get("input")({ text: request, source: "interactive" }, ctx);
      await hooks.get("before_agent_start")(
        { prompt: request, systemPrompt: "private system prompt", images: [] },
        ctx,
      );

      const events = (await readFile(telemetryPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const invocations = events.filter((item) => item.kind === "classifier_invocation");
      assert.equal(invocations.length, 1);
      assert.equal(invocations[0].taskId, lease.taskId);
      assert.equal(invocations[0].data.purpose, "continuity");
      assert.equal(invocations[0].data.outcome, "success");
      assert.equal(invocations[0].data.resolution, "retained_continuity");
      assert.equal(invocations[0].data.failedClosed, true);
      assert.equal(invocations[0].data.attemptCount, 2);
      assert.doesNotMatch(JSON.stringify(invocations[0]), /do-not-record|private system prompt|No configured/);
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
    }
  });

  it("records timeout and cancellation continuity failures after retaining the active lease", async (t) => {
    for (const expected of [
      { errorName: "TimeoutError", outcome: "timeout", timedOut: true, cancelled: false },
      { errorName: "AbortError", outcome: "error", timedOut: false, cancelled: true },
    ]) {
      await t.test(expected.errorName, async () => {
        const hooks = new Map();
        const commands = new Map();
        const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-continuity-failure-"));
        const telemetryPath = join(telemetryDirectory, "events.jsonl");
        const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
        process.env.PI_ROUTER_TELEMETRY_PATH = telemetryPath;
        const now = new Date().toISOString();
        const choice = {
          provider: "openai-codex",
          modelId: "gpt-6-sol",
          logicalModelId: "gpt-6-sol",
          vendor: "openai",
          effort: "high",
          ability: 3,
          profileId: "openai-gpt-6-agent-v1",
          contextWindow: 1_000_000,
          endpointTier: "manufacturer",
          rankReason: "bootstrap",
        };
        const lease = {
          version: 2,
          taskId: `continuity-${expected.errorName}`,
          startedAt: now,
          updatedAt: now,
          archetype: "median_repository_implementation",
          features: conservativeFeatures("fixture"),
          selected: choice,
          fallbacks: [{ ...choice, provider: "openai" }],
          attemptIndex: 0,
          promptProfileId: choice.profileId,
          modelSnapshotId: "snapshot",
          policyVersion: POLICY_VERSION,
          lastPromptFingerprint: "fingerprint",
          lifecycle: { phase: "ordinary", policy: "ordinary", taskFingerprint: "task-fingerprint" },
          safetyEvidence: { baselineChangedFiles: [], checks: [], mutations: [] },
          manualOverride: false,
        };
        const branch = [
          {
            type: "custom",
            customType: "model-router-state",
            data: { secondarySafetyPending: false, mode: "shadow", manualOverride: false, active: lease },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              usage: { input: 40_000, output: 100, cacheRead: 30_000, cost: { total: 0.01 } },
            },
          },
        ];
        const classifierModel = {
          provider: "openai-codex",
          id: "gpt-6-luna",
          name: "gpt-6-luna",
          api: "openai-responses",
          baseUrl: "https://models.invalid",
          reasoning: true,
          input: ["text"],
          cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
          contextWindow: 128_000,
          maxTokens: 4_096,
        };
        let activeTools = [];
        const pi = {
          on: (event, handler) => hooks.set(event, handler),
          registerCommand: (name, command) => commands.set(name, command),
          registerTool: () => {},
          appendEntry: () => {},
          exec: async () => ({ code: 1, stdout: "", stderr: "" }),
          getActiveTools: () => activeTools,
          setActiveTools: (tools) => {
            activeTools = tools;
          },
          getThinkingLevel: () => "high",
        };
        const notifications = [];
        const ctx = {
          cwd: telemetryDirectory,
          model: undefined,
          modelRegistry: {
            getAll: () => [classifierModel],
            getAvailable: () => [classifierModel],
            find: () => classifierModel,
            getApiKeyAndHeaders: async () => {
              const error = new Error("raw classifier credential=must-not-persist");
              error.name = expected.errorName;
              throw error;
            },
          },
          sessionManager: { getBranch: () => branch, getSessionId: () => `session-${expected.errorName}` },
          getContextUsage: () => ({ tokens: 40_100, contextWindow: 1_000_000, percent: 4 }),
          ui: {
            theme: { fg: (_color, text) => text },
            setStatus: () => {},
            setWorkingMessage: () => {},
            setWorkingVisible: () => {},
            notify: (message, type) => notifications.push({ message, type }),
          },
        };
        try {
          routerExtension(pi);
          await hooks.get("session_start")({ reason: "reload" }, ctx);
          const request = "Address the remaining verification details";
          await hooks.get("input")({ text: request, source: "interactive" }, ctx);
          await hooks.get("before_agent_start")({ prompt: request, systemPrompt: "system", images: [] }, ctx);
          await commands.get("route").handler("", ctx);

          assert.equal((notifications.at(-1)?.message ?? "").includes(`task=${lease.taskId}`), true);
          assert.ok(
            notifications.some(({ message }) => /keeping the current task and model selection/i.test(message)),
            "failure policy must announce lease retention",
          );
          const events = (await readFile(telemetryPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const invocation = events.find((item) => item.kind === "classifier_invocation");
          assert.equal(invocation.taskId, lease.taskId);
          assert.equal(invocation.data.purpose, "continuity");
          assert.equal(invocation.data.outcome, expected.outcome);
          assert.equal(invocation.data.timedOut, expected.timedOut);
          assert.equal(invocation.data.cancelled, expected.cancelled);
          assert.equal(invocation.data.resolution, "retained_continuity");
          assert.doesNotMatch(JSON.stringify(invocation), /must-not-persist|raw classifier|credential=/i);
        } finally {
          if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
          else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
        }
      });
    }
  });

  it("carries routing enablement mode through /clear (session_shutdown → session_start)", async () => {
    const hooks = new Map();
    const commands = new Map();
    const appended = [];
    routerExtension({
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: () => {},
      appendEntry: (customType, data) => appended.push({ customType, data }),
    });

    const lastModePath = join(await mkdtemp(join(tmpdir(), "pi-router-clear-")), "last-mode.jsonl");
    const previousLastModePath = process.env.PI_ROUTER_LAST_MODE_PATH;
    process.env.PI_ROUTER_LAST_MODE_PATH = lastModePath;

    // The operator enables routing before clearing.
    await commands.get("route").handler("active", {
      sessionManager: { getSessionId: () => "pre-clear" },
      ui: { theme: { fg: (_color, text) => text }, setStatus: () => {}, notify: () => {} },
    });
    assert.equal(appended.at(-1).data.mode, "active");

    // Simulate session_shutdown when /clear creates a new session.
    await hooks.get("session_shutdown")({
      type: "session_shutdown",
      reason: "new",
    });

    // After shutdown, session_start is called for the replacement session.
    // The new session has no prior entries (fresh branch).
    const beforeStartPersist = appended.filter((e) => e.customType === "model-router-state").length;

    await hooks.get("session_start")(
      {
        type: "session_start",
        reason: "new",
      },
      {
        cwd: "/repo",
        sessionManager: {
          getSessionId: () => "new-session",
          getBranch: () => [
            // New session has no prior router state; should restore from modeForNextSession.
          ],
        },
        modelRegistry: { getAvailable: () => [], getAll: () => [] },
        model: undefined,
        getContextUsage: () => ({ tokens: 0, contextWindow: 128000 }),
        ui: {
          setStatus: () => {},
          notify: () => {},
          theme: { fg: (_color, text) => text },
        },
      },
    );

    // Verify that session_start appended a router state entry (the mode was persisted).
    const persistedEntriesAfter = appended.filter((e) => e.customType === "model-router-state");
    assert.equal(
      persistedEntriesAfter.length,
      beforeStartPersist + 1,
      "session_start should persist the restored mode",
    );
    assert.equal(persistedEntriesAfter.at(-1).data.mode, "active", "/clear must not disable active routing");
    assert.equal(persistedEntriesAfter.at(-1).data.active, undefined, "/clear must still drop the task lease");
    const recorded = (await readFile(lastModePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(recorded.at(-1).mode, "active", "the mode in force must be recorded for the next start");
    process.env.PI_ROUTER_LAST_MODE_PATH = previousLastModePath;
  });

  it("keeps active routing through /compact while dropping the lease at the boundary", async () => {
    const hooks = new Map();
    const commands = new Map();
    const appended = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-compact-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    const previousLastModePath = process.env.PI_ROUTER_LAST_MODE_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = join(telemetryDirectory, "events.jsonl");
    process.env.PI_ROUTER_LAST_MODE_PATH = join(telemetryDirectory, "last-mode.jsonl");
    try {
      routerExtension({
        on: (event, handler) => hooks.set(event, handler),
        registerCommand: (name, command) => commands.set(name, command),
        registerTool: () => {},
        appendEntry: (customType, data) => appended.push({ customType, data }),
      });
      const ctx = {
        sessionManager: { getSessionId: () => "compacting" },
        ui: { theme: { fg: (_color, text) => text }, setStatus: () => {}, notify: () => {} },
      };
      await commands.get("route").handler("active", ctx);

      await hooks.get("session_compact")({ type: "session_compact" }, ctx);

      const persisted = appended.filter((entry) => entry.customType === "model-router-state");
      assert.equal(persisted.at(-1).data.mode, "active", "/compact must not disable active routing");
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
      process.env.PI_ROUTER_LAST_MODE_PATH = previousLastModePath;
    }
  });

  it("reads startMode from config file when env var is not set", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-router-config-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousMode = process.env.PI_ROUTER_MODE;

    try {
      process.env.PI_CODING_AGENT_DIR = tempDir;
      delete process.env.PI_ROUTER_MODE;

      // Write config file with startMode = active
      await writeFile(join(tempDir, "router-config.json"), JSON.stringify({ startMode: "active" }));

      const hooks = new Map();
      const appended = [];
      routerExtension({
        on: (event, handler) => hooks.set(event, handler),
        registerCommand: () => {},
        registerTool: () => {},
        appendEntry: (customType, data) => appended.push({ customType, data }),
      });

      // Simulate startup with no prior state — should load from config
      await hooks.get("session_start")(
        {
          type: "session_start",
          reason: "startup",
        },
        {
          cwd: "/repo",
          sessionManager: {
            getSessionId: () => "startup-session",
            getBranch: () => [],
          },
          modelRegistry: { getAvailable: () => [], getAll: () => [] },
          model: undefined,
          getContextUsage: () => ({ tokens: 0, contextWindow: 128000 }),
          ui: {
            setStatus: () => {},
            notify: () => {},
            theme: { fg: (_color, text) => text },
          },
        },
      );

      // Verify state was set to active from config
      const entries = appended.filter((e) => e.customType === "model-router-state");
      assert.ok(entries.length > 0, "should persist router state from config");
      assert.equal(entries[entries.length - 1].data.mode, "active", "should use startMode from config file");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousMode === undefined) delete process.env.PI_ROUTER_MODE;
      else process.env.PI_ROUTER_MODE = previousMode;
    }
  });

  it("applies the configured start mode when input arrives while startup settings load", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-router-start-race-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousMode = process.env.PI_ROUTER_MODE;
    const previousLastModePath = process.env.PI_ROUTER_LAST_MODE_PATH;
    try {
      process.env.PI_CODING_AGENT_DIR = tempDir;
      delete process.env.PI_ROUTER_MODE;
      process.env.PI_ROUTER_LAST_MODE_PATH = join(tempDir, "router-last-mode.jsonl");
      await writeFile(join(tempDir, "router-config.json"), JSON.stringify({ startMode: "active" }));
      const hooks = new Map();
      const appended = [];
      const statuses = [];
      const lookup = deferred();
      const lookupReached = deferred();
      routerExtension({
        on: (event, handler) => hooks.set(event, handler),
        registerCommand: () => {},
        registerTool: () => {},
        appendEntry: (customType, data) => appended.push({ customType, data }),
        exec: async (command, args) => {
          if (command === "git" && args.includes("get-url")) {
            lookupReached.resolve();
            await lookup.promise;
          }
          return { stdout: "", stderr: "", code: 1, killed: false };
        },
      });
      const ctx = {
        cwd: tempDir,
        sessionManager: { getSessionId: () => "start-race", getBranch: () => [] },
        modelRegistry: { getAvailable: () => [], getAll: () => [] },
        model: undefined,
        getContextUsage: () => ({ tokens: 0, contextWindow: 128000 }),
        ui: {
          setStatus: (_key, text) => statuses.push(text),
          setWorkingMessage: () => {},
          setWorkingVisible: () => {},
          notify: () => {},
          theme: { fg: (_color, text) => text },
        },
      };
      const starting = hooks.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
      await lookupReached.promise;
      // The first prompt arrives before startup finishes resolving its repository and start mode.
      await hooks.get("input")({ text: "Summarize the repository", source: "interactive" }, ctx);
      lookup.resolve();
      await starting;
      assert.equal(
        appended.filter(({ customType }) => customType === "model-router-state").at(-1)?.data.mode,
        "active",
        "the configured start mode still applies",
      );
      assert.match(statuses.at(-1), /^route:active/);
    } finally {
      restoreEnv({ previousAgentDir, previousMode, previousLastModePath });
    }
  });

  it("starts in the last recorded mode by default so enablement survives a restart", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-router-last-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousMode = process.env.PI_ROUTER_MODE;
    const previousLastModePath = process.env.PI_ROUTER_LAST_MODE_PATH;
    try {
      process.env.PI_CODING_AGENT_DIR = tempDir;
      delete process.env.PI_ROUTER_MODE;
      process.env.PI_ROUTER_LAST_MODE_PATH = join(tempDir, "router-last-mode.jsonl");
      // No router-config.json: the built-in preference is the last recorded mode.
      await writeFile(
        process.env.PI_ROUTER_LAST_MODE_PATH,
        `${JSON.stringify({ version: 1, mode: "active", updatedAt: "2026-01-01T00:00:00.000Z" })}\n`,
      );

      const entries = await startupRouterState();
      assert.equal(entries.at(-1)?.data.mode, "active", "startup should restore the recorded exit mode");
    } finally {
      restoreEnv({ previousAgentDir, previousMode, previousLastModePath });
    }
  });

  it("lets a repository-scoped startMode override the global one", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-router-repo-scope-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousMode = process.env.PI_ROUTER_MODE;
    const previousLastModePath = process.env.PI_ROUTER_LAST_MODE_PATH;
    try {
      process.env.PI_CODING_AGENT_DIR = tempDir;
      delete process.env.PI_ROUTER_MODE;
      process.env.PI_ROUTER_LAST_MODE_PATH = join(tempDir, "router-last-mode.jsonl");
      await writeFile(join(tempDir, "router-config.json"), JSON.stringify({ startMode: "off" }));
      await writeFile(
        join(tempDir, "repo-router-config.json"),
        JSON.stringify({
          "github.com:nigel-upstart/pi-buildout": { startMode: "active" },
          "github.com:other/repo": { startMode: "off" },
        }),
      );

      const entries = await startupRouterState({
        exec: (_command, args) => {
          const gitArgs = args.slice(2);
          if (gitArgs[0] === "remote" && gitArgs[1] === "get-url" && gitArgs[2] === "upstream") {
            return Promise.resolve({ code: 0, stdout: "git@github.com:nigel-upstart/pi-buildout.git\n", stderr: "" });
          }
          return Promise.resolve({ code: 1, stdout: "", stderr: "" });
        },
      });
      assert.equal(entries.at(-1)?.data.mode, "active", "the repository entry should win over the global file");
    } finally {
      restoreEnv({ previousAgentDir, previousMode, previousLastModePath });
    }
  });

  it("acknowledges input immediately and shows the routing spinner before repository I/O finishes", async () => {
    const hooks = new Map();
    const workingMessages = [];
    const visibility = [];
    const never = new Promise(() => {});
    let activeTools = ["read", "bash", "submit_action_plan", "submit_safety_review"];
    routerExtension({
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
      appendEntry: () => {},
      exec: () => never,
      getActiveTools: () => activeTools,
      setActiveTools: (tools) => {
        activeTools = tools;
      },
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
    assert.deepEqual(activeTools, ["read", "bash"], "shadow startup remains free of safety validators");
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
    let activeTools = ["read", "bash", "submit_action_plan", "submit_safety_review"];
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: () => {},
      appendEntry: (customType, data) => appended.push({ customType, data }),
      getActiveTools: () => activeTools,
      setActiveTools: (tools) => {
        activeTools = tools;
      },
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
      assert.deepEqual(activeTools, ["read", "bash"], "telemetry fallback must hide both validators immediately");
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

  it("retains one evidence entry per deterministic check command", async () => {
    const hooks = new Map();
    const appended = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-check-evidence-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = join(telemetryDirectory, "events.jsonl");
    const now = new Date().toISOString();
    const choice = {
      provider: "openai",
      modelId: "gpt-5.6-terra",
      logicalModelId: "gpt-5.6-terra",
      vendor: "openai",
      effort: "high",
      ability: 2,
      profileId: "openai-gpt-6-agent-v1",
      contextWindow: 1_000_000,
      endpointTier: "manufacturer",
      rankReason: "bootstrap",
    };
    const lease = {
      version: 2,
      taskId: "check-evidence-task",
      startedAt: now,
      updatedAt: now,
      archetype: "median_repository_implementation",
      features: conservativeFeatures("check evidence retention test"),
      selected: choice,
      fallbacks: [{ ...choice, provider: "openai-codex" }],
      attemptIndex: 0,
      promptProfileId: choice.profileId,
      modelSnapshotId: "snapshot",
      policyVersion: POLICY_VERSION,
      lastPromptFingerprint: "fingerprint",
      lifecycle: { phase: "building", policy: "completion_review", taskFingerprint: "task-fingerprint" },
      safetyEvidence: { baselineChangedFiles: [], checks: [], mutations: [] },
      manualOverride: false,
    };
    const branch = [
      {
        type: "custom",
        customType: "model-router-state",
        data: { secondarySafetyPending: false, mode: "active", manualOverride: false, active: lease },
      },
    ];
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
      appendEntry: (customType, data) => appended.push({ customType, data }),
      sendMessage: () => {},
      setModel: async () => true,
      setThinkingLevel: () => {},
      getThinkingLevel: () => "high",
      exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    };
    routerExtension(pi);
    const ctx = {
      cwd: telemetryDirectory,
      model: undefined,
      modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
      sessionManager: { getBranch: () => branch, getSessionId: () => "check-evidence-session" },
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_000_000, percent: 1 }),
      ui: { theme: { fg: (_color, text) => text }, setStatus: () => {}, notify: () => {} },
    };
    const latestChecks = () =>
      appended.findLast((entry) => entry.customType === "model-router-state")?.data.active.safetyEvidence.checks;
    const runCheck = (toolCallId, command, isError) => {
      hooks.get("tool_call")({ toolCallId, toolName: "bash", input: { command } });
      hooks.get("tool_execution_end")({ toolCallId, toolName: "bash", isError });
    };
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      runCheck("call-1", "npm test", true);
      runCheck("call-2", "npm run lint", false);
      runCheck("call-3", "npm test", false);
      assert.deepEqual(
        latestChecks().map((check) => [check.command, check.passed]),
        [
          ["npm run lint", true],
          ["npm test", true],
        ],
        "each command keeps exactly its latest outcome",
      );

      for (let index = 0; index < 25; index++) {
        runCheck(`flood-${String(index)}`, `npm test -- shard${String(index)}`, false);
      }
      assert.equal(latestChecks().length, 20, "retention stays bounded");

      for (let index = 0; index < 25; index++) runCheck(`repeat-${String(index)}`, "npm run lint", index === 24);
      const repeated = latestChecks().filter((check) => check.command === "npm run lint");
      assert.deepEqual(
        repeated.map((check) => check.passed),
        [false],
        "a repeated command keeps exactly one entry and retains its unresolved failure",
      );
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
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
      modelId: "claude-opus-5-5",
      logicalModelId: "claude-opus-5-5",
      vendor: "anthropic",
      effort: "high",
      ability: 4,
      profileId: "anthropic-claude-planning-v1",
      contextWindow: 1_000_000,
      endpointTier: "manufacturer",
      rankReason: "evidence_prior",
    };
    const fallbackChoice = {
      provider: "openai-codex",
      modelId: "gpt-6-sol",
      logicalModelId: "gpt-6-sol",
      vendor: "openai",
      effort: "high",
      ability: 3,
      profileId: "openai-gpt-6-agent-v1",
      contextWindow: 1_000_000,
      endpointTier: "manufacturer",
      rankReason: "evidence_prior",
    };
    const lease = {
      version: 2,
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
      policyVersion: POLICY_VERSION,
      lastPromptFingerprint: "fingerprint",
      lifecycle: { phase: "ordinary", policy: "ordinary", taskFingerprint: "task-fingerprint" },
      safetyEvidence: { baselineChangedFiles: [], checks: [], mutations: [] },
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
    const models = [makeModel(primaryChoice), makeModel(fallbackChoice)];
    const branch = [
      {
        type: "custom",
        customType: "model-router-state",
        data: { secondarySafetyPending: false, mode: "active", manualOverride: false, active: lease },
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

  it("moves a persisted Bedrock Sol lease off an endpoint with no long-context price", async () => {
    const hooks = new Map();
    const appended = [];
    const selectedModels = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-long-context-lease-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = join(telemetryDirectory, "events.jsonl");
    const now = new Date().toISOString();
    const choices = [
      {
        provider: "amazon-bedrock",
        modelId: "global.openai.gpt-6-sol",
        logicalModelId: "gpt-6-sol",
        vendor: "openai",
        effort: "high",
        ability: 3,
        profileId: "openai-gpt-6-agent-v1",
        contextWindow: 1_000_000,
        endpointTier: "resale",
        rankReason: "bootstrap",
      },
      {
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        logicalModelId: "claude-sonnet-5",
        vendor: "anthropic",
        effort: "high",
        ability: 3,
        profileId: "anthropic-claude-fast-agent-v1",
        contextWindow: 1_000_000,
        endpointTier: "manufacturer",
        rankReason: "bootstrap",
      },
    ];
    const lease = {
      version: 2,
      taskId: "long-context-lease-task",
      startedAt: now,
      updatedAt: now,
      archetype: "median_repository_implementation",
      features: conservativeFeatures("long-context lease test"),
      selected: choices[0],
      fallbacks: choices.slice(1),
      attemptIndex: 0,
      promptProfileId: choices[0].profileId,
      modelSnapshotId: "snapshot",
      policyVersion: POLICY_VERSION,
      lastPromptFingerprint: "fingerprint",
      lifecycle: { phase: "ordinary", policy: "ordinary", taskFingerprint: "task-fingerprint" },
      safetyEvidence: { baselineChangedFiles: [], checks: [], mutations: [] },
      manualOverride: false,
    };
    const models = choices.map((choice) => ({
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
    }));
    const branch = [
      {
        type: "custom",
        customType: "model-router-state",
        data: { secondarySafetyPending: false, mode: "active", manualOverride: false, active: lease },
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
      getActiveTools: () => [],
      setActiveTools: () => {},
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
      sessionManager: { getBranch: () => branch, getSessionId: () => "long-context-lease-session" },
      getContextUsage: () => ({ tokens: 272_001, contextWindow: 1_000_000, percent: 28 }),
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        setWorkingMessage: () => {},
        setWorkingVisible: () => {},
        notify: () => {},
      },
    };
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      await hooks.get("before_agent_start")({ prompt: "Continue the task", systemPrompt: "base" }, ctx);
      const latestLease = appended.findLast((entry) => entry.customType === "model-router-state")?.data.active;
      assert.equal(latestLease.selected.provider, "anthropic");
      assert.equal(latestLease.attemptIndex, 1);
      assert.ok(selectedModels.length > 0);
      assert.ok(selectedModels.every((model) => model.provider === "anthropic"));
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
    const telemetryPath = join(telemetryDirectory, "events.jsonl");
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = telemetryPath;
    const now = new Date().toISOString();
    const choices = [
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-terra",
        logicalModelId: "gpt-5.6-terra",
        vendor: "openai",
        effort: "high",
        ability: 2,
        profileId: "openai-gpt-6-agent-v1",
        contextWindow: 1_000_000,
        endpointTier: "manufacturer",
        rankReason: "bootstrap",
      },
      {
        provider: "openai",
        modelId: "gpt-5.6-terra",
        logicalModelId: "gpt-5.6-terra",
        vendor: "openai",
        effort: "high",
        ability: 2,
        profileId: "openai-gpt-6-agent-v1",
        contextWindow: 1_000_000,
        endpointTier: "manufacturer",
        rankReason: "bootstrap",
      },
      {
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        logicalModelId: "claude-sonnet-5",
        vendor: "anthropic",
        effort: "high",
        ability: 3,
        profileId: "anthropic-claude-fast-agent-v1",
        contextWindow: 1_000_000,
        endpointTier: "manufacturer",
        rankReason: "bootstrap",
      },
    ];
    const lease = {
      version: 2,
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
      policyVersion: POLICY_VERSION,
      lastPromptFingerprint: "fingerprint",
      lifecycle: { phase: "ordinary", policy: "ordinary", taskFingerprint: "task-fingerprint" },
      safetyEvidence: { baselineChangedFiles: [], checks: [], mutations: [] },
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
        data: { secondarySafetyPending: false, mode: "active", manualOverride: false, active: lease },
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
              usage: { input: 100, output: 0, cacheRead: 25, cacheWrite: 10, cost: { total: 0 } },
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
      const attempts = (await readFile(telemetryPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((event) => event.kind === "attempt_completed");
      assert.deepEqual(
        attempts.map((event) => [event.provider, event.data.cacheReadTokens, event.data.cacheWriteTokens]),
        [
          ["openai-codex", 25, 10],
          ["openai", 25, 10],
          ["anthropic", 25, 10],
        ],
      );
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
    }
  });

  it("fast-skips exhausted provider candidates upon provider usage limit error during agent_end", async () => {
    const hooks = new Map();
    const appended = [];
    const selectedModels = [];
    const notifications = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-quota-fast-skip-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    const telemetryPath = join(telemetryDirectory, "events.jsonl");
    process.env.PI_ROUTER_TELEMETRY_PATH = telemetryPath;
    const now = new Date().toISOString();
    const choices = [
      {
        provider: "openai-codex",
        modelId: "gpt-6-sol",
        logicalModelId: "gpt-6-sol",
        vendor: "openai",
        effort: "high",
        ability: 3,
        profileId: "openai-gpt-6-agent-v1",
        contextWindow: 1_000_000,
        endpointTier: "manufacturer",
        rankReason: "bootstrap",
      },
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-terra",
        logicalModelId: "gpt-5.6-terra",
        vendor: "openai",
        effort: "high",
        ability: 2,
        profileId: "openai-gpt-6-agent-v1",
        contextWindow: 1_000_000,
        endpointTier: "manufacturer",
        rankReason: "bootstrap",
      },
      {
        provider: "openai-codex",
        modelId: "gpt-6-sol",
        logicalModelId: "gpt-6-sol",
        vendor: "openai",
        effort: "medium",
        ability: 2,
        profileId: "openai-gpt-6-agent-v1",
        contextWindow: 1_000_000,
        endpointTier: "manufacturer",
        rankReason: "bootstrap",
      },
      {
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        logicalModelId: "claude-opus-5-5",
        vendor: "anthropic",
        effort: "medium",
        ability: 3,
        profileId: "anthropic-claude-opus-5-5-agent-v1",
        contextWindow: 1_000_000,
        endpointTier: "manufacturer",
        rankReason: "evidence_prior",
      },
    ];
    const lease = {
      version: 2,
      taskId: "quota-fast-skip-task",
      startedAt: now,
      updatedAt: now,
      archetype: "deliberate_tool_workflow",
      features: conservativeFeatures("quota exhaustion fast-skip test"),
      selected: choices[0],
      fallbacks: choices.slice(1),
      attemptIndex: 0,
      promptProfileId: choices[0].profileId,
      modelSnapshotId: "snapshot",
      policyVersion: POLICY_VERSION,
      lastPromptFingerprint: "fingerprint",
      lifecycle: { phase: "ordinary", policy: "ordinary", taskFingerprint: "task-fingerprint" },
      safetyEvidence: { baselineChangedFiles: [], checks: [], mutations: [] },
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
        data: { secondarySafetyPending: false, mode: "active", manualOverride: false, active: lease },
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
        getSessionId: () => "quota-fast-skip-session",
      },
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_000_000, percent: 1 }),
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        notify: (message, type) => notifications.push({ message, type }),
      },
    };
    const latestLease = () => appended.findLast((entry) => entry.customType === "model-router-state")?.data.active;
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      ctx.model = models[0];
      hooks.get("agent_start")();
      await hooks.get("agent_end")(
        {
          messages: [
            {
              role: "assistant",
              provider: models[0].provider,
              model: models[0].id,
              stopReason: "error",
              errorMessage: "Codex error: The usage limit has been reached",
              usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
            },
          ],
        },
        ctx,
      );
      assert.equal(latestLease().selected.provider, "anthropic");
      assert.equal(latestLease().selected.modelId, "claude-opus-5-5");
      assert.equal(latestLease().attemptIndex, 1);
      assert.deepEqual(
        latestLease().fallbacks.map((c) => c.provider),
        ["anthropic"],
      );
      assert.deepEqual(
        selectedModels.map((model) => model.provider),
        ["anthropic"],
      );
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
    }
  });

  async function launchReview(fixture, runner) {
    await fixture.hooks.get("session_start")({ reason: "reload" }, fixture.ctx);
    await fixture.tools
      .get("submit_action_plan")
      .execute("plan", irreversibleActionPlan(), undefined, undefined, fixture.ctx);
    await fixture.hooks.get("agent_settled")({}, fixture.ctx);
    await flushMicrotasks();
    // Parent-side child selection is asynchronous; wait until a runner actually starts.
    if (runner) await waitForReview(() => runner.calls.length > 0);
  }
  it("defers plan advice until an in-flight custom-start preparation finishes", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    try {
      await launchReview(fixture);
      await waitForReview(() => runner.calls.length === 1);
      let releaseMetadata = () => {};
      let metadataHeld = false;
      const held = new Promise((resolve) => {
        releaseMetadata = resolve;
      });
      fixture.onExec(async () => {
        fixture.onExec(undefined);
        metadataHeld = true;
        await held;
        return undefined;
      });
      const started = fixture.hooks.get("before_agent_start")(
        { messageType: "custom", systemPrompt: "system" },
        fixture.ctx,
      );
      await waitForReview(() => metadataHeld);
      runner.calls[0].resolve({
        status: "completed",
        verdict: validAdvice(runner.calls[0].request),
        usage: { cost: 0.01, inputTokens: 1, outputTokens: 1 },
      });
      // Give the reviewer outcome time to apply; it must wait for the preparation instead.
      for (let i = 0; i < 40 && fixture.latestLease().lifecycle.phase === "planning"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const phaseDuringPreparation = fixture.latestLease().lifecycle.phase;
      releaseMetadata();
      const prepared = await started;
      assert.ok(prepared?.systemPrompt, "the custom start still receives the routed system prompt");
      assert.equal(phaseDuringPreparation, "planning", "advice waits for the preparation");
      await waitForReview(() => fixture.latestLease().lifecycle.phase === "executing");
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("reviews work that settled before the plan-review ladder failed", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    const { hooks, ctx } = fixture;
    try {
      await launchReview(fixture);
      await waitForReview(() => runner.calls.length === 1);
      await hooks.get("tool_call")({ toolName: "write", input: { path: "x", content: "x" }, toolCallId: "w" }, ctx);
      await hooks.get("tool_execution_end")({ toolCallId: "w", isError: false }, ctx);
      // The builder settles while the plan review is still running, so settlement cannot review the work.
      await hooks.get("agent_settled")({}, ctx);
      await flushMicrotasks();
      assert.ok(runner.calls.every((call) => call.request.kind === "plan"));
      // Every plan reviewer then fails.
      for (let i = 0; i < 400 && !runner.calls.some((call) => call.request.kind === "completion"); i++) {
        const open = runner.calls.filter((call) => call.request.kind === "plan" && !call.settled);
        for (const call of open) {
          call.settled = true;
          call.resolve({ status: "failed", usage: { cost: 0, inputTokens: 0, outputTokens: 0 } });
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(
        runner.calls.some((call) => call.request.kind === "completion"),
        "the settled work gets completion review once the plan ladder ends without advice",
      );
      assert.equal(
        fixture.sent.some((s) => s.options?.triggerTurn),
        false,
        "no model turn is started",
      );
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("delivers out-of-band plan advice without changing builder model or effort", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    const { ctx, selectedModels, latestLease, sent, restoreEnvironment } = fixture;
    const model = ctx.model;
    try {
      await launchReview(fixture, runner);
      assert.equal(runner.calls.length, 1);
      assert.equal(ctx.model, model);
      assert.equal(selectedModels.length, 0, "review transport never calls builder setModel");
      assert.equal(latestLease().lifecycle.phase, "planning");
      assert.notEqual(runner.calls[0].request.model.provider, model.provider);
      runner.calls[0].resolve({
        status: "completed",
        verdict: validAdvice(runner.calls[0].request),
        usage: { cost: 0.01, inputTokens: 100, outputTokens: 20 },
      });
      await flushMicrotasks();
      await waitForReview(() => latestLease().lifecycle.phase === "executing");
      assert.match(sent.at(-1).message.content, /Verify rollback/);
      assert.equal(sent.at(-1).options.triggerTurn, true);
      assert.equal(selectedModels.length, 0);
      assert.equal(ctx.model, model);
    } finally {
      restoreEnvironment();
    }
  });
  for (const boundary of ["input", "off", "compact", "shutdown", "fork"]) {
    it(`cancels review and drops a late verdict after ${boundary}`, async () => {
      const runner = controlledRunner();
      const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
      const { hooks, commands, ctx, sent, latestLease, restoreEnvironment } = fixture;
      try {
        await launchReview(fixture, runner);
        const call = runner.calls[0];
        if (boundary === "input")
          await hooks.get("input")(
            { text: "Inspect instead", source: "interactive", streamingBehavior: "followUp" },
            ctx,
          );
        if (boundary === "off") await commands.get("route").handler("off", ctx);
        if (boundary === "compact") await hooks.get("session_compact")({}, ctx);
        if (boundary === "shutdown") await hooks.get("session_shutdown")({}, ctx);
        if (boundary === "fork") await hooks.get("session_before_fork")({}, ctx);
        assert.equal(call.cancelled, true);
        const count = sent.length;
        call.resolve({
          status: "completed",
          verdict: validAdvice(call.request),
          usage: { cost: 0.01, inputTokens: 1, outputTokens: 1 },
        });
        await flushMicrotasks();
        assert.equal(sent.length, count, "stale advice must not start a turn");
        assert.notEqual(latestLease()?.lifecycle.phase, "executing");
      } finally {
        restoreEnvironment();
      }
    });
  }
  it("cancels on shadow transitions but preserves a redundant active command", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    try {
      await launchReview(fixture, runner);
      await fixture.commands.get("route").handler("active", fixture.ctx);
      assert.equal(runner.calls[0].cancelled, false);
      await fixture.commands.get("route").handler("shadow", fixture.ctx);
      assert.equal(runner.calls[0].cancelled, true);
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("cancels review when a telemetry failure disables active routing", async () => {
    const runner = controlledRunner();
    let fail = false;
    const fixture = await authorizationLifecycleFixture({
      reviewRunner: runner,
      telemetry: {
        read: async () => [],
        append: async () => {
          if (fail) throw new Error("fixture telemetry failure");
        },
      },
    });
    try {
      await launchReview(fixture, runner);
      fail = true;
      fixture.hooks.get("agent_start")();
      await fixture.hooks.get("agent_end")(
        {
          messages: [
            {
              role: "assistant",
              provider: fixture.parent.selected.provider,
              model: fixture.parent.selected.modelId,
              stopReason: "stop",
              usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0.01 } },
            },
          ],
        },
        fixture.ctx,
      );
      assert.equal(runner.calls[0].cancelled, true);
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("cancels the paid reviewer before applying a different builder selection", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    try {
      await launchReview(fixture, runner);
      fixture.onBuilderSwitch(() => {
        assert.equal(runner.calls[0].cancelled, true);
      });
      await fixture.commands.get("route").handler("fail availability", fixture.ctx);
      assert.equal(runner.calls[0].cancelled, true);
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("cancels plan review before fallback telemetry so late advice cannot defeat the fallback", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    try {
      await launchReview(fixture, runner);
      const before = fixture.latestLease();
      const fallback = fixture.commands.get("route").handler("fail availability", fixture.ctx);
      // Still inside fallback's first await (its telemetry write): the obsolete review is already cancelled.
      assert.equal(runner.calls[0].cancelled, true);
      runner.calls[0].resolve({
        status: "completed",
        verdict: validAdvice(runner.calls[0].request),
        usage: { cost: 0.01, inputTokens: 1, outputTokens: 1 },
      });
      await fallback;
      await flushMicrotasks();
      const after = fixture.latestLease();
      assert.equal(after.attemptIndex, before.attemptIndex + 1, "fallback still advances the builder");
      assert.notDeepEqual(after.selected, before.selected);
      assert.equal(after.lifecycle.phase, "planning", "late advice for the failed attempt is dropped");
      assert.equal(
        fixture.sent.some((s) => s.message.customType && s.message.content?.includes("<review_advice>")),
        false,
      );
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("cancels obsolete builder reviews and schedules the same scope on a new attempt", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    // Keep the selection identical so only the changed attempt index distinguishes the new review.
    fixture.parent.fallbacks = [{ ...fixture.parent.selected }];
    try {
      await launchReview(fixture, runner);
      const first = runner.calls[0];
      await fixture.commands.get("route").handler("fail availability", fixture.ctx);
      assert.equal(first.cancelled, true);
      assert.equal(fixture.latestLease().attemptIndex, 1);
      fixture.ctx.model = fixture.models.find(
        (m) =>
          m.provider === fixture.latestLease().selected.provider && m.id === fixture.latestLease().selected.modelId,
      );
      fixture.hooks.get("agent_start")();
      await fixture.hooks.get("agent_end")(
        {
          messages: [
            {
              role: "assistant",
              provider: fixture.latestLease().selected.provider,
              model: fixture.latestLease().selected.modelId,
              stopReason: "stop",
              usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0.01 } },
            },
          ],
        },
        fixture.ctx,
      );
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      await waitForReview(() => runner.calls.length === 2);
      assert.equal(runner.calls[1].request.scopeFingerprint, first.request.scopeFingerprint);
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("transfers original requirements and retained plan despite a continuation-only latest message", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    const validation = validateActionPlan(irreversibleActionPlan());
    fixture.parent.reviewTaskContext = "Original requirement: preserve the rollback overlap window.";
    fixture.parent.lifecycle = {
      phase: "executing",
      policy: "plan_review_then_completion_review",
      taskFingerprint: "task-fingerprint",
      plan: {
        taskFingerprint: "task-fingerprint",
        planFingerprint: validation.fingerprint,
        submittedAt: "now",
        plan: validation.plan,
      },
    };
    fixture.parent.safetyEvidence.mutations = [
      { toolName: "write", inputFingerprint: "a".repeat(64), recordedAt: "before" },
    ];
    const branch = fixture.ctx.sessionManager.getBranch;
    fixture.ctx.sessionManager.getBranch = () => [
      ...branch(),
      { type: "message", message: { role: "user", content: "continue" } },
    ];
    try {
      await fixture.hooks.get("session_start")({ reason: "reload" }, fixture.ctx);
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      await waitForReview(() => runner.calls.length === 1);
      assert.match(runner.calls[0].request.prompt, /preserve the rollback overlap window/);
      assert.match(runner.calls[0].request.prompt, /untrusted_retained_plan/);
      assert.ok(runner.calls[0].request.prompt.includes(validation.plan.objective));
      assert.ok(runner.calls[0].request.prompt.length < 60_000);
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("cancels plan review and drops a late approval once the last builder rung fails", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    // Last rung: no untried fallback and no previous selection, so exhaustion keeps the same selection.
    fixture.parent.attemptIndex = fixture.parent.fallbacks.length;
    try {
      await launchReview(fixture, runner);
      const call = runner.calls[0];
      await fixture.commands.get("route").handler("fail quality", fixture.ctx);
      assert.equal(fixture.latestLease().executionFailed, true);
      assert.equal(call.cancelled, true, "a failed builder's pending review is obsolete");
      const count = fixture.sent.length;
      call.resolve({
        status: "completed",
        verdict: validAdvice(call.request),
        usage: { cost: 0.01, inputTokens: 1, outputTokens: 1 },
      });
      await flushMicrotasks();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(fixture.sent.length, count, "late approval must not queue another builder turn");
      assert.equal(fixture.latestLease().lifecycle.phase, "planning");
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("cancels a pending review on /route reset", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    try {
      await launchReview(fixture, runner);
      await fixture.commands.get("route").handler("reset", fixture.ctx);
      assert.equal(runner.calls[0].cancelled, true);
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("adds reviewer cost to the owning task's labeled cost without folding reviewer tokens", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    const builderTurn = async () => {
      fixture.hooks.get("agent_start")();
      await fixture.hooks.get("agent_end")(
        {
          messages: [
            {
              role: "assistant",
              provider: fixture.parent.selected.provider,
              model: fixture.parent.selected.modelId,
              stopReason: "stop",
              usage: { input: 10, output: 1, cacheRead: 4, cacheWrite: 0, cost: { total: 0.01 } },
            },
          ],
        },
        fixture.ctx,
      );
    };
    const labeledCosts = async () =>
      (await readFile(process.env.PI_ROUTER_TELEMETRY_PATH, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((event) => event.kind === "outcome" && typeof event.data.accepted === "boolean")
        .map((event) => event.data);
    try {
      await fixture.hooks.get("session_start")({ reason: "reload" }, fixture.ctx);
      await fixture.tools
        .get("submit_action_plan")
        .execute("plan", irreversibleActionPlan(), undefined, undefined, fixture.ctx);
      await builderTurn();
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      await waitForReview(() => runner.calls.length === 1);
      runner.calls[0].resolve({
        status: "completed",
        verdict: validAdvice(runner.calls[0].request),
        usage: { cost: 0.25, inputTokens: 1000, outputTokens: 100 },
      });
      await waitForReview(() => fixture.latestLease().lifecycle.phase === "executing");
      await fixture.commands.get("route").handler("accept", fixture.ctx);
      let labels = await labeledCosts();
      assert.ok(Math.abs(labels.at(-1).modelAndToolCost - 0.26) < 1e-9, JSON.stringify(labels.at(-1)));
      assert.equal(labels.at(-1).cacheReadTokens, 4, "reviewer tokens stay out of builder cache metrics");
      // The task total keeps the review share after a later builder attempt.
      await builderTurn();
      await fixture.commands.get("route").handler("accept", fixture.ctx);
      labels = await labeledCosts();
      assert.ok(Math.abs(labels.at(-1).modelAndToolCost - 0.27) < 1e-9, JSON.stringify(labels.at(-1)));
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("reopens a completed lifecycle when a mutation finishes after completion advice", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    fixture.parent.lifecycle = {
      phase: "executing",
      policy: "plan_review_then_completion_review",
      taskFingerprint: "task-fingerprint",
    };
    fixture.parent.safetyEvidence.mutations = [
      { toolName: "write", inputFingerprint: "a".repeat(64), recordedAt: "before" },
    ];
    try {
      await fixture.hooks.get("session_start")({ reason: "reload" }, fixture.ctx);
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      await waitForReview(() => runner.calls.length === 1);
      // A custom continuation is running (no input epoch change); its mutation starts before advice lands.
      fixture.hooks.get("tool_call")(
        { toolCallId: "late-mutation", toolName: "write", input: { path: "changed" } },
        fixture.ctx,
      );
      runner.calls[0].resolve({
        status: "completed",
        verdict: validAdvice(runner.calls[0].request),
        usage: { cost: 0.01, inputTokens: 1, outputTokens: 1 },
      });
      await waitForReview(() => fixture.latestLease().lifecycle.phase === "completed");
      fixture.hooks.get("tool_execution_end")({ toolCallId: "late-mutation", isError: false }, fixture.ctx);
      assert.equal(fixture.latestLease().lifecycle.phase, "executing", "newer work reopens completion review");
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      await waitForReview(() => runner.calls.length === 2);
      assert.notEqual(runner.calls[1].request.scopeFingerprint, runner.calls[0].request.scopeFingerprint);
      // Unchanged evidence after the reopened review is still scheduled at most once.
      runner.calls[1].resolve({
        status: "completed",
        verdict: validAdvice(runner.calls[1].request),
        usage: { cost: 0.01, inputTokens: 1, outputTokens: 1 },
      });
      await waitForReview(() => fixture.latestLease().lifecycle.phase === "completed");
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      await flushMicrotasks();
      assert.equal(runner.calls.length, 2);
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("reopens a completed lifecycle when a check fails after completion advice", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    fixture.parent.lifecycle = {
      phase: "executing",
      policy: "plan_review_then_completion_review",
      taskFingerprint: "task-fingerprint",
    };
    fixture.parent.safetyEvidence.mutations = [
      { toolName: "write", inputFingerprint: "a".repeat(64), recordedAt: "before" },
    ];
    try {
      await fixture.hooks.get("session_start")({ reason: "reload" }, fixture.ctx);
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      await waitForReview(() => runner.calls.length === 1);
      // A deterministic check starts before the completion advice lands and fails afterwards.
      fixture.hooks.get("tool_call")(
        { toolCallId: "late-check", toolName: "bash", input: { command: "npm test" } },
        fixture.ctx,
      );
      runner.calls[0].resolve({
        status: "completed",
        verdict: validAdvice(runner.calls[0].request),
        usage: { cost: 0.01, inputTokens: 1, outputTokens: 1 },
      });
      await waitForReview(() => fixture.latestLease().lifecycle.phase === "completed");
      fixture.hooks.get("tool_execution_end")({ toolCallId: "late-check", isError: true }, fixture.ctx);
      const reopened = fixture.latestLease();
      assert.equal(reopened.lifecycle.phase, "executing", "a failing check reopens completion review");
      assert.equal(reopened.lifecycle.completionReview, undefined, "earlier advice is not kept for failing evidence");
      assert.deepEqual(
        reopened.safetyEvidence.checks.map((check) => [check.command, check.passed]),
        [["npm test", false]],
      );
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("skips unavailable Pi runtimes with a human note and telemetry", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    const notes = [];
    fixture.ctx.ui.notify = (message, level) => notes.push({ message, level });
    try {
      await launchReview(fixture, runner);
      runner.calls[0].resolve({ status: "runtime_unavailable", usage: { cost: 0, inputTokens: 0, outputTokens: 0 } });
      await waitForReview(() => notes.some((n) => /runtime unavailable/.test(n.message)));
      assert.equal(
        fixture.sent.some((s) => /Independent review advice/.test(s.message.content)),
        false,
      );
      const events = (await readFile(process.env.PI_ROUTER_TELEMETRY_PATH, "utf8")).trim().split("\n").map(JSON.parse);
      assert.ok(events.some((e) => e.data.reviewStatus === "runtime_unavailable"));
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("cancels obsolete plan review on a changed resubmission and accepts a fresh attempt", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    try {
      await launchReview(fixture, runner);
      const first = runner.calls[0];
      await fixture.tools
        .get("submit_action_plan")
        .execute(
          "new-plan",
          { ...irreversibleActionPlan(), objective: "Rotate the credential with a longer overlap." },
          undefined,
          undefined,
          fixture.ctx,
        );
      assert.equal(first.cancelled, true);
      first.resolve({
        status: "completed",
        verdict: validAdvice(first.request),
        usage: { cost: 0.01, inputTokens: 1, outputTokens: 1 },
      });
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      await waitForReview(() => runner.calls.length === 2);
      assert.equal(
        fixture.sent.some((s) => /Independent review advice/.test(s.message.content)),
        false,
      );
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("never reopens a consumed review stage for unchanged scope, even after reload", async () => {
    const runner = controlledRunner();
    const first = await authorizationLifecycleFixture({ reviewRunner: runner });
    let state;
    try {
      await launchReview(first, runner);
      runner.calls[0].resolve({
        status: "completed",
        verdict: { ...validAdvice(runner.calls[0].request), verdict: "reject" },
        usage: { cost: 0.01, inputTokens: 1, outputTokens: 1 },
      });
      await waitForReview(() => first.sent.some((s) => /Independent review advice/.test(s.message.content)));
      // Consuming advice without an explicit plan resubmission cannot schedule another review.
      await first.hooks.get("agent_settled")({}, first.ctx);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(runner.calls.length, 1);
      assert.equal(first.latestLease().reviewAttemptKeys.length, 1);
      state = restoreLeaseState(
        JSON.parse(JSON.stringify(first.appended)).map((entry) => ({ type: "custom", ...entry })),
        "active",
      );
    } finally {
      first.restoreEnvironment();
    }
    const reloaded = await authorizationLifecycleFixture({ reviewRunner: runner }, state);
    try {
      await reloaded.hooks.get("session_start")({ reason: "reload" }, reloaded.ctx);
      await reloaded.hooks.get("agent_settled")({}, reloaded.ctx);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(runner.calls.length, 1, "a reloaded instance reads consumed attempts from the lease");
      // Current main intentionally permits explicit plan resubmission, even for identical plan text.
      await reloaded.tools
        .get("submit_action_plan")
        .execute("again", irreversibleActionPlan(), undefined, undefined, reloaded.ctx);
      await reloaded.hooks.get("agent_settled")({}, reloaded.ctx);
      await waitForReview(() => runner.calls.length === 2);
    } finally {
      reloaded.restoreEnvironment();
    }
  });

  it("rejects invalid runner verdicts with warnings and telemetry, never advice", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    const notes = [];
    fixture.ctx.ui.notify = (message, level) => notes.push({ message, level });
    try {
      await launchReview(fixture, runner);
      runner.calls[0].resolve({
        status: "completed",
        verdict: { ...validAdvice(runner.calls[0].request), scopeFingerprint: "b".repeat(64) },
        usage: { cost: 0.01, inputTokens: 1, outputTokens: 1 },
      });
      await waitForReview(() => notes.some((n) => /valid advice/.test(n.message)));
      // The pair is frozen: no model-ladder retry after the last mechanism.
      assert.equal(runner.calls.length, 1);
      assert.equal(
        fixture.sent.some((s) => /Independent review advice/.test(s.message.content)),
        false,
      );
      assert.ok(notes.some((n) => n.level === "warning" && /valid advice/.test(n.message)));
      const events = (await readFile(process.env.PI_ROUTER_TELEMETRY_PATH, "utf8")).trim().split("\n").map(JSON.parse);
      assert.ok(events.some((e) => e.data.reviewRunner === "in_process" && e.data.verdictValid === false));
    } finally {
      fixture.restoreEnvironment();
    }
  });

  /** Released tintinweb protocol-2 shapes: microtask replies and `buildEventData` terminal payloads. */
  function signalingManager(bus, { terminal = "completed", spawn = "accept" } = {}) {
    const seen = { spawns: [], consumed: [] };
    const reply = (method, raw, value) => bus.emit(`subagents:rpc:${method}:reply:${raw.requestId}`, value);
    bus.on("subagents:rpc:ping", async (raw) => {
      await undefined;
      reply("ping", raw, { success: true, data: { version: 2 } });
    });
    bus.on("subagents:rpc:consume", async (raw) => {
      seen.consumed.push(raw.agentId);
      await undefined;
      reply("consume", raw, { success: true });
    });
    bus.on("subagents:rpc:spawn", async (raw) => {
      seen.spawns.push(raw);
      await undefined;
      if (spawn === "malformed") return reply("spawn", raw, { success: true });
      reply("spawn", raw, { success: true, data: { id: "tw-1" } });
      const nonce = /nonce="([a-f0-9]{32})"/.exec(raw.prompt)?.[1];
      const scopeFingerprint = /scopeFingerprint "([a-f0-9]{64})"/.exec(raw.prompt)?.[1];
      const advice = {
        reviewKind: "plan",
        scopeFingerprint,
        verdict: "approve",
        summary: "Signaled advice",
        evidence: ["Read the plan"],
        findings: ["Signaled finding"],
      };
      const completed = terminal === "completed";
      queueMicrotask(() =>
        bus.emit(completed ? "subagents:completed" : "subagents:failed", {
          id: "tw-1",
          type: "general-purpose",
          description: raw.options.description,
          status: completed ? "completed" : "error",
          result: completed ? `<router-result nonce="${nonce}">${JSON.stringify(advice)}</router-result>` : "",
          ...(completed ? {} : { error: "provider failed" }),
        }),
      );
    });
    return seen;
  }
  const childClassifier =
    (prompts, overrides = {}) =>
    async ({ prompt }) => {
      prompts.push(prompt);
      return primaryClassificationResult({ confidence: 0.9, ...overrides });
    };

  it("delegates first to shared signaling with a parent-selected pair and leaves the builder untouched", async () => {
    const events = createEventBus();
    const seen = signalingManager(events);
    const runner = controlledRunner();
    const prompts = [];
    const fixture = await authorizationLifecycleFixture({
      events,
      reviewRunner: runner,
      classifyPrimaryTask: childClassifier(prompts),
    });
    const model = fixture.ctx.model;
    try {
      await launchReview(fixture);
      await waitForReview(() => fixture.sent.some((s) => /Signaled finding/.test(s.message.content)));
      assert.equal(runner.calls.length, 0, "the SDK fallback is unused when signaling succeeds");
      assert.match(prompts[0], /Give plan review advice/, "the actual child task was classified");
      const recorded = (await readFile(process.env.PI_ROUTER_TELEMETRY_PATH, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.ok(
        recorded.some((e) => e.kind === "classifier_invocation" && e.data.purpose === "review_child"),
        "child selection is counted as its own classifier purpose",
      );
      const [spawn] = seen.spawns;
      assert.equal(spawn.type, "general-purpose");
      assert.equal(spawn.options.isolated, true);
      assert.equal(spawn.options.inheritContext, false);
      assert.doesNotMatch(spawn.options.model, /^openai-codex\//, "the reviewer is not the builder's vendor");
      assert.ok(spawn.options.thinkingLevel);
      assert.deepEqual(seen.consumed, ["tw-1"]);
      assert.equal(fixture.selectedModels.length, 0, "no builder setModel");
      assert.equal(fixture.ctx.model, model);
      // The advice-triggered continuation settles again; the consumed slot cannot spawn a rereview.
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(seen.spawns.length, 1);
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("falls forward to the SDK with the same frozen pair after a confirmed signaling failure", async () => {
    const events = createEventBus();
    const seen = signalingManager(events, { terminal: "failed" });
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({
      events,
      reviewRunner: runner,
      classifyPrimaryTask: childClassifier([]),
    });
    try {
      await launchReview(fixture, runner);
      const { request } = runner.calls[0];
      assert.equal(`${request.model.provider}/${request.model.id}`, seen.spawns[0].options.model);
      assert.equal(request.effort, seen.spawns[0].options.thinkingLevel);
      assert.ok(request.timeoutMs <= 4 * 60 * 60_000, "fallback shares the remaining logical deadline");
      assert.deepEqual(seen.consumed, ["tw-1"]);
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("does not start SDK fallback until the failed signaling child's stop has completed", async () => {
    const events = createEventBus();
    const stopping = deferred();
    let stopCalls = 0;
    const close = registerSignaling(events, /** @type {any} */ ({}), async () => ({
      id: "cleanup-pending",
      waitForIdle: async () => true,
      refresh: async () => {},
      stop: () => {
        stopCalls++;
        return stopping.promise;
      },
      snapshot: () => ({ state: "failed", error: "model failed", transcriptTail: "PRIVATE" }),
    }));
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({
      events,
      reviewRunner: runner,
      classifyPrimaryTask: childClassifier([]),
    });
    try {
      await launchReview(fixture);
      await waitForReview(() => stopCalls === 1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(runner.calls.length, 0, "the SDK cannot overlap a signaling child awaiting cleanup");
      stopping.resolve();
      await waitForReview(() => runner.calls.length === 1);
      assert.equal(stopCalls, 1);
      runner.calls[0].resolve({ status: "failed", usage: { cost: 1, inputTokens: 1, outputTokens: 1 } });
    } finally {
      stopping.resolve();
      await close();
      fixture.restoreEnvironment();
    }
  });

  it("never launches a replacement when signaling acceptance is uncertain", async () => {
    const events = createEventBus();
    const seen = signalingManager(events, { spawn: "malformed" });
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({
      events,
      reviewRunner: runner,
      classifyPrimaryTask: childClassifier([]),
    });
    const notes = [];
    fixture.ctx.ui.notify = (message, level) => notes.push({ message, level });
    try {
      await launchReview(fixture);
      await waitForReview(() => notes.some((n) => /ownership is uncertain/.test(n.message)));
      assert.equal(runner.calls.length, 0);
      assert.equal(seen.spawns.length, 1);
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("accounts for billed usage after malformed signaling acceptance without delivering advice or falling back", async () => {
    const events = createEventBus();
    const seen = signalingManager(events, { spawn: "malformed" });
    events.on("subagents:rpc:spawn", (raw) => {
      raw.options.signal.addEventListener(
        "abort",
        () => {
          setTimeout(
            () =>
              events.emit("subagents:completed", {
                id: "tw-1",
                description: raw.options.description,
                result: "unaccepted advice",
                usage: { input: 10, output: 5, cacheRead: 2, cost: { total: 0.03 } },
              }),
            10,
          );
        },
        { once: true },
      );
    });
    const runner = controlledRunner();
    const telemetry = [];
    const fixture = await authorizationLifecycleFixture({
      events,
      reviewRunner: runner,
      classifyPrimaryTask: childClassifier([]),
      telemetry: { read: async () => [], append: async (event) => telemetry.push(event) },
    });
    try {
      await launchReview(fixture);
      await waitForReview(() => telemetry.some((event) => event.data.reviewStatus === "uncertain"));
      const outcome = telemetry.find((event) => event.data.reviewStatus === "uncertain");
      assert.equal(outcome.data.reviewCost, 0.03);
      assert.equal(outcome.data.inputTokens, 12);
      assert.equal(outcome.data.outputTokens, 5);
      assert.equal(outcome.data.verdictValid, false);
      assert.equal(runner.calls.length, 0, "uncertain ownership prohibits SDK fallback");
      assert.equal(seen.spawns.length, 1);
      assert.deepEqual(seen.consumed, ["tw-1"]);
      assert.equal(
        fixture.sent.some((s) => /Independent review advice/.test(s.message.content)),
        false,
      );
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("launches nothing when the review is cancelled during parent-side child selection", async () => {
    const events = createEventBus();
    const seen = signalingManager(events);
    const runner = controlledRunner();
    const gate = deferred();
    let classifying = false;
    let classifierSignal;
    const fixture = await authorizationLifecycleFixture({
      events,
      reviewRunner: runner,
      classifyPrimaryTask: async ({ signal }) => {
        classifying = true;
        classifierSignal = signal;
        await gate.promise;
        return primaryClassificationResult({ confidence: 0.9 });
      },
    });
    try {
      await launchReview(fixture);
      await waitForReview(() => classifying);
      await fixture.commands.get("route").handler("off", fixture.ctx);
      assert.equal(classifierSignal.aborted, true, "cancellation aborts the selection classifier");
      gate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(seen.spawns.length, 0);
      assert.equal(runner.calls.length, 0);
    } finally {
      fixture.restoreEnvironment();
    }
    // No child launched, so restoring the same plan does not retain a consumed attempt.
    assert.deepEqual(fixture.latestLease().reviewAttemptKeys ?? [], []);
    const state = restoreLeaseState(
      JSON.parse(JSON.stringify(fixture.appended)).map((entry) => ({ type: "custom", ...entry })),
      "active",
    );
    state.mode = "active";
    const reloaded = await authorizationLifecycleFixture(
      {
        reviewRunner: runner,
        classifyPrimaryTask: childClassifier([]),
      },
      state,
    );
    try {
      await reloaded.hooks.get("session_start")({ reason: "reload" }, reloaded.ctx);
      await reloaded.hooks.get("agent_settled")({}, reloaded.ctx);
      await waitForReview(() => runner.calls.length === 1);
    } finally {
      reloaded.restoreEnvironment();
    }
  });

  /** Released tintinweb `Agent` subset with its published isolation documentation. */
  const agentTool = () => ({
    name: "Agent",
    description: "Launch a new agent to handle complex, multi-step tasks autonomously.",
    exposure: "direct",
    sourceInfo: { path: "/ext/pi-subagents/index.ts", source: "npm", scope: "user", origin: "package" },
    parameters: Type.Object({
      prompt: Type.String(),
      description: Type.String(),
      subagent_type: Type.String(),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(Type.String()),
      run_in_background: Type.Optional(Type.Boolean()),
      isolated: Type.Optional(
        Type.Boolean({ description: "If true, agent gets no extension/MCP tools \u2014 only built-in tools." }),
      ),
    }),
  });
  const agentDiscovery = async () => ({
    match: true,
    spawnTool: "Agent",
    spawnArguments: [
      { path: "prompt", bind: "task" },
      { path: "description", literal: '"router review"' },
      { path: "subagent_type", literal: '"general-purpose"' },
      { path: "model", bind: "model" },
      { path: "thinking", bind: "effort" },
      { path: "run_in_background", literal: "false" },
      { path: "isolated", literal: "true" },
    ],
    isolationArgument: "isolated",
    isolationEvidence: "If true, agent gets no extension/MCP tools",
  });

  it("falls forward to a builder-steered discovered tool and observes its result without rewriting it", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({
      reviewRunner: runner,
      classifyPrimaryTask: childClassifier([]),
      allTools: () => [agentTool()],
      activeExtra: ["Agent"],
      discoverDelegate: agentDiscovery,
    });
    const model = fixture.ctx.model;
    try {
      await launchReview(fixture);
      await waitForReview(() => fixture.sent.some((s) => s.message.customType === "router-review-delegation"));
      const dispatched = fixture.sent.find((s) => s.message.customType === "router-review-delegation");
      assert.deepEqual(dispatched.options, { triggerTurn: true, deliverAs: "followUp" });
      const args = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(dispatched.message.content)[1]);
      assert.equal(args.isolated, true);
      assert.match(args.model, /^(anthropic|google-vertex)\//, "the parent-selected reviewer, not the builder");
      const nonce = /nonce="([a-f0-9]{32})"/.exec(args.prompt)[1];
      const scopeFingerprint = /scopeFingerprint "([a-f0-9]{64})"/.exec(args.prompt)[1];
      fixture.hooks.get("tool_call")({ toolCallId: "agent-call", toolName: "Agent", input: args }, fixture.ctx);
      // The delegation run's own end never drives builder repair/fallback, even on a length stop.
      await fixture.hooks.get("agent_end")(
        {
          messages: [
            {
              role: "assistant",
              provider: "openai-codex",
              model: "gpt-6-sol",
              stopReason: "length",
              content: [],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
            },
          ],
        },
        fixture.ctx,
      );
      assert.equal(fixture.selectedModels.length, 0, "no builder fallback switch during delegation");
      const advice = {
        reviewKind: "plan",
        scopeFingerprint,
        verdict: "approve",
        summary: "Builder-steered advice",
        evidence: ["Read the plan"],
        findings: ["Steered finding"],
      };
      const event = {
        toolCallId: "agent-call",
        toolName: "Agent",
        input: args,
        content: [
          {
            type: "text",
            text: `Agent done\n<router-result nonce="${nonce}">${JSON.stringify(advice)}</router-result>`,
          },
        ],
        isError: false,
      };
      const before = structuredClone(event);
      assert.equal(await fixture.hooks.get("tool_result")(event, fixture.ctx), undefined);
      assert.deepEqual(event, before, "the third-party tool result is never modified");
      // The delegation run settles; only then is the provisional verdict accepted.
      await fixture.hooks.get("agent_settled")({ aborted: false }, fixture.ctx);
      await waitForReview(() => fixture.sent.some((s) => /Steered finding/.test(s.message.content)));
      assert.equal(runner.calls.length, 0, "the SDK fallback is unused");
      assert.equal(fixture.selectedModels.length, 0);
      assert.equal(fixture.ctx.model, model);
    } finally {
      fixture.restoreEnvironment();
    }
  });

  for (const kind of ["plan", "completion"]) {
    it(`keeps exact builder ${kind} review orchestration out of mutation evidence through native tool events`, async () => {
      const runner = controlledRunner();
      const fixture = await authorizationLifecycleFixture({
        reviewRunner: runner,
        allTools: () => [agentTool()],
        activeExtra: ["Agent"],
        discoverDelegate: agentDiscovery,
      });
      if (kind === "completion") {
        fixture.parent.lifecycle = {
          phase: "executing",
          policy: "plan_review_then_completion_review",
          taskFingerprint: "task-fingerprint",
        };
        fixture.parent.safetyEvidence.mutations = [
          { toolName: "write", inputFingerprint: "a".repeat(64), recordedAt: "before" },
        ];
      }
      try {
        if (kind === "plan") await launchReview(fixture);
        else {
          await fixture.hooks.get("session_start")({ reason: "reload" }, fixture.ctx);
          await fixture.hooks.get("agent_settled")({}, fixture.ctx);
        }
        await waitForReview(() => fixture.sent.some((s) => s.message.customType === "router-review-delegation"));
        const dispatch = fixture.sent.find((s) => s.message.customType === "router-review-delegation").message;
        const input = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(dispatch.content)[1]);
        const nonce = /nonce="([a-f0-9]{32})"/.exec(input.prompt)[1];
        const scopeFingerprint = /scopeFingerprint "([a-f0-9]{64})"/.exec(input.prompt)[1];
        const evidence = fixture.latestLease().safetyEvidence;
        await fixture.hooks.get("before_agent_start")(
          { messageType: "custom", message: dispatch, systemPrompt: "system" },
          fixture.ctx,
        );
        fixture.hooks.get("agent_start")({}, fixture.ctx);
        fixture.hooks.get("tool_execution_start")(
          { toolCallId: "review", toolName: "Agent", args: input },
          fixture.ctx,
        );
        fixture.hooks.get("tool_call")({ toolCallId: "review", toolName: "Agent", input }, fixture.ctx);
        const result = {
          toolCallId: "review",
          toolName: "Agent",
          input,
          isError: false,
          content: [
            {
              type: "text",
              text: `<router-result nonce="${nonce}">${JSON.stringify({ reviewKind: kind, scopeFingerprint, verdict: kind === "plan" ? "approve" : "pass", summary: "Native pipeline advice", evidence: ["Inspected scope"], findings: ["Pipeline finding"] })}</router-result>`,
            },
          ],
        };
        const original = structuredClone(result);
        assert.equal(await fixture.hooks.get("tool_result")(result, fixture.ctx), undefined);
        assert.deepEqual(result, original);
        fixture.hooks.get("tool_execution_end")(
          { toolCallId: "review", toolName: "Agent", result, isError: false },
          fixture.ctx,
        );
        assert.equal(
          fixture.latestLease().safetyEvidence,
          evidence,
          "orchestration never replaces reviewed implementation evidence",
        );
        await fixture.hooks.get("agent_end")({ messages: [] }, fixture.ctx);
        await fixture.hooks.get("agent_settled")({ aborted: false }, fixture.ctx);
        await waitForReview(() => fixture.sent.some((s) => /Pipeline finding/.test(s.message.content)));
        assert.equal(fixture.latestLease().lifecycle.phase, kind === "plan" ? "executing" : "completed");
        assert.equal(runner.calls.length, 0);
      } finally {
        await fixture.hooks.get("session_shutdown")({ reason: "quit" }, fixture.ctx);
        fixture.restoreEnvironment();
      }
    });
  }

  it("keeps changed execution arguments and unrelated calls as completion mutation evidence", async () => {
    for (const deviation of ["changed_arguments", "unrelated"]) {
      const runner = controlledRunner();
      const fixture = await authorizationLifecycleFixture({
        reviewRunner: runner,
        allTools: () => [agentTool()],
        activeExtra: ["Agent"],
        discoverDelegate: agentDiscovery,
      });
      fixture.parent.lifecycle = {
        phase: "executing",
        policy: "plan_review_then_completion_review",
        taskFingerprint: "task-fingerprint",
      };
      fixture.parent.safetyEvidence.mutations = [
        { toolName: "write", inputFingerprint: "a".repeat(64), recordedAt: "before" },
      ];
      try {
        await fixture.hooks.get("session_start")({ reason: "reload" }, fixture.ctx);
        await fixture.hooks.get("agent_settled")({}, fixture.ctx);
        await waitForReview(() => fixture.sent.some((s) => s.message.customType === "router-review-delegation"));
        const content = fixture.sent.find((s) => s.message.customType === "router-review-delegation").message.content;
        const input = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(content)[1]);
        const event = {
          toolCallId: "mutation",
          toolName: deviation === "unrelated" ? "write" : "Agent",
          input: deviation === "unrelated" ? { path: "changed", content: "x" } : input,
        };
        fixture.hooks.get("agent_start")({}, fixture.ctx);
        fixture.hooks.get("tool_execution_start")(
          { toolCallId: event.toolCallId, toolName: event.toolName, args: event.input },
          fixture.ctx,
        );
        fixture.hooks.get("tool_call")(event, fixture.ctx);
        // A later extension mutates the initially exact arguments before execution.
        if (deviation === "changed_arguments") event.input.isolated = false;
        const result = { ...event, content: [{ type: "text", text: "done" }], isError: false };
        await fixture.hooks.get("tool_result")(result, fixture.ctx);
        fixture.hooks.get("tool_execution_end")(
          { toolCallId: event.toolCallId, toolName: event.toolName, result, isError: false },
          fixture.ctx,
        );
        assert.equal(fixture.latestLease().safetyEvidence.mutations.length, 2, deviation);
        await fixture.hooks.get("agent_end")({ messages: [] }, fixture.ctx);
        await fixture.hooks.get("agent_settled")({ aborted: false }, fixture.ctx);
        await flushMicrotasks();
        assert.equal(
          fixture.sent.some((s) => /Independent review advice/.test(s.message.content)),
          false,
        );
        assert.equal(runner.calls.length, 0, "a deviated child never authorizes overlapping fallback");
      } finally {
        await fixture.hooks.get("session_shutdown")({ reason: "quit" }, fixture.ctx);
        fixture.restoreEnvironment();
      }
    }
  });

  it("never starts SDK fallback after an off-plan call, including after a failed planned spawn", async () => {
    for (const failedSpawn of [false, true]) {
      const runner = controlledRunner();
      const fixture = await authorizationLifecycleFixture({
        reviewRunner: runner,
        classifyPrimaryTask: childClassifier([]),
        allTools: () => [agentTool()],
        activeExtra: ["Agent"],
        discoverDelegate: agentDiscovery,
      });
      const notes = [];
      fixture.ctx.ui.notify = (message) => notes.push(message);
      try {
        const foreign = { toolCallId: "foreign", toolName: "another_agent_tool", input: { action: "create" } };
        const original = structuredClone(foreign);
        assert.equal(fixture.hooks.get("tool_call")(foreign, fixture.ctx), undefined, "ordinary calls stay allowed");
        await launchReview(fixture);
        await waitForReview(() => fixture.sent.some((s) => s.message.customType === "router-review-delegation"));
        if (failedSpawn) {
          const content = fixture.sent.find((s) => s.message.customType === "router-review-delegation").message.content;
          const input = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(content)[1]);
          fixture.hooks.get("tool_call")({ toolCallId: "planned", toolName: "Agent", input }, fixture.ctx);
          await fixture.hooks.get("tool_result")(
            {
              toolCallId: "planned",
              toolName: "Agent",
              input,
              content: [{ type: "text", text: "Unknown parameter: isolated" }],
              isError: true,
            },
            fixture.ctx,
          );
        }
        assert.equal(fixture.hooks.get("tool_call")(foreign, fixture.ctx), undefined, "observation never blocks");
        assert.deepEqual(foreign, original);
        await fixture.hooks.get("agent_settled")({ aborted: false }, fixture.ctx);
        await waitForReview(() => notes.some((note) => /ownership is uncertain/.test(note)));
        assert.equal(runner.calls.length, 0, "the unverified child must not overlap an SDK reviewer");
        assert.equal(fixture.selectedModels.length, 0);
      } finally {
        fixture.restoreEnvironment();
      }
    }
  });

  it("defers the entire replacement review ladder while cancelled builder accounting drains", async () => {
    const runner = controlledRunner();
    const prompts = [];
    const fixture = await authorizationLifecycleFixture({
      reviewRunner: runner,
      classifyPrimaryTask: childClassifier(prompts),
      allTools: () => [agentTool()],
      activeExtra: ["Agent"],
      discoverDelegate: agentDiscovery,
    });
    const dispatches = () => fixture.sent.filter((s) => s.message.customType === "router-review-delegation");
    try {
      await launchReview(fixture);
      await waitForReview(() => dispatches().length === 1);
      const changedPlan = { ...irreversibleActionPlan(), objective: "Rotate a different credential safely." };
      await fixture.tools
        .get("submit_action_plan")
        .execute("changed-plan", changedPlan, undefined, undefined, fixture.ctx);
      // This settles the old run, but its cancelled attempt still owns the bounded accounting drain.
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(prompts.length, 1, "replacement selection must wait for builder ownership to end");
      assert.equal(runner.calls.length, 0, "a busy builder must never fall forward to the SDK");
      assert.equal(dispatches().length, 1);
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      await waitForReview(() => dispatches().length === 2);
      assert.equal(prompts.length, 2, "a deferred scope remains eligible after ownership ends");
      assert.equal(runner.calls.length, 0);
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("charges reported builder tool usage before budgeting SDK fallback", async () => {
    for (const cost of [0.4, 1.25]) {
      const runner = controlledRunner();
      const events = [];
      const fixture = await authorizationLifecycleFixture({
        reviewRunner: runner,
        allTools: () => [agentTool()],
        activeExtra: ["Agent"],
        discoverDelegate: agentDiscovery,
        telemetry: { read: async () => [], append: async (event) => events.push(event) },
      });
      try {
        await launchReview(fixture);
        await waitForReview(() => fixture.sent.some((s) => s.message.customType === "router-review-delegation"));
        const content = fixture.sent.find((s) => s.message.customType === "router-review-delegation").message.content;
        const input = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(content)[1]);
        fixture.hooks.get("agent_start")({}, fixture.ctx);
        fixture.hooks.get("tool_execution_start")(
          { toolCallId: "failed-review", toolName: "Agent", args: input },
          fixture.ctx,
        );
        fixture.hooks.get("tool_call")({ toolCallId: "failed-review", toolName: "Agent", input }, fixture.ctx);
        const result = {
          toolCallId: "failed-review",
          toolName: "Agent",
          input,
          content: [{ type: "text", text: "Unknown parameter: isolated" }],
          isError: true,
          usage: {
            input: 100,
            output: 20,
            cacheRead: 30,
            cacheWrite: 10,
            totalTokens: 160,
            cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
          },
        };
        await fixture.hooks.get("tool_result")(result, fixture.ctx);
        fixture.hooks.get("tool_execution_end")(
          { toolCallId: "failed-review", toolName: "Agent", result, isError: true },
          fixture.ctx,
        );
        await fixture.hooks.get("agent_end")({ messages: [] }, fixture.ctx);
        await fixture.hooks.get("agent_settled")({ aborted: false }, fixture.ctx);
        await waitForReview(() => events.some((e) => e.data.reviewRunner === "builder"));
        const outcome = events.find((e) => e.data.reviewRunner === "builder").data;
        assert.equal(outcome.reviewCost, cost);
        assert.equal(outcome.inputTokens, 140);
        assert.equal(outcome.outputTokens, 20);
        if (cost < 1) {
          await waitForReview(() => runner.calls.length === 1);
          assert.equal(runner.calls[0].request.maxCost, 1 - cost);
        } else {
          await flushMicrotasks();
          assert.equal(runner.calls.length, 0, "reported spend exhausts the budget before any SDK launch");
        }
      } finally {
        await fixture.hooks.get("session_shutdown")({ reason: "quit" }, fixture.ctx);
        fixture.restoreEnvironment();
      }
    }
  });

  it("still reaches the SDK when tool inventory access throws", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({
      reviewRunner: runner,
      classifyPrimaryTask: childClassifier([]),
      allTools: () => {
        throw new Error("inventory unavailable");
      },
    });
    try {
      await launchReview(fixture, runner);
      assert.equal(runner.calls.length, 1);
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("uses the SDK when no discovery publication exists yet, without waiting for discovery", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({
      reviewRunner: runner,
      classifyPrimaryTask: childClassifier([]),
      allTools: () => [agentTool()],
      activeExtra: ["Agent"],
      discoverDelegate: () => new Promise(() => {}),
    });
    try {
      await launchReview(fixture, runner);
      assert.equal(
        fixture.sent.some((s) => s.message.customType === "router-review-delegation"),
        false,
      );
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("records an unroutable child selection as a selection outcome, not a runner failure", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({
      reviewRunner: runner,
      classifyPrimaryTask: childClassifier([]),
    });
    fixture.models.splice(1);
    const notes = [];
    fixture.ctx.ui.notify = (message) => notes.push(message);
    try {
      await launchReview(fixture);
      await waitForReview(() => notes.some((note) => /could not start/.test(note)));
      // The note precedes the awaited telemetry write; poll until the outcome is on disk.
      let failed;
      for (let i = 0; i < 200 && !failed; i++) {
        const text = await readFile(process.env.PI_ROUTER_TELEMETRY_PATH, "utf8").catch(() => "");
        failed = text
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse)
          .find((e) => e.kind === "outcome" && e.data.reviewStatus === "unroutable");
        if (!failed) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(failed.data.reviewStage, "selection");
      assert.equal(failed.data.reviewRunner, undefined);
      assert.equal(runner.calls.length, 0);
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("lets the child task, not the builder profile, determine the reviewer pair", async () => {
    const pairs = [];
    for (const expectedToolOutputTokens of [1_000, 400_000]) {
      const runner = controlledRunner();
      const fixture = await authorizationLifecycleFixture({
        reviewRunner: runner,
        classifyPrimaryTask: childClassifier([], { expectedToolOutputTokens }),
      });
      // Same builder and registry for both tasks: a smaller-window reviewer and a larger-window rung.
      const opus = fixture.models.find((entry) => entry.id === "claude-opus-5-5");
      fixture.models.push({
        ...opus,
        id: "claude-fable-5",
        name: "claude-fable-5",
        thinkingLevelMap: { xhigh: "xhigh" },
      });
      opus.contextWindow = 400_000;
      try {
        await launchReview(fixture, runner);
        const { request } = runner.calls[0];
        pairs.push(`${request.model.provider}/${request.model.id}@${request.effort}`);
        assert.equal(fixture.selectedModels.length, 0);
        assert.equal(fixture.latestLease().selected.modelId, "gpt-6-sol");
      } finally {
        fixture.restoreEnvironment();
      }
    }
    assert.deepEqual(pairs, ["anthropic/claude-opus-5-5@high", "anthropic/claude-fable-5@xhigh"]);
  });

  it("notes a missing advisory action plan once per lease without a model reminder", async () => {
    const { hooks, ctx, sent, latestLease, restoreEnvironment } = await authorizationLifecycleFixture();
    const notes = [];
    ctx.ui.notify = (message, level) => notes.push({ message, level });
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      for (let i = 0; i < 2; i++) {
        await hooks.get("tool_call")(
          { toolName: "write", input: { path: "x", content: "x" }, toolCallId: "mutation" },
          ctx,
        );
        await hooks.get("tool_execution_end")({ toolCallId: "mutation", isError: false }, ctx);
        await hooks.get("agent_settled")({}, ctx);
      }
      const events = (await readFile(process.env.PI_ROUTER_TELEMETRY_PATH, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(events.filter((e) => e.kind === "advisory_step_skipped" && e.data.step === "action_plan").length, 1);
      assert.equal(notes.filter((n) => n.level === "warning" && /Possible mutation/.test(n.message)).length, 1);
      assert.deepEqual(latestLease().advisoryStepsNoted, ["action_plan"]);
      assert.equal(
        sent.some((s) => s.message.details?.repairReason === "missing_action_plan"),
        false,
      );
    } finally {
      restoreEnvironment();
    }
  });

  it("notes possible mutations while out-of-band plan review is pending once per lease", async () => {
    const fixture = await authorizationLifecycleFixture({ reviewRunner: controlledRunner() });
    try {
      await launchReview(fixture);
      for (let i = 0; i < 2; i++) {
        fixture.hooks.get("tool_call")({ toolCallId: "mut", toolName: "write", input: { path: "x" } }, fixture.ctx);
        fixture.hooks.get("tool_execution_end")({ toolCallId: "mut", isError: false }, fixture.ctx);
      }
      await flushMicrotasks();
      assert.deepEqual(fixture.latestLease().advisoryStepsNoted, ["plan_review_wait"]);
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("notes a mutation between plan submission and settlement once per lease", async () => {
    const { hooks, tools, ctx, latestLease, restoreEnvironment } = await authorizationLifecycleFixture();
    const notes = [];
    ctx.ui.notify = (message, level) => notes.push({ message, level });
    const pendingNotes = () => notes.filter((n) => n.level === "warning" && /advice was pending/.test(n.message));
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      await tools.get("submit_action_plan").execute("plan", irreversibleActionPlan(), undefined, undefined, ctx);
      assert.equal(latestLease().lifecycle.phase, "planning");
      assert.ok(latestLease().lifecycle.plan);
      for (let i = 0; i < 2; i++) {
        await hooks.get("tool_call")(
          { toolName: "write", input: { path: "x", content: "x" }, toolCallId: `mutation-${i}` },
          ctx,
        );
        await hooks.get("tool_execution_end")({ toolCallId: `mutation-${i}`, isError: false }, ctx);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(pendingNotes().length, 1);
      await hooks.get("agent_settled")({}, ctx);
      await flushMicrotasks();
      // The plan review now runs out of band while the builder lease stays in planning.
      assert.equal(latestLease().lifecycle.phase, "planning");
      assert.equal(pendingNotes().length, 1);
      const events = (await readFile(process.env.PI_ROUTER_TELEMETRY_PATH, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(
        events.filter((e) => e.kind === "advisory_step_skipped" && e.data.step === "plan_review_wait").length,
        1,
      );
      assert.deepEqual(latestLease().advisoryStepsNoted, ["plan_review_wait"]);
    } finally {
      restoreEnvironment();
    }
  });

  it("does not queue a resubmission turn when every reviewer is unavailable", async () => {
    const attempts = [];
    const reviewRunner = {
      start: (request) => {
        attempts.push(request);
        return {
          result: Promise.resolve({ status: "failed", usage: { cost: 0, inputTokens: 0, outputTokens: 0 } }),
          cancel() {},
        };
      },
    };
    const { hooks, tools, ctx, sent, latestLease, restoreEnvironment } = await authorizationLifecycleFixture({
      reviewRunner,
    });
    const notes = [];
    ctx.ui.notify = (message, level) => notes.push({ message, level });
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      await tools.get("submit_action_plan").execute("plan", irreversibleActionPlan(), undefined, undefined, ctx);
      await hooks.get("agent_settled")({}, ctx);
      // Wait until every reviewer attempt has failed and no further attempt starts.
      const failures = () => notes.filter((n) => /did not return valid advice/.test(n.message)).length;
      for (let stable = 0, i = 0; i < 400 && stable < 5; i++) {
        const before = attempts.length;
        await new Promise((resolve) => setTimeout(resolve, 5));
        stable = attempts.length === before && attempts.length > 0 && failures() === attempts.length ? stable + 1 : 0;
      }
      await flushMicrotasks();
      assert.ok(attempts.length >= 1);
      assert.equal(latestLease().lifecycle.phase, "planning");
      assert.equal(
        sent.some((s) => s.options?.triggerTurn || s.message.content?.includes("resubmitting")),
        false,
      );
      // The plan's review already ran, so later mutations are not noted as waiting for it.
      await hooks.get("tool_call")({ toolName: "write", input: { path: "x", content: "x" }, toolCallId: "late" }, ctx);
      await hooks.get("tool_execution_end")({ toolCallId: "late", isError: false }, ctx);
      await flushMicrotasks();
      assert.equal(latestLease().advisoryStepsNoted?.includes("plan_review_wait") ?? false, false);
    } finally {
      restoreEnvironment();
    }
  });

  it("notes a mutation awaiting the fallback attempt's plan review after an exhausted one", async () => {
    const attempts = [];
    const reviewRunner = {
      start: (request) => {
        attempts.push(request);
        return {
          result: Promise.resolve({ status: "failed", usage: { cost: 0, inputTokens: 0, outputTokens: 0 } }),
          cancel() {},
        };
      },
    };
    const fixture = await authorizationLifecycleFixture({ reviewRunner });
    const { hooks, tools, ctx, commands, latestLease, restoreEnvironment } = fixture;
    const notes = [];
    ctx.ui.notify = (message, level) => notes.push({ message, level });
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      await tools.get("submit_action_plan").execute("plan", irreversibleActionPlan(), undefined, undefined, ctx);
      await hooks.get("agent_settled")({}, ctx);
      const failures = () => notes.filter((n) => /did not return valid advice/.test(n.message)).length;
      for (let stable = 0, i = 0; i < 400 && stable < 5; i++) {
        const before = attempts.length;
        await new Promise((resolve) => setTimeout(resolve, 5));
        stable = attempts.length === before && attempts.length > 0 && failures() === attempts.length ? stable + 1 : 0;
      }
      await flushMicrotasks();
      const exhaustedAttempt = latestLease().attemptIndex;
      // The builder falls back; the new attempt's plan review has not run yet.
      await commands.get("route").handler("fail availability", ctx);
      assert.equal(latestLease().attemptIndex, exhaustedAttempt + 1);
      assert.equal(latestLease().lifecycle.phase, "planning");
      await hooks.get("tool_call")({ toolName: "write", input: { path: "x", content: "x" }, toolCallId: "early" }, ctx);
      await hooks.get("tool_execution_end")({ toolCallId: "early", isError: false }, ctx);
      await flushMicrotasks();
      assert.equal(
        latestLease().advisoryStepsNoted?.includes("plan_review_wait"),
        true,
        "an earlier attempt's exhausted review does not hide the new attempt's pending one",
      );
    } finally {
      restoreEnvironment();
    }
  });

  it("still reviews completed work after the plan review is exhausted", async () => {
    const attempts = [];
    const reviewRunner = {
      start: (request) => {
        attempts.push(request);
        return {
          result: Promise.resolve({ status: "failed", usage: { cost: 0, inputTokens: 0, outputTokens: 0 } }),
          cancel() {},
        };
      },
    };
    const { hooks, tools, ctx, sent, latestLease, restoreEnvironment } = await authorizationLifecycleFixture({
      reviewRunner,
    });
    const notes = [];
    ctx.ui.notify = (message, level) => notes.push({ message, level });
    const settledAttempts = async () => {
      const failures = () => notes.filter((n) => /did not return valid advice/.test(n.message)).length;
      for (let stable = 0, i = 0; i < 400 && stable < 5; i++) {
        const before = attempts.length;
        await new Promise((resolve) => setTimeout(resolve, 5));
        stable = attempts.length === before && attempts.length > 0 && failures() === attempts.length ? stable + 1 : 0;
      }
      await flushMicrotasks();
    };
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      await tools.get("submit_action_plan").execute("plan", irreversibleActionPlan(), undefined, undefined, ctx);
      await hooks.get("agent_settled")({}, ctx);
      await settledAttempts();
      const planAttempts = attempts.length;
      assert.ok(planAttempts >= 1);
      assert.ok(attempts.every((request) => request.kind === "plan"));
      assert.equal(latestLease().lifecycle.phase, "planning");
      await hooks.get("tool_call")({ toolName: "write", input: { path: "x", content: "x" }, toolCallId: "late" }, ctx);
      await hooks.get("tool_execution_end")({ toolCallId: "late", isError: false }, ctx);
      await hooks.get("agent_settled")({}, ctx);
      await settledAttempts();
      const later = attempts.slice(planAttempts);
      assert.ok(later.length >= 1, "executed work still receives a completion review");
      assert.ok(
        later.every((request) => request.kind === "completion"),
        "unchanged plan advice is never retried",
      );
      assert.equal(
        sent.some((s) => s.options?.triggerTurn),
        false,
        "exhausted reviews create no reminder turns",
      );
      // With both ladders exhausted on unchanged work, further settlements restart neither review.
      const exhausted = attempts.length;
      for (let settle = 0; settle < 3; settle++) {
        await hooks.get("agent_settled")({}, ctx);
        await settledAttempts();
      }
      assert.equal(attempts.length, exhausted, "exhausted plan and completion ladders never alternate");
    } finally {
      restoreEnvironment();
    }
  });

  it("keeps the retained plan when completion advice follows an exhausted plan review", async () => {
    const attempts = [];
    const reviewRunner = {
      start: (request) => {
        attempts.push(request);
        const verdict =
          request.kind === "completion"
            ? {
                reviewKind: "completion",
                scopeFingerprint: request.scopeFingerprint,
                verdict: "pass",
                summary: "Bounded advice",
                evidence: ["Inspected evidence"],
                findings: [],
              }
            : undefined;
        return {
          result: Promise.resolve(
            verdict
              ? { status: "completed", verdict, usage: { cost: 0, inputTokens: 0, outputTokens: 0 } }
              : { status: "failed", usage: { cost: 0, inputTokens: 0, outputTokens: 0 } },
          ),
          cancel() {},
        };
      },
    };
    const { hooks, tools, ctx, latestLease, restoreEnvironment } = await authorizationLifecycleFixture({
      reviewRunner,
    });
    const notes = [];
    ctx.ui.notify = (message, level) => notes.push({ message, level });
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      await tools.get("submit_action_plan").execute("plan", irreversibleActionPlan(), undefined, undefined, ctx);
      const plan = latestLease().lifecycle.plan;
      assert.ok(plan);
      await hooks.get("agent_settled")({}, ctx);
      // Wait until the whole plan-review ladder has failed and no further attempt starts.
      const failures = () => notes.filter((n) => /did not return valid advice/.test(n.message)).length;
      for (let stable = 0, i = 0; i < 400 && stable < 5; i++) {
        const before = attempts.length;
        await new Promise((resolve) => setTimeout(resolve, 5));
        stable = attempts.length === before && attempts.length > 0 && failures() === attempts.length ? stable + 1 : 0;
      }
      await flushMicrotasks();
      await hooks.get("tool_call")({ toolName: "write", input: { path: "x", content: "x" }, toolCallId: "w1" }, ctx);
      await hooks.get("tool_execution_end")({ toolCallId: "w1", isError: false }, ctx);
      await hooks.get("agent_settled")({}, ctx);
      await waitForReview(() => latestLease().lifecycle.phase === "completed");
      assert.deepEqual(latestLease().lifecycle.plan, plan, "completion from planning keeps the retained plan");
      await hooks.get("tool_call")({ toolName: "write", input: { path: "y", content: "y" }, toolCallId: "w2" }, ctx);
      await hooks.get("tool_execution_end")({ toolCallId: "w2", isError: false }, ctx);
      assert.equal(latestLease().lifecycle.phase, "executing");
      assert.deepEqual(latestLease().lifecycle.plan, plan, "reopened work keeps the retained plan");
    } finally {
      restoreEnvironment();
    }
  });

  it("notes missing completion evidence once without repairing the builder", async () => {
    const fixture = await authorizationLifecycleFixture();
    fixture.parent.lifecycle = { phase: "building", policy: "completion_review", taskFingerprint: "task-fingerprint" };
    const { hooks, ctx, sent, restoreEnvironment } = fixture;
    const notes = [];
    ctx.ui.notify = (message, level) => notes.push({ message, level });
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      await hooks.get("agent_settled")({}, ctx);
      await hooks.get("agent_settled")({}, ctx);
      const events = (await readFile(process.env.PI_ROUTER_TELEMETRY_PATH, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(
        events.filter((e) => e.kind === "advisory_step_skipped" && e.data.step === "completion_evidence").length,
        1,
      );
      assert.equal(notes.filter((n) => n.level === "warning" && /verification evidence/.test(n.message)).length, 1);
      assert.equal(
        sent.some((s) => s.message.details?.repairReason === "missing_completion_evidence"),
        false,
      );
    } finally {
      restoreEnvironment();
    }
  });

  it("gates input that arrives during a new session's startup as a new task, not the previous session's lease", async () => {
    const { hooks, parent, ctx, latestLease, restoreEnvironment, onExec } = await authorizationLifecycleFixture();
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      await hooks.get("before_agent_start")(
        { prompt: "Inspect and plan the production change", systemPrompt: "base" },
        ctx,
      );
      await hooks.get("agent_settled")({}, ctx);
      assert.equal(latestLease().taskId, parent.taskId, "the first session holds a lease");
      await hooks.get("session_shutdown")({ reason: "new" }, ctx);
      const nextCtx = {
        ...ctx,
        cwd: await mkdtemp(join(tmpdir(), "pi-router-new-session-")),
        sessionManager: { getBranch: () => [], getSessionId: () => "next-session" },
      };
      // Hold the new session's startup in its repository lookup while the user types.
      const lookup = deferred();
      const lookupReached = deferred();
      onExec(async () => {
        onExec(undefined);
        lookupReached.resolve();
        await lookup.promise;
      });
      const starting = hooks.get("session_start")({ reason: "new" }, nextCtx);
      await lookupReached.promise;
      await hooks.get("input")({ text: "continue", source: "interactive" }, nextCtx);
      lookup.resolve();
      await starting;
      await hooks.get("before_agent_start")({ prompt: "continue", systemPrompt: "base" }, nextCtx);
      const boundary = (await readFile(process.env.PI_ROUTER_TELEMETRY_PATH, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .findLast(({ kind, data }) => kind === "boundary" && data.action !== undefined);
      assert.equal(boundary.data.action, "new_task", "the previous session's lease must not absorb the input");
      assert.match(boundary.data.reason, /hard boundary: new_session/);
    } finally {
      restoreEnvironment();
    }
  });

  it("keeps a compaction boundary pending across a same-task repair so the next input re-routes", async () => {
    const { hooks, sent, ctx, latestLease, restoreEnvironment } = await authorizationLifecycleFixture();
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      await hooks.get("before_agent_start")(
        { prompt: "Inspect and plan the production change", systemPrompt: "base" },
        ctx,
      );
      // Compaction lands mid-run; settlement then nudges the same task to submit its missing plan.
      await hooks.get("session_compact")({ type: "session_compact" }, ctx);
      await hooks.get("agent_settled")({}, ctx);
      assert.equal(latestLease().lifecycle.phase, "planning");
      assert.equal(
        sent.some((s) => s.message.details?.repairReason === "missing_action_plan"),
        false,
      );

      await hooks.get("input")({ text: "continue", source: "interactive" }, ctx);
      await hooks.get("before_agent_start")({ prompt: "continue", systemPrompt: "base" }, ctx);
      const boundary = (await readFile(process.env.PI_ROUTER_TELEMETRY_PATH, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .findLast(({ kind, data }) => kind === "boundary" && data.action !== undefined);
      assert.equal(boundary.data.action, "new_task");
      assert.match(boundary.data.reason, /hard boundary: post_compaction/);
    } finally {
      restoreEnvironment();
    }
  });

  it("withdraws router tools before /route off awaits its cleanup", async () => {
    const result = await runAdapterTurn({ mode: "active", prompt: "Plan the change", sessionId: "off-sync" });
    assert.ok(result.activeTools.includes("submit_implementation_plan"));
    // The handler runs synchronously up to its first await, so tools must already be withdrawn here: an in-flight
    // request must not see tools that the off-mode bypass and execute guards now refuse.
    const turningOff = result.commands.get("route").handler("off", result.ctx);
    assert.equal(result.activeTools.includes("submit_implementation_plan"), false);
    await turningOff;
    const turningOn = result.commands.get("route").handler("active", result.ctx);
    assert.ok(result.activeTools.includes("submit_implementation_plan"), "re-enabling restores them at once too");
    await turningOn;
  });

  it("reconciles secondary before settlement advances the lease revision (#73)", async () => {
    const secondary = deferred();
    const features = {
      risk: "critical",
      actionMode: "destructive",
      intent: "operate",
      workflowType: "incident_or_operations",
    };
    const result = await runAdapterTurn({
      classifyPrimaryTask: async () => primaryClassificationResult({ ...features, confidence: 0.6 }),
      classifySecondaryTask: async () => secondary.promise,
      models: [
        ...standardRoutingModels(),
        routingModel("google-vertex", "gemini-3.6-flash"),
        routingModel("openai-codex", "gpt-6-astra"),
      ],
      mode: "active",
      prompt: "Rotate production credential",
      sessionId: "secondary-before-settlement",
    });
    const latest = () => result.appended.findLast((entry) => entry.customType === "model-router-state")?.data.active;
    startAgentRun(result);
    result.ctx.model = result.ctx.modelRegistry.find(latest().selected.provider, latest().selected.modelId);
    await endAgentTurn(result);
    await result.hooks.get("agent_end")(
      {
        messages: [
          {
            role: "assistant",
            provider: latest().selected.provider,
            model: latest().selected.modelId,
            stopReason: "stop",
            usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        ],
      },
      result.ctx,
    );
    secondary.resolve(classificationResult(2, { ...features, confidence: 0.95 }));
    await flushMicrotasks();
    await result.hooks.get("agent_settled")({}, result.ctx);
    assert.equal(latest().lifecycle.phase, "planning");
    assert.equal(latest().lifecycle.evidenceRepairAttempted, undefined);
    assert.ok(result.events.some((event) => event.kind === "secondary_reconciliation"));
    assert.equal(
      result.events.some((event) => event.data.reason === "lease_revision_changed"),
      false,
    );
    const decision = result.hooks.get("tool_call")(
      { toolCallId: "unapproved", toolName: "bash", input: { command: "rotate production credential" } },
      result.ctx,
    );
    assert.equal(decision, undefined, "secondary corrections never restrict tools");
  });

  it("drops completion advice if builder evidence changed while review was pending", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    fixture.parent.lifecycle = {
      phase: "executing",
      policy: "plan_review_then_completion_review",
      taskFingerprint: "task-fingerprint",
    };
    fixture.parent.safetyEvidence.mutations = [
      { toolName: "write", inputFingerprint: "a".repeat(64), recordedAt: "before" },
    ];
    try {
      await fixture.hooks.get("session_start")({ reason: "reload" }, fixture.ctx);
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      await flushMicrotasks();
      await waitForReview(() => runner.calls.length > 0);
      const call = runner.calls[0];
      fixture.hooks.get("tool_call")(
        { toolCallId: "new-mutation", toolName: "write", input: { path: "changed" } },
        fixture.ctx,
      );
      fixture.hooks.get("tool_execution_end")({ toolCallId: "new-mutation", isError: false }, fixture.ctx);
      call.resolve({
        status: "completed",
        verdict: validAdvice(call.request),
        usage: { cost: 0.01, inputTokens: 1, outputTokens: 1 },
      });
      await waitForReview(() => fixture.latestLease().safetyEvidence.mutations.length === 2);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(fixture.latestLease().lifecycle.phase, "executing");
      assert.equal(
        fixture.sent.some((s) => /Independent review advice/.test(s.message.content)),
        false,
      );
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("delivers completion findings as a follow-up without switching builder models", async () => {
    const runner = controlledRunner();
    const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
    fixture.parent.lifecycle = {
      phase: "executing",
      policy: "plan_review_then_completion_review",
      taskFingerprint: "task-fingerprint",
    };
    fixture.parent.safetyEvidence.mutations = [
      { toolName: "write", inputFingerprint: "a".repeat(64), recordedAt: "now" },
    ];
    try {
      await fixture.hooks.get("session_start")({ reason: "reload" }, fixture.ctx);
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      await waitForReview(() => runner.calls.length > 0);
      const call = runner.calls[0];
      assert.equal(call.request.kind, "completion");
      call.resolve({
        status: "completed",
        verdict: validAdvice(call.request),
        usage: { cost: 0.01, inputTokens: 1, outputTokens: 1 },
      });
      await flushMicrotasks();
      await waitForReview(() => fixture.latestLease().lifecycle.phase === "completed");
      assert.equal(fixture.sent.at(-1).options.triggerTurn, false);
      assert.equal(fixture.sent.at(-1).options.deliverAs, "followUp");
      assert.equal(fixture.selectedModels.length, 0);
      await fixture.hooks.get("before_agent_start")({ prompt: "Continue", systemPrompt: "BUILDER_BASE" }, fixture.ctx);
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(runner.calls.length, 1, "unchanged completion evidence must not schedule another review");
    } finally {
      fixture.restoreEnvironment();
    }
  });

  for (const boundary of ["none", "input", "shutdown", "replacement"]) {
    it(`handles a rejected review selection telemetry append across ${boundary}`, async () => {
      const runner = controlledRunner();
      const write = deferred();
      const rejected = deferred();
      let writing = false;
      const fixture = await authorizationLifecycleFixture({
        reviewRunner: runner,
        classifyPrimaryTask: childClassifier([]),
        telemetry: {
          read: async () => [],
          append: async (event) => {
            if (event.kind !== "classifier_invocation" || event.data.purpose !== "review_child") return;
            writing = true;
            try {
              await write.promise;
            } finally {
              rejected.resolve();
            }
          },
        },
      });
      const { hooks, ctx, appended, sent, restoreEnvironment } = fixture;
      const notes = [];
      ctx.ui.notify = (message, level) => notes.push({ message, level });
      const staleAccesses = [];
      try {
        await launchReview(fixture);
        await waitForReview(() => writing);
        assert.equal(runner.calls.length, 0, "selection telemetry precedes child launch");
        const expired = boundary === "shutdown" || boundary === "replacement";
        if (expired) await hooks.get("session_shutdown")({ reason: "reload" }, ctx);
        else if (boundary === "input")
          await hooks.get("input")(
            { text: "Inspect instead", source: "interactive", streamingBehavior: "followUp" },
            ctx,
          );
        const currentCtx = { ...ctx };
        if (boundary === "replacement") await hooks.get("session_start")({ reason: "reload" }, currentCtx);
        if (expired)
          for (const key of ["ui", "cwd", "sessionManager", "modelRegistry", "model", "hasUI"])
            Object.defineProperty(ctx, key, {
              configurable: true,
              get() {
                staleAccesses.push(key);
                throw new Error("This extension ctx is stale after session replacement or reload.");
              },
            });
        const entriesBefore = appended.length;
        const sentBefore = sent.length;
        write.reject(new Error("selection telemetry write failed"));
        await rejected.promise;
        // Flush the entire record -> selection -> review continuation after the deferred rejection.
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(staleAccesses, [], "a failed old write must never access the expired context");
        assert.equal(runner.calls.length, 0);
        assert.equal(sent.length, sentBefore, "failed selection never delivers advice");
        const state = appended.findLast((entry) => entry.customType === "model-router-state");
        if (expired) {
          assert.equal(appended.length, entriesBefore, "old telemetry failure cannot mutate the current routing state");
          assert.equal(state.data.mode, "active");
          assert.equal(
            notes.some((note) => /Router telemetry failed/.test(note.message)),
            false,
          );
          if (boundary === "replacement") {
            await fixture.commands.get("route").handler("active", currentCtx);
            assert.equal(
              notes.some((note) => /cannot enter active mode/.test(note.message)),
              false,
            );
          }
        } else {
          assert.equal(state.data.mode, "shadow", "current-session failures remain fail-closed, even after input");
          assert.equal(
            notes.some((note) => note.level === "error" && /Router telemetry failed/.test(note.message)),
            true,
          );
        }
      } finally {
        write.resolve();
        restoreEnvironment();
      }
    });
  }

  for (const outcome of ["published", "failed"]) {
    it(`ignores late ${outcome} discovery after session replacement without touching stale context`, async () => {
      const gate = deferred();
      const runner = controlledRunner();
      const events = [];
      let signal;
      const fixture = await authorizationLifecycleFixture({
        reviewRunner: runner,
        allTools: () => [agentTool()],
        activeExtra: ["Agent"],
        discoverDelegate: (request) => {
          signal = request.signal;
          return gate.promise; // Deliberately ignores abort.
        },
        telemetry: { read: async () => [], append: async (event) => events.push(event) },
      });
      const { hooks, ctx, restoreEnvironment } = fixture;
      try {
        await launchReview(fixture, runner);
        await hooks.get("session_shutdown")({ reason: "new" }, ctx);
        const nextCtx = {
          ...ctx,
          sessionManager: { ...ctx.sessionManager, getSessionId: () => "replacement", getBranch: () => [] },
        };
        await hooks.get("session_start")({ reason: "new" }, nextCtx);
        const staleAccesses = [];
        Object.defineProperty(ctx, "sessionManager", {
          configurable: true,
          get() {
            staleAccesses.push("sessionManager");
            throw new Error("This extension ctx is stale after session replacement or reload.");
          },
        });
        if (outcome === "published") gate.resolve(agentDiscovery());
        else gate.reject(new Error("late discovery failure"));
        await flushMicrotasks();
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepEqual(staleAccesses, [], "late discovery must not read the previous context");
        assert.equal(signal.aborted, true, "shutdown invalidates and aborts discovery before context expires");
        assert.equal(
          events.some((event) => event.data.discovery),
          false,
          "old discovery cannot publish or report",
        );
        assert.equal(
          fixture.appended.findLast((entry) => entry.customType === "model-router-state").data.mode,
          "active",
        );
      } finally {
        restoreEnvironment();
      }
    });
  }

  it("does not disable a replacement session when an earlier discovery telemetry append fails late", async () => {
    const gate = deferred();
    const reached = deferred();
    const runner = controlledRunner();
    const notes = [];
    const fixture = await authorizationLifecycleFixture({
      reviewRunner: runner,
      allTools: () => [agentTool()],
      activeExtra: ["Agent"],
      discoverDelegate: agentDiscovery,
      telemetry: {
        read: async () => [],
        append: (event) => {
          if (event.data.discovery) {
            reached.resolve();
            return gate.promise;
          }
          return Promise.resolve();
        },
      },
    });
    const { hooks, ctx, restoreEnvironment } = fixture;
    ctx.ui.notify = (message) => notes.push(message);
    try {
      await launchReview(fixture);
      await reached.promise;
      await hooks.get("session_shutdown")({ reason: "new" }, ctx);
      const nextCtx = {
        ...ctx,
        sessionManager: { ...ctx.sessionManager, getSessionId: () => "replacement", getBranch: () => [] },
      };
      await hooks.get("session_start")({ reason: "new" }, nextCtx);
      gate.reject(new Error("late discovery append failure"));
      await flushMicrotasks();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(
        notes.some((note) => /Router telemetry failed/.test(note)),
        false,
      );
      assert.equal(fixture.appended.findLast((entry) => entry.customType === "model-router-state").data.mode, "active");
    } finally {
      restoreEnvironment();
    }
  });

  it("disables the same session when discovery telemetry fails after another observation", async () => {
    const gate = deferred();
    const reached = deferred();
    const runner = controlledRunner();
    const notes = [];
    const fixture = await authorizationLifecycleFixture({
      reviewRunner: runner,
      allTools: () => [agentTool()],
      activeExtra: ["Agent"],
      discoverDelegate: async () => ({ match: false }),
      telemetry: {
        read: async () => [],
        append: (event) => {
          if (event.data.discovery) {
            reached.resolve();
            return gate.promise;
          }
          return Promise.resolve();
        },
      },
    });
    fixture.ctx.ui.notify = (message) => notes.push(message);
    try {
      await launchReview(fixture, runner);
      await reached.promise;
      runner.calls[0].resolve({ status: "failed", usage: { cost: 0, inputTokens: 0, outputTokens: 0 } });
      await flushMicrotasks();
      const revised = {
        ...irreversibleActionPlan(),
        objective: "Rotate the production credential after rechecking access.",
      };
      await fixture.tools.get("submit_action_plan").execute("revised", revised, undefined, undefined, fixture.ctx);
      await fixture.hooks.get("agent_settled")({}, fixture.ctx);
      // Starting another review observes discovery again without replacing the session or its generation.
      await waitForReview(() => runner.calls.length === 2);
      gate.reject(new Error("delayed same-session discovery append failure"));
      await waitForReview(() => notes.some((note) => /Router telemetry failed/.test(note)));
      assert.equal(fixture.appended.findLast((entry) => entry.customType === "model-router-state").data.mode, "shadow");
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("still disables the owning live session when discovery telemetry fails", async () => {
    const notes = [];
    const fixture = await authorizationLifecycleFixture({
      allTools: () => [agentTool()],
      activeExtra: ["Agent"],
      discoverDelegate: agentDiscovery,
      telemetry: {
        read: async () => [],
        append: async (event) => {
          if (event.data.discovery) throw new Error("current discovery append failure");
        },
      },
    });
    fixture.ctx.ui.notify = (message) => notes.push(message);
    try {
      await launchReview(fixture);
      await waitForReview(() => notes.some((note) => /Router telemetry failed/.test(note)));
      assert.equal(fixture.appended.findLast((entry) => entry.customType === "model-router-state").data.mode, "shadow");
    } finally {
      fixture.restoreEnvironment();
    }
  });

  it("records a late cancelled outcome without touching the invalidated context", async () => {
    const runner = controlledRunner();
    const events = [];
    const fixture = await authorizationLifecycleFixture({
      reviewRunner: runner,
      telemetry: { read: async () => [], append: async (event) => events.push(event) },
    });
    const { hooks, ctx, sent, restoreEnvironment } = fixture;
    try {
      await launchReview(fixture, runner);
      const call = runner.calls[0];
      await hooks.get("session_shutdown")({ reason: "reload" }, ctx);
      assert.equal(call.cancelled, true);
      // Pi invalidates the captured context after shutdown; every getter then throws.
      const staleAccesses = [];
      for (const key of ["ui", "cwd", "sessionManager", "modelRegistry", "model", "hasUI"])
        Object.defineProperty(ctx, key, {
          configurable: true,
          get() {
            staleAccesses.push(key);
            throw new Error("This extension ctx is stale after session replacement or reload.");
          },
        });
      const sentBefore = sent.length;
      const eventsBefore = events.length;
      call.resolve({ status: "cancelled", usage: { cost: 0.02, inputTokens: 3, outputTokens: 2 } });
      await waitForReview(() => events.length > eventsBefore);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const outcome = events.findLast((event) => event.kind === "outcome" && event.data.reviewStatus === "cancelled");
      assert.ok(outcome, "late cancelled outcome must still be recorded");
      assert.equal(outcome.sessionId, "authorization-session");
      assert.equal(outcome.data.staleVerdictDropped, true);
      assert.equal(outcome.data.reviewCost, 0.02);
      assert.equal(outcome.provider, call.request.model.provider);
      assert.equal(outcome.modelId, call.request.model.id);
      assert.equal(outcome.cacheWriteClassification !== undefined, true, "endpoint metadata captured before start");
      assert.deepEqual(staleAccesses, [], "late outcomes must not read the invalidated context");
      assert.equal(sent.length, sentBefore);
    } finally {
      restoreEnvironment();
    }
  });

  it("disables routing when a review cancelled by input then fails its outcome append", async () => {
    const runner = controlledRunner();
    let fail = false;
    const fixture = await authorizationLifecycleFixture({
      reviewRunner: runner,
      telemetry: {
        read: async () => [],
        append: async () => {
          if (fail) throw new Error("fixture telemetry failure");
        },
      },
    });
    const { hooks, ctx, restoreEnvironment } = fixture;
    const notes = [];
    ctx.ui.notify = (message, level) => notes.push({ message, level });
    try {
      await launchReview(fixture, runner);
      const call = runner.calls[0];
      await hooks.get("input")({ text: "Inspect instead", source: "interactive", streamingBehavior: "followUp" }, ctx);
      assert.equal(call.cancelled, true);
      fail = true;
      call.resolve({ status: "cancelled", usage: { cost: 0.01, inputTokens: 1, outputTokens: 1 } });
      await waitForReview(() => notes.some((note) => /Router telemetry failed/.test(note.message)));
      assert.equal(
        notes.some((note) => note.level === "error" && /Router telemetry failed/.test(note.message)),
        true,
      );
      const state = fixture.appended.findLast((entry) => entry.customType === "model-router-state");
      assert.equal(state.data.mode, "shadow", "telemetry failure disables active routing");
    } finally {
      restoreEnvironment();
    }
  });

  for (const tracked of ["", "10\t2\tsrc/changed.ts\n"]) {
    it(`keeps the conservative review timeout when untracked files are in scope (tracked: ${tracked ? "yes" : "no"})`, async () => {
      const runner = controlledRunner();
      const fixture = await authorizationLifecycleFixture({ reviewRunner: runner });
      const ok = (stdout) => ({ stdout, stderr: "", code: 0, killed: false });
      fixture.onExec(async (command, args) => {
        if (command !== "git") return undefined;
        if (args.includes("--numstat")) return ok(tracked);
        if (args.includes("diff")) return ok("");
        if (args.includes("ls-files")) return ok("new-binary.bin\0");
        return undefined;
      });
      try {
        await launchReview(fixture, runner);
        assert.equal(runner.calls.length, 1);
        // Untracked scope is unmeasured, so the reviewer gets the four-hour cap rather than the five-minute floor.
        assert.ok(runner.calls[0].request.timeoutMs > 60 * 60_000, `timeout ${runner.calls[0].request.timeoutMs}`);
      } finally {
        fixture.restoreEnvironment();
      }
    });
  }
});
