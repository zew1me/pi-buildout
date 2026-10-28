import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildKickoffPrompt } from "./rpc.ts";

// Mock only the extension's external boundaries. Exercise its real create dispatcher,
// compaction orchestration, utilityCompletion, classifier, and context bounding.
const indexUrl = new URL("./index.ts", import.meta.url).href;
const fixtureKey = "pi-subagents-create-test";
/** @type {{
 * dir: string; compactions: number; historyBuilds: number; disposals: number;
 * utilityPrompts: string[]; compactionPrompts: string[];
 * launches: import('./rpc.ts').ChildLaunchOptions[]; stops: number;
 * summary: string; failCompaction: boolean;
 * classify: (() => Promise<void>) | undefined; start: (() => Promise<void>) | undefined;
 * }} */
const fixture = {
  dir: "",
  compactions: 0,
  historyBuilds: 0,
  disposals: 0,
  utilityPrompts: [],
  compactionPrompts: [],
  launches: [],
  stops: 0,
  summary: "parent-only-sentinel " + "s".repeat(50_000),
  failCompaction: false,
  classify: undefined,
  start: undefined,
};
Reflect.set(globalThis, fixtureKey, fixture);
const mocks = {
  "@earendil-works/pi-ai/compat": `
    export { StringEnum } from '@earendil-works/pi-ai/compat';
    const f = globalThis[${JSON.stringify(fixtureKey)}];
    export async function completeSimple(model, context) {
      f.utilityPrompts.push(JSON.stringify(context));
      await f.classify?.();
      return { content: [{ type: 'text', text: JSON.stringify({ model: 'test/model', effort: 'high' }) }] };
    }
  `,
  "@earendil-works/pi-coding-agent": `
    const f = globalThis[${JSON.stringify(fixtureKey)}];
    export function getAgentDir() { return f.dir; }
    export function buildSessionContext(entries) { f.historyBuilds++; return { messages: entries }; }
    export const SessionManager = { inMemory: () => ({ appendMessage() {}, appendCustomMessageEntry() {} }) };
    export const SettingsManager = { inMemory: () => ({}) };
    export class DefaultResourceLoader { async reload() {} }
    export async function createAgentSession() {
      return { session: {
        async compact(prompt) {
          f.compactions++; f.compactionPrompts.push(prompt);
          if (f.failCompaction) throw new Error('compaction unavailable');
          return { summary: f.summary };
        },
        abortCompaction() {}, dispose() { f.disposals++; }
      } };
    }
  `,
  "./rpc.ts": `
    const f = globalThis[${JSON.stringify(fixtureKey)}];
    export class ManagedSubagent {
      constructor(options) { this.options = options; f.launches.push(options); }
      async start() { await f.start?.(); }
      async stop() { f.stops++; }
      async refresh() {}
      isAlive() { return true; }
      snapshot() {
        const o = this.options;
        return { id: o.id, name: o.name, task: o.task, state: 'running', model: o.model,
          effort: o.effort, contextMode: o.contextMode ?? 'task_compacted', classification: o.classification,
          startedAt: Date.now(), updatedAt: Date.now(), turns: 0, toolCalls: 0,
          pendingMessages: 0, compactions: 0, transcriptTail: '' };
      }
    }
  `,
};
const mockPrefix = new URL("./__mock__", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === indexUrl && Object.hasOwn(mocks, specifier)) {
      return { url: `${mockPrefix}${encodeURIComponent(specifier)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(mockPrefix)) {
      const key = /** @type {keyof typeof mocks} */ (decodeURIComponent(url.slice(mockPrefix.length)));
      return { format: "module", source: mocks[key], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { default: subagentsExtension } = await import("./index.ts");
hooks.deregister();

/** @param {import('node:test').TestContext} t @param {boolean} [forbidHistory] */
async function harness(t, forbidHistory = false) {
  const dir = await mkdtemp(join(tmpdir(), "subagent-create-"));
  fixture.dir = dir;
  fixture.compactions = fixture.historyBuilds = fixture.disposals = fixture.stops = 0;
  fixture.utilityPrompts = [];
  fixture.compactionPrompts = [];
  fixture.launches = [];
  fixture.failCompaction = false;
  fixture.classify = fixture.start = undefined;
  t.after(async () => rm(dir, { recursive: true, force: true }));
  /** @type {import('@earendil-works/pi-coding-agent').ToolDefinition | undefined} */
  let tool;
  subagentsExtension(
    /** @type {import('@earendil-works/pi-coding-agent').ExtensionAPI} */ (
      /** @type {unknown} */ ({
        registerTool: (/** @type {import('@earendil-works/pi-coding-agent').ToolDefinition} */ registered) => {
          tool = registered;
        },
        on() {},
        getThinkingLevel: () => "high",
      })
    ),
  );
  const model = { provider: "test", id: "model", reasoning: true, contextWindow: 8_000 };
  const sessionManager = {
    getEntries() {
      return [{ role: "assistant", content: "parent-only-sentinel" }];
    },
    getLeafId: () => "leaf",
    getSessionId: () => "parent",
  };
  if (forbidHistory) {
    for (const key of ["getEntries", "getLeafId", "getBranch"]) {
      Object.defineProperty(sessionManager, key, {
        get() {
          throw new Error("Parent transcript must not be read");
        },
      });
    }
  }
  const ctx = /** @type {import('@earendil-works/pi-coding-agent').ExtensionToolContext} */ (
    /** @type {unknown} */ ({
      cwd: fixture.dir,
      model,
      sessionManager,
      isProjectTrusted: () => false,
      modelRegistry: {
        runtime: {},
        getAvailable: () => [model],
        hasConfiguredAuth: () => true,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture-key" }),
      },
    })
  );
  assert.ok(tool);
  const registered = tool;
  /** @param {Record<string, unknown>} args @param {AbortSignal} [signal] */
  const execute = (args, signal) => registered.execute("test-call", args, signal, undefined, ctx);
  return { execute, tool: registered };
}

test("default and explicit task_compacted preserve bounded task compaction", async (t) => {
  for (const contextMode of [undefined, "task_compacted"]) {
    const { execute } = await harness(t);
    const result = await execute({ action: "create", task: "Do the task", ...(contextMode ? { contextMode } : {}) });
    assert.equal(fixture.compactions, 1);
    assert.equal(fixture.historyBuilds, 1);
    assert.equal(fixture.disposals, 1);
    assert.match(fixture.compactionPrompts[0] ?? "", /Do the task/);
    const launch = fixture.launches[0];
    assert.ok(launch);
    assert.equal(launch.contextMode, "task_compacted");
    assert.match(launch.contextSummary, /parent-only-sentinel/);
    assert.ok(launch.contextSummary.length < 9_600);
    assert.match(fixture.utilityPrompts[0] ?? "", /parent-only-sentinel/);
    assert.match(buildKickoffPrompt(launch.task, launch.contextSummary), /<context>/);
    assert.equal(Reflect.get(result.details, "contextMode"), "task_compacted");
  }
});

test("none never reads history or compacts; automatic selection sees only task and catalog", async (t) => {
  const { execute, tool } = await harness(t, true);
  fixture.failCompaction = true;
  assert.deepEqual(tool.parameters.properties.contextMode?.enum, ["task_compacted", "none"]);
  const result = await execute({ action: "create", task: "Do the task", contextMode: "none" });
  assert.equal(fixture.compactions, 0);
  assert.equal(fixture.historyBuilds, 0);
  assert.equal(fixture.utilityPrompts.length, 1);
  assert.match(fixture.utilityPrompts[0] ?? "", /Do the task/);
  assert.match(fixture.utilityPrompts[0] ?? "", /test\/model/);
  assert.doesNotMatch(fixture.utilityPrompts[0] ?? "", /parent-only-sentinel/);
  const launch = fixture.launches[0];
  assert.ok(launch);
  assert.equal(launch.classification, "classified");
  assert.equal(launch.effort, "high");
  assert.equal(launch.contextSummary, "");
  assert.equal(buildKickoffPrompt(launch.task, launch.contextSummary), "Task:\nDo the task");
  assert.equal(Reflect.get(result.details, "contextMode"), "none");
  assert.equal(Reflect.get(result.details, "compactionFallback"), false);
  assert.doesNotMatch(JSON.stringify(result), /failed open|fresh context|parent-only-sentinel/);
  for (const action of ["status", "list"]) {
    const status = await execute({ action, id: launch.id });
    assert.match(JSON.stringify(status), /contextMode=none/);
    assert.match(JSON.stringify(status.details), /"contextMode":"none"/);
  }
});

test("none with explicit model and effort bypasses classification", async (t) => {
  const { execute } = await harness(t, true);
  await execute({ action: "create", task: "Do the task", contextMode: "none", model: "test/model", effort: "high" });
  assert.equal(fixture.utilityPrompts.length, 0);
  assert.equal(fixture.compactions, 0);
  assert.equal(fixture.launches[0]?.classification, "explicit");
  assert.equal(fixture.launches[0]?.contextSummary, "");
});

test("default compaction failure still warns and launches fresh", async (t) => {
  const { execute } = await harness(t);
  fixture.failCompaction = true;
  const result = await execute({ action: "create", task: "Do the task", model: "test/model", effort: "high" });
  assert.equal(fixture.compactions, 1);
  assert.equal(Reflect.get(result.details, "compactionFallback"), true);
  assert.match(JSON.stringify(result.content), /Targeted compaction failed open/);
});

test("cancellation releases creation reservations in both modes and stops an aborted launch", async (t) => {
  for (const contextMode of ["task_compacted", "none"]) {
    const { execute } = await harness(t, contextMode === "none");
    for (let i = 0; i < 9; i++) {
      const abort = new AbortController();
      fixture.classify = async () => {
        abort.abort();
      };
      await assert.rejects(execute({ action: "create", task: "Do the task", contextMode }, abort.signal), /abort/i);
    }
    assert.equal(fixture.launches.length, 0);
    fixture.classify = undefined;
    const abort = new AbortController();
    fixture.start = async () => {
      abort.abort();
    };
    await assert.rejects(execute({ action: "create", task: "Do the task", contextMode }, abort.signal), /abort/i);
    assert.equal(fixture.stops, 1);
    fixture.start = undefined;
    await execute({ action: "create", task: "Do the task", contextMode });
    assert.equal(fixture.launches.length, 2);
  }
});
