import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { completeSimple, StringEnum } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
  buildSessionContext,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  THINKING_LEVELS,
  boundContextForModel,
  clampThinkingLevel,
  excludeCurrentDelegationTurn,
  extractTextContent,
  formatModelCatalog,
  parseClassifierDecision,
  truncateMiddle,
} from "./helpers.ts";
import type { ThinkingLevel } from "./helpers.ts";
import { ManagedSubagent } from "./rpc.ts";
import type { ChildSnapshot } from "./rpc.ts";

const MAX_CLASSIFIER_CONTEXT_CHARS = 24_000;
const MAX_STATUS_TEXT_CHARS = 45_000;
const MAX_ROOT_CHILDREN = 8;
const MAX_NESTED_CHILDREN = 2;
const MAX_RETAINED_CHILDREN = 32;
const MAX_DEPTH = 3;
const DEPTH_ENV = "PI_SIMPLE_SUBAGENT_DEPTH";
const AUTH_PROVIDER_ENV = "PI_SIMPLE_SUBAGENT_AUTH_PROVIDER";
const AUTH_KEY_ENV = "PI_SIMPLE_SUBAGENT_API_KEY";
const SELF_EXTENSION_PATH = fileURLToPath(import.meta.url);
const AUTH_BRIDGE_PATH = join(dirname(SELF_EXTENSION_PATH), "auth-bridge.ts");

const SubagentParameters = Type.Object({
  action: StringEnum(["create", "list", "status", "wait", "steer", "follow_up", "interrupt", "stop"] as const, {
    description:
      "create a child; inspect it; explicitly wait for it; steer now; queue follow_up; interrupt its current operation; or stop its process",
  }),
  task: Type.Optional(
    Type.String({
      description: "For create: the complete task. For steer/follow_up: the additional message.",
    }),
  ),
  id: Type.Optional(Type.String({ description: "Direct child id for status/control actions" })),
  name: Type.Optional(
    Type.String({ description: "Optional human-readable name when creating a child", maxLength: 120 }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Optional model request, such as gpt-5.6-luna or openai/gpt-5.6-luna. Preserve a model explicitly requested by the user.",
    }),
  ),
  effort: Type.Optional(
    StringEnum(THINKING_LEVELS, {
      description: "Optional reasoning effort. Preserve an effort explicitly requested by the user, for example high.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      description:
        "For wait only: maximum time in milliseconds without stopping the child. Use 120000 for 120 seconds (default 120000, max 600000).",
      minimum: 1,
      maximum: 600_000,
    }),
  ),
});

type PiModel = NonNullable<ExtensionContext["model"]>;

type Selection = {
  model: PiModel;
  effort: ThinkingLevel;
  source: "explicit" | "classified" | "fallback";
  rationale?: string;
};

function currentDepth(): number {
  const value = Number(process.env[DEPTH_ENV] ?? "0");
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function textFromAssistant(response: { content: unknown }): string {
  return extractTextContent(response.content).trim();
}

function parentThinking(pi: ExtensionAPI): ThinkingLevel {
  const value = pi.getThinkingLevel();
  return THINKING_LEVELS.includes(value) ? value : "off";
}

async function utilityCompletion(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
  maxTokens: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  throwIfAborted(signal);
  if (!ctx.model) throw new Error("The parent session has no selected model.");
  const parentModel = ctx.model as unknown as Model<Api>;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(parentModel);
  throwIfAborted(signal);
  if (!auth.ok) throw new Error(auth.error);
  const effort = clampThinkingLevel(parentThinking(pi), parentModel);
  const response = await completeSimple(
    parentModel,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      maxTokens,
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
      ...(auth.headers ? { headers: auth.headers } : {}),
      ...(auth.env ? { env: auth.env } : {}),
      ...(signal ? { signal } : {}),
      ...(effort === "off" ? {} : { reasoning: effort }),
    },
  );
  throwIfAborted(signal);
  const text = textFromAssistant(response);
  if (!text) throw new Error("Utility model returned an empty response.");
  return text;
}

async function compactContextForTask(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  task: string,
  signal: AbortSignal | undefined,
): Promise<{ summary: string; fallback: boolean }> {
  throwIfAborted(signal);
  const built = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
  // The current turn contains the user's orchestration request and this
  // subagent tool call. The delegated task is supplied separately; including
  // this turn in the seed can make a child recursively repeat orchestration.
  const parentMessages = excludeCurrentDelegationTurn(built.messages);
  if (parentMessages.length === 0) return { summary: "", fallback: false };

  const sessionManager = SessionManager.inMemory(ctx.cwd);
  for (const message of parentMessages) {
    if (message.role === "branchSummary" || message.role === "compactionSummary") {
      sessionManager.appendCustomMessageEntry("subagent-context-summary", message.summary, false);
    } else {
      sessionManager.appendMessage(message);
    }
  }
  // Pi compaction retains a recent boundary. A synthetic final boundary lets the
  // compactor summarize all real parent messages even when the parent is small.
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Compaction boundary for delegated work." }],
    timestamp: Date.now(),
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 8_192, keepRecentTokens: 1 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  let compactSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let abortCompaction: (() => void) | undefined;
  try {
    await resourceLoader.reload();
    throwIfAborted(signal);
    const created = await createAgentSession({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      ...(ctx.model ? { model: ctx.model } : {}),
      thinkingLevel: parentThinking(pi),
      modelRegistry: ctx.modelRegistry,
      resourceLoader,
      sessionManager,
      settingsManager,
      noTools: "all",
    });
    throwIfAborted(signal);
    compactSession = created.session;
    abortCompaction = () => compactSession?.abortCompaction();
    signal?.addEventListener("abort", abortCompaction, { once: true });
    const result = await compactSession.compact(
      `Create context specifically for this delegated task:\n\n${task}\n\nPreserve relevant user requirements, constraints, decisions and rationale, exact file paths and symbols, commands and results, repository state, unresolved questions, and failures. Omit unrelated discussion. Do not solve the task or add a persona.`,
    );
    throwIfAborted(signal);
    return { summary: result.summary, fallback: false };
  } catch (error) {
    if (signal?.aborted) throw error;
    // Context seeding is an optimization, not a launch dependency. Fail open
    // with a truly fresh child rather than forwarding an unreviewed raw transcript.
    return { summary: "", fallback: true };
  } finally {
    if (abortCompaction) signal?.removeEventListener("abort", abortCompaction);
    compactSession?.dispose();
  }
}

function resolveRequestedModel(
  ctx: ExtensionContext,
  request: string,
): { model?: PiModel; effort?: ThinkingLevel; error?: string } {
  const result = resolveCliModel({ cliModel: request, modelRegistry: ctx.modelRegistry });
  if (result.error || !result.model) return { error: result.error ?? `Model '${request}' was not found.` };
  const resolvedModel = result.model;
  const isAvailable = ctx.modelRegistry
    .getAvailable()
    .some((model) => model.provider === resolvedModel.provider && model.id === resolvedModel.id);
  if (!isAvailable) return { error: `Model '${request}' did not resolve to an available registry entry.` };
  if (!ctx.modelRegistry.hasConfiguredAuth(resolvedModel)) {
    return { error: `Model '${resolvedModel.provider}/${resolvedModel.id}' is not authenticated.` };
  }
  return {
    model: resolvedModel,
    ...(result.thinkingLevel && THINKING_LEVELS.includes(result.thinkingLevel) ? { effort: result.thinkingLevel } : {}),
  };
}

function parentFallback(pi: ExtensionAPI, ctx: ExtensionContext): Selection {
  if (!ctx.model) throw new Error("Cannot create a subagent because the parent has no selected model.");
  return {
    model: ctx.model,
    effort: clampThinkingLevel(parentThinking(pi), ctx.model),
    source: "fallback",
  };
}

// Model routing deliberately keeps explicit, classified, and fallback paths together.
// eslint-disable-next-line sonarjs/cognitive-complexity
async function selectModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  task: string,
  contextSummary: string,
  explicitModel?: string,
  explicitEffort?: ThinkingLevel,
  signal?: AbortSignal,
): Promise<Selection> {
  throwIfAborted(signal);
  let requestedModel: PiModel | undefined;
  let suffixEffort: ThinkingLevel | undefined;
  if (explicitModel) {
    const resolved = resolveRequestedModel(ctx, explicitModel);
    if (!resolved.model) throw new Error(resolved.error);
    requestedModel = resolved.model;
    suffixEffort = resolved.effort;
  }
  const requestedEffort = explicitEffort ?? suffixEffort;
  if (requestedModel && requestedEffort) {
    return {
      model: requestedModel,
      effort: clampThinkingLevel(requestedEffort, requestedModel),
      source: "explicit",
    };
  }

  const available = ctx.modelRegistry.getAvailable();
  if (available.length === 0) return parentFallback(pi, ctx);
  const catalog = formatModelCatalog(available);
  const fixedChoice = [
    requestedModel ? `model=${requestedModel.provider}/${requestedModel.id}` : undefined,
    requestedEffort ? `effort=${requestedEffort}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const classifierPrompt = `Classify the difficulty and complexity of a delegated coding-agent task, then choose the best authenticated model and reasoning effort from the exact catalog below. Balance capability, reliability, context needs, latency, and cost. Hard architecture, debugging, security, or broad implementation work generally deserves a stronger model and higher effort; simple lookups and mechanical edits do not. ${fixedChoice ? `The user fixed ${fixedChoice}; preserve those values and classify only what is missing. ` : ""}Return one JSON object only: {"model":"provider/id","effort":"off|minimal|low|medium|high|xhigh|max","rationale":"one short sentence"}.

Task:
${task}

Task-targeted context the child will receive:
${truncateMiddle(contextSummary, MAX_CLASSIFIER_CONTEXT_CHARS)}

Available authenticated models:
${catalog}`;
  try {
    const raw = await utilityCompletion(pi, ctx, classifierPrompt, 1_024, signal);
    throwIfAborted(signal);
    const decision = parseClassifierDecision(raw);
    if (!decision) throw new Error("Classifier did not return valid JSON.");
    let model = requestedModel;
    if (!model) {
      const classified = resolveRequestedModel(ctx, decision.model);
      if (!classified.model) throw new Error(classified.error);
      model = classified.model;
    }
    const effort = requestedEffort ?? decision.effort;
    return {
      model,
      effort: clampThinkingLevel(effort, model),
      source: "classified",
      ...(decision.rationale ? { rationale: decision.rationale } : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    const fallback = parentFallback(pi, ctx);
    const model = requestedModel ?? fallback.model;
    const effort = requestedEffort ?? fallback.effort;
    return {
      model,
      effort: clampThinkingLevel(effort, model),
      source: "fallback",
      rationale: `Classifier unavailable; inherited parent settings (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}

function resolvePiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const executable = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function childEnvironment(depth: number, provider: string, apiKey?: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("PI_SUBAGENT_") &&
        !key.startsWith("PI_INTERCOM_") &&
        key !== AUTH_PROVIDER_ENV &&
        key !== AUTH_KEY_ENV,
    ),
  );
  env[DEPTH_ENV] = String(depth);
  if (apiKey) {
    env[AUTH_PROVIDER_ENV] = provider;
    env[AUTH_KEY_ENV] = apiKey;
  }
  return env;
}

function shortId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 10);
}

function childName(requested: string | undefined, id: string): string {
  const trimmed = requested?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : `subagent-${id}`;
}

function snapshotSummary(
  snapshot: ChildSnapshot,
): Omit<ChildSnapshot, "transcriptTail" | "stderr"> & { transcriptPreview?: string; stderrPreview?: string } {
  const { transcriptTail, stderr, ...rest } = snapshot;
  return {
    ...rest,
    ...(transcriptTail.trim() ? { transcriptPreview: truncateMiddle(transcriptTail.trim(), 1_000) } : {}),
    ...(stderr ? { stderrPreview: truncateMiddle(stderr, 500) } : {}),
  };
}

function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

// Status formatting conditionally includes every independently optional field.
// eslint-disable-next-line sonarjs/cognitive-complexity
function formatSnapshot(snapshot: ChildSnapshot): string {
  const age = Math.max(0, Math.round((Date.now() - snapshot.startedAt) / 1000));
  const lines = [
    `Subagent ${snapshot.id} (${truncateMiddle(snapshot.name, 200)})`,
    `state=${snapshot.state} model=${snapshot.model} effort=${snapshot.effort} age=${String(age)}s turns=${String(snapshot.turns)} tools=${String(snapshot.toolCalls)} queued=${String(snapshot.pendingMessages)}`,
    `selection=${snapshot.classification}${snapshot.classificationRationale ? ` — ${snapshot.classificationRationale}` : ""}`,
    `task: ${truncateMiddle(snapshot.task, 4_000)}`,
  ];
  if (snapshot.currentTool) {
    lines.push(`current tool: ${snapshot.currentTool.name} ${snapshot.currentTool.argsPreview}`);
  }
  if (snapshot.stats) {
    const context = snapshot.stats.contextUsage
      ? ` context=${snapshot.stats.contextUsage.tokens === null ? "?" : formatTokenCount(snapshot.stats.contextUsage.tokens)}/${formatTokenCount(snapshot.stats.contextUsage.contextWindow)} (${snapshot.stats.contextUsage.percent === null ? "?" : `${snapshot.stats.contextUsage.percent.toFixed(1)}%`})`
      : "";
    lines.push(
      `usage: tokens=${formatTokenCount(snapshot.stats.tokens.total)} input=${formatTokenCount(snapshot.stats.tokens.input)} output=${formatTokenCount(snapshot.stats.tokens.output)} cost=$${snapshot.stats.cost.toFixed(4)}${context} compactions=${String(snapshot.compactions)}`,
    );
  } else if (snapshot.compactions > 0) {
    lines.push(`compactions=${String(snapshot.compactions)}`);
  }
  if (snapshot.sessionFile) lines.push(`session: ${snapshot.sessionFile}`);
  if (snapshot.error) lines.push(`error: ${snapshot.error}`);
  if (snapshot.stderr) lines.push(`stderr:\n${truncateMiddle(snapshot.stderr, 4_000)}`);
  if (snapshot.transcriptTail.trim())
    lines.push(`transcript tail:\n${truncateMiddle(snapshot.transcriptTail.trim(), MAX_STATUS_TEXT_CHARS)}`);
  else lines.push("transcript tail: (no output yet)");
  return lines.join("\n");
}

export default function subagentsExtension(pi: ExtensionAPI) {
  const children = new Map<string, ManagedSubagent>();
  let pendingCreates = 0;
  let shuttingDown = false;

  const assertCreationActive = () => {
    if (shuttingDown) throw new Error("Session shutdown interrupted subagent creation.");
  };

  const pruneChildren = () => {
    if (children.size <= MAX_RETAINED_CHILDREN) return;
    const removable = [...children.entries()]
      .filter(([, child]) => !child.isAlive())
      .sort((left, right) => left[1].snapshot().updatedAt - right[1].snapshot().updatedAt);
    for (const [id] of removable) {
      if (children.size <= MAX_RETAINED_CHILDREN) break;
      children.delete(id);
    }
  };

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Create and control isolated, asynchronous child Pi sessions. Use action=create whenever the user naturally asks to create a subagent, ask a subagent to do work, or delegate work. Preserve any user-requested model and effort. Creation task-compacts the current parent context for that task, automatically classifies model/effort when either is omitted, and returns immediately with an id. Use status to spy on a direct child's transcript and usage, wait only when the current request needs its result synchronously, steer to interrupt its direction at the next turn boundary, follow_up to queue later work, interrupt to abort the current operation while retaining the session, and stop to terminate it. Each process can see and control only children it created; child results never enter the parent context unless status or wait is explicitly requested.",
    promptSnippet:
      "Create, inspect, wait for, steer, queue messages for, interrupt, or stop isolated asynchronous child Pi sessions",
    promptGuidelines: [
      "Use subagent with action=create when the user asks in natural language to create, ask, launch, or delegate to a subagent; pass through any explicit model and reasoning effort.",
      "Use subagent status to inspect child work; use subagent wait only when this turn must consume the result. Child completion is intentionally not pushed into the parent conversation.",
    ],
    parameters: SubagentParameters,

    // This is a tagged action dispatcher; splitting it would obscure the shared ownership checks.
    // eslint-disable-next-line sonarjs/cognitive-complexity
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.action === "create") {
        pruneChildren();
        if (!params.task?.trim()) throw new Error("Creating a subagent requires a non-empty task.");
        assertCreationActive();
        const depth = currentDepth();
        if (depth >= MAX_DEPTH) throw new Error(`Subagent depth limit (${String(MAX_DEPTH)}) reached.`);
        const childLimit = depth === 0 ? MAX_ROOT_CHILDREN : MAX_NESTED_CHILDREN;
        // Count live OS processes, including one still exiting after failure.
        // Reserve a slot before the first await so parallel create tool calls
        // cannot bypass the cap.
        const active = [...children.values()].filter((child) => child.isAlive());
        if (active.length + pendingCreates >= childLimit) {
          throw new Error(
            `This session already has ${String(childLimit)} active or starting direct children; stop one before creating another.`,
          );
        }

        pendingCreates++;
        try {
          const task = params.task.trim();
          const compacted = await compactContextForTask(pi, ctx, task, signal);
          throwIfAborted(signal);
          assertCreationActive();
          const routingContext = truncateMiddle(compacted.summary, MAX_CLASSIFIER_CONTEXT_CHARS);
          const selection = await selectModel(pi, ctx, task, routingContext, params.model, params.effort, signal);
          throwIfAborted(signal);
          assertCreationActive();
          // ExtensionContext exposes models as Model<any>, while the registry accepts Model<Api>.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          const childAuth = await ctx.modelRegistry.getApiKeyAndHeaders(selection.model);
          throwIfAborted(signal);
          if (!childAuth.ok) throw new Error(`Could not resolve child model auth: ${childAuth.error}`);
          const id = shortId();
          const name = childName(params.name, id);
          const existingSessionId = ctx.sessionManager.getSessionId();
          const parentSessionId = existingSessionId ? existingSessionId : "ephemeral";
          const sessionDir = join(getAgentDir(), "subagents", parentSessionId, id);
          await mkdir(sessionDir, { recursive: true, mode: 0o700 });
          throwIfAborted(signal);
          assertCreationActive();
          const args = [
            "--mode",
            "rpc",
            "--session-dir",
            sessionDir,
            "--name",
            name,
            "--model",
            `${selection.model.provider}/${selection.model.id}`,
            "--thinking",
            selection.effort,
            "--extension",
            SELF_EXTENSION_PATH,
            "--extension",
            AUTH_BRIDGE_PATH,
            ctx.isProjectTrusted() ? "--approve" : "--no-approve",
          ];
          const invocation = resolvePiInvocation(args);
          throwIfAborted(signal);
          const child = new ManagedSubagent({
            id,
            name,
            task,
            model: `${selection.model.provider}/${selection.model.id}`,
            effort: selection.effort,
            contextSummary: boundContextForModel(routingContext, task, selection.model, MAX_CLASSIFIER_CONTEXT_CHARS),
            cwd: ctx.cwd,
            command: invocation.command,
            args: invocation.args,
            env: childEnvironment(depth + 1, selection.model.provider, childAuth.apiKey),
            ownsProcessGroup: depth === 0,
            classification: selection.source,
            ...(selection.rationale ? { classificationRationale: selection.rationale } : {}),
          });
          throwIfAborted(signal);
          children.set(id, child);
          try {
            throwIfAborted(signal);
            await child.start();
            throwIfAborted(signal);
            assertCreationActive();
          } catch (error) {
            await child.stop();
            throw error;
          }
          const warning = compacted.fallback
            ? " Targeted compaction failed open, so the child started with fresh context."
            : "";
          return {
            content: [
              {
                type: "text",
                text: `Created ${id} (${name}) with ${selection.model.provider}/${selection.model.id} at ${selection.effort} effort.${warning} It is running asynchronously; use subagent status with id=${id} to spy, or wait only when this turn needs the result.`,
              },
            ],
            details: {
              action: "create",
              child: snapshotSummary(child.snapshot()),
              compactionFallback: compacted.fallback,
            },
          };
        } finally {
          pendingCreates--;
        }
      }

      if (params.action === "list") {
        pruneChildren();
        const snapshots = [...children.values()].map((child) => snapshotSummary(child.snapshot()));
        const text = snapshots.length
          ? snapshots
              .map(
                (child) =>
                  `${child.id} ${child.state} ${child.model} ${child.effort} — ${truncateMiddle(child.task, 500)}`,
              )
              .join("\n")
          : "No direct subagents have been created by this session.";
        return { content: [{ type: "text", text }], details: { action: "list", children: snapshots } };
      }

      if (!params.id) throw new Error(`${params.action} requires a direct child id.`);
      const child = children.get(params.id);
      if (!child)
        throw new Error(
          `Unknown direct child '${params.id}'. Use subagent list to see children owned by this session.`,
        );

      if (params.action === "status") {
        await child.refresh();
        const snapshot = child.snapshot();
        return {
          content: [{ type: "text", text: formatSnapshot(snapshot) }],
          details: { action: "status", child: snapshot },
        };
      }
      if (params.action === "wait") {
        const settled = await child.waitForIdle(params.timeoutMs ?? 120_000, signal);
        await child.refresh();
        const snapshot = child.snapshot();
        const heading = settled
          ? `Subagent ${params.id} settled.`
          : `Wait timed out; subagent ${params.id} is still active.`;
        return {
          content: [{ type: "text", text: `${heading}\n\n${formatSnapshot(snapshot)}` }],
          details: { action: "wait", settled, child: snapshot },
        };
      }
      if (params.action === "steer" || params.action === "follow_up") {
        if (!params.task?.trim()) throw new Error(`${params.action} requires a non-empty task/message.`);
        if (params.action === "steer") await child.steer(params.task.trim());
        else await child.followUp(params.task.trim());
        return {
          content: [
            { type: "text", text: `${params.action === "steer" ? "Steered" : "Queued a follow-up for"} ${params.id}.` },
          ],
          details: { action: params.action, child: snapshotSummary(child.snapshot()) },
        };
      }
      if (params.action === "interrupt") {
        await child.interrupt();
        return {
          content: [
            {
              type: "text",
              text: `Interrupted ${params.id}; its isolated session remains available for steering or follow-up.`,
            },
          ],
          details: { action: "interrupt", child: snapshotSummary(child.snapshot()) },
        };
      }
      await child.stop();
      const stoppedSnapshot = snapshotSummary(child.snapshot());
      pruneChildren();
      return {
        content: [{ type: "text", text: `Stopped ${params.id}.` }],
        details: { action: "stop", child: stoppedSnapshot },
      };
    },

    renderCall(args, theme) {
      const target = args.id ? ` ${args.id}` : args.name ? ` ${args.name}` : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.action)}${theme.fg("muted", target)}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const content = result.content.find((entry) => entry.type === "text");
      return new Text(theme.fg("toolOutput", content?.type === "text" ? content.text : "(no output)"), 0, 0);
    },
  });

  pi.on("session_shutdown", async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.allSettled([...children.values()].map((child) => child.stop()));
    children.clear();
  });
}
