import { execFile, execFileSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { extractTextContent, appendBoundedTail } from "./helpers.ts";
import type { ThinkingLevel } from "./helpers.ts";

const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_STDERR_CHARS = 64_000;
const REQUEST_TIMEOUT_MS = 30_000;
const FORCE_KILL_DELAY_MS = 3_000;

function processListInvocation(): { command: string; args: string[]; timeout: number } {
  return process.platform === "win32"
    ? {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId,$_.ParentProcessId }",
        ],
        timeout: 3_000,
      }
    : { command: "ps", args: ["-axo", "pid=,ppid="], timeout: 1_000 };
}

function parseProcessTree(rootPid: number, output: string): number[] {
  const children = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    const match = /^(\d+)\s+(\d+)$/.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }
  const result: number[] = [];
  const visit = (pid: number) => {
    for (const child of children.get(pid) ?? []) visit(child);
    result.push(pid);
  };
  visit(rootPid);
  return result;
}

function processTreePids(rootPid: number): number[] {
  try {
    const invocation = processListInvocation();
    const output = execFileSync(invocation.command, invocation.args, {
      encoding: "utf8",
      timeout: invocation.timeout,
    });
    return parseProcessTree(rootPid, output);
  } catch {
    return [rootPid];
  }
}

type TreeWatcher = { rootPid: number; onResult: (pids: number[]) => void };

const treeWatchers = new Set<TreeWatcher>();
let treeSampleTimer: NodeJS.Timeout | undefined;
let treeSampleInFlight = false;

function sampleWatchedTrees(): void {
  if (treeSampleInFlight || treeWatchers.size === 0) return;
  treeSampleInFlight = true;
  const invocation = processListInvocation();
  execFile(
    invocation.command,
    invocation.args,
    {
      encoding: "utf8",
      timeout: invocation.timeout,
    },
    (error, stdout) => {
      treeSampleInFlight = false;
      for (const watcher of treeWatchers) {
        watcher.onResult(error ? [watcher.rootPid] : parseProcessTree(watcher.rootPid, stdout));
      }
    },
  );
}

function watchProcessTree(rootPid: number, onResult: (pids: number[]) => void): () => void {
  const watcher = { rootPid, onResult };
  treeWatchers.add(watcher);
  sampleWatchedTrees();
  if (!treeSampleTimer) {
    treeSampleTimer = setInterval(sampleWatchedTrees, process.platform === "win32" ? 2_000 : 250);
    treeSampleTimer.unref();
  }
  return () => {
    treeWatchers.delete(watcher);
    if (treeWatchers.size === 0 && treeSampleTimer) {
      clearInterval(treeSampleTimer);
      treeSampleTimer = undefined;
    }
  };
}

export type ChildState = "starting" | "running" | "idle" | "interrupting" | "stopped" | "failed";

export type ChildLaunchOptions = {
  id: string;
  name: string;
  task: string;
  model: string;
  effort: ThinkingLevel;
  contextSummary: string;
  cwd: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  ownsProcessGroup?: boolean;
  classification: "explicit" | "classified" | "fallback";
  classificationRationale?: string;
};

export type ChildSessionStats = {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
};

function displayString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseSessionStats(value: unknown): ChildSessionStats | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (!input.tokens || typeof input.tokens !== "object" || Array.isArray(input.tokens)) return undefined;
  const rawTokens = input.tokens as Record<string, unknown>;
  const tokens = {
    input: finiteNumber(rawTokens.input),
    output: finiteNumber(rawTokens.output),
    cacheRead: finiteNumber(rawTokens.cacheRead),
    cacheWrite: finiteNumber(rawTokens.cacheWrite),
    total: finiteNumber(rawTokens.total),
  };
  if (tokens.total === 0) tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  let contextUsage: ChildSessionStats["contextUsage"];
  if (input.contextUsage && typeof input.contextUsage === "object" && !Array.isArray(input.contextUsage)) {
    const rawContext = input.contextUsage as Record<string, unknown>;
    const contextWindow = finiteNumber(rawContext.contextWindow);
    if (contextWindow > 0) {
      contextUsage = {
        tokens: rawContext.tokens === null ? null : finiteNumber(rawContext.tokens),
        contextWindow,
        percent: rawContext.percent === null ? null : finiteNumber(rawContext.percent),
      };
    }
  }
  return {
    tokens,
    cost: finiteNumber(input.cost),
    ...(contextUsage ? { contextUsage } : {}),
  };
}

export type ChildSnapshot = {
  id: string;
  name: string;
  task: string;
  state: ChildState;
  model: string;
  effort: ThinkingLevel;
  classification: ChildLaunchOptions["classification"];
  classificationRationale?: string;
  pid?: number;
  startedAt: number;
  updatedAt: number;
  turns: number;
  toolCalls: number;
  currentTool?: { name: string; argsPreview: string; startedAt: number };
  pendingMessages: number;
  compactions: number;
  stats?: ChildSessionStats;
  sessionFile?: string;
  lastAssistantText?: string;
  transcriptTail: string;
  stderr?: string;
  error?: string;
};

export function buildKickoffPrompt(task: string, contextSummary: string): string {
  const compacted = contextSummary.trim();
  return compacted
    ? [
        "Task-targeted compacted context from the requesting session:",
        "<context>",
        compacted,
        "</context>",
        "",
        "Task:",
        task,
      ].join("\n")
    : `Task:\n${task}`;
}

type PendingRequest = {
  command: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class ManagedSubagent {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly model: string;
  readonly effort: ThinkingLevel;
  readonly classification: ChildLaunchOptions["classification"];
  readonly classificationRationale: string | undefined;
  readonly startedAt = Date.now();

  private readonly proc: ChildProcessWithoutNullStreams;
  private state: ChildState = "starting";
  private updatedAt = Date.now();
  private transcript = "";
  private stderr = "";
  private error: string | undefined;
  private lastAssistantText: string | undefined;
  private sessionFile: string | undefined;
  private pendingMessages = 0;
  private turns = 0;
  private toolCalls = 0;
  private activeTools = new Map<string, NonNullable<ChildSnapshot["currentTool"]>>();
  private compactions = 0;
  private stats: ChildSessionStats | undefined;
  private requestSequence = 0;
  private pending = new Map<string, PendingRequest>();
  private stdoutBytes = 0;
  private stdoutLine = "";
  private stoppedIntentionally = false;
  private terminationStarted = false;
  private killTimer: NodeJS.Timeout | undefined;
  private stopTreeMonitor: (() => void) | undefined;
  private terminationPoll: NodeJS.Timeout | undefined;
  private terminationPids: number[] = [];
  private windowsKillersInFlight = 0;
  private terminationDone: Promise<void> = Promise.resolve();
  private resolveTermination: (() => void) | undefined;
  private controlTail: Promise<void> = Promise.resolve();
  private readonly options: ChildLaunchOptions;

  constructor(options: ChildLaunchOptions) {
    this.options = options;
    this.id = options.id;
    this.name = options.name;
    this.task = options.task;
    this.model = options.model;
    this.effort = options.effort;
    this.classification = options.classification;
    this.classificationRationale = options.classificationRationale;
    this.proc = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // Root children own a Unix process group for whole-tree cleanup. Nested
      // children stay in that group so a root crash cannot orphan their groups.
      detached: process.platform !== "win32" && options.ownsProcessGroup !== false,
    });
    // spawn() has copied the environment; do not retain runtime credentials in
    // the long-lived management object.
    delete options.env.PI_SIMPLE_SUBAGENT_API_KEY;
    delete options.env.PI_SIMPLE_SUBAGENT_AUTH_PROVIDER;
    this.attachStreams();
    const childPid = this.proc.pid;
    if (childPid) {
      this.stopTreeMonitor = watchProcessTree(childPid, (current) => {
        // Keep only the latest verified tree during normal operation. Once
        // termination begins, freeze it for completion tracking; force-kill uses
        // the Unix process group or a freshly verified descendant tree instead.
        if (!this.terminationStarted) this.terminationPids = current;
      });
    }
  }

  async start(): Promise<void> {
    await this.request({ type: "prompt", message: buildKickoffPrompt(this.task, this.options.contextSummary) });
    if (this.state === "starting") this.state = "running";
    this.touch();
  }

  steer(message: string): Promise<void> {
    return this.serializeControl(async () => {
      this.assertControllable();
      if (this.state === "running" || this.state === "interrupting") {
        await this.request({ type: "steer", message });
      } else {
        await this.request({ type: "prompt", message });
        this.state = "running";
      }
      this.touch();
    });
  }

  followUp(message: string): Promise<void> {
    return this.serializeControl(async () => {
      this.assertControllable();
      if (this.state === "running" || this.state === "interrupting") {
        await this.request({ type: "follow_up", message });
      } else {
        await this.request({ type: "prompt", message });
        this.state = "running";
      }
      this.touch();
    });
  }

  interrupt(): Promise<void> {
    return this.serializeControl(async () => {
      this.assertControllable();
      if (this.state === "idle") return;
      const previousState = this.state;
      this.state = "interrupting";
      this.touch();
      try {
        await this.request({ type: "abort" });
        // RPC abort is also valid while the session is already settling, in
        // which case no later agent_settled event is guaranteed.
        this.finishInterrupt();
      } catch (error) {
        this.restoreInterrupt(previousState);
        throw error;
      } finally {
        this.touch();
      }
    });
  }

  refresh(): Promise<void> {
    return this.serializeControl(async () => {
      if (this.state === "stopped" || this.state === "failed") return;
      try {
        const response = await this.request({ type: "get_state" }, 3_000);
        const data = response.data as Record<string, unknown> | undefined;
        if (data) {
          this.pendingMessages =
            typeof data.pendingMessageCount === "number" ? data.pendingMessageCount : this.pendingMessages;
          this.sessionFile = typeof data.sessionFile === "string" ? data.sessionFile : this.sessionFile;
          if (data.isStreaming === true) this.state = "running";
          else if (this.state !== "starting") this.state = "idle";
        }
      } catch {
        // Cached state remains useful if a refresh races process shutdown.
      }
      try {
        const response = await this.request({ type: "get_session_stats" }, 3_000);
        const parsed = parseSessionStats(response.data);
        if (parsed) this.stats = parsed;
      } catch {
        // Older/custom RPC implementations may not expose stats.
      }
      this.touch();
    });
  }

  waitForIdle(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.isSettled()) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (settled: boolean) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        resolve(settled);
      };
      const onAbort = () => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        const error = new Error("Subagent wait was aborted; the child is still running.");
        error.name = "AbortError";
        reject(error);
      };
      const poll = setInterval(() => {
        if (this.isSettled()) finish(true);
      }, 50);
      const timeout = setTimeout(() => {
        finish(this.isSettled());
      }, timeoutMs);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  stop(): Promise<void> {
    if (this.state !== "stopped") {
      // Stop is intentionally not queued behind steering/status RPC. It is the
      // authoritative escape hatch and must terminate even if a request hangs.
      this.stoppedIntentionally = true;
      this.state = "stopped";
      this.touch();
      this.rejectPending(new Error(`Subagent ${this.id} was stopped.`));
      this.terminateProcess();
    }
    return this.terminationDone;
  }

  isAlive(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  snapshot(): ChildSnapshot {
    const currentTool = [...this.activeTools.values()].sort((left, right) => right.startedAt - left.startedAt)[0];
    return {
      id: this.id,
      name: this.name,
      task: this.task,
      state: this.state,
      model: this.model,
      effort: this.effort,
      classification: this.classification,
      ...(this.classificationRationale ? { classificationRationale: this.classificationRationale } : {}),
      ...(this.proc.pid ? { pid: this.proc.pid } : {}),
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      turns: this.turns,
      toolCalls: this.toolCalls,
      ...(currentTool ? { currentTool: { ...currentTool } } : {}),
      pendingMessages: this.pendingMessages,
      compactions: this.compactions,
      ...(this.stats ? { stats: this.stats } : {}),
      ...(this.sessionFile ? { sessionFile: this.sessionFile } : {}),
      ...(this.lastAssistantText ? { lastAssistantText: this.lastAssistantText } : {}),
      transcriptTail: this.transcript,
      ...(this.stderr.trim() ? { stderr: this.stderr.trim() } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private serializeControl<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.controlTail.then(operation, operation);
    this.controlTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private isSettled(): boolean {
    return this.state === "failed" || this.state === "stopped" || (this.state === "idle" && this.pendingMessages === 0);
  }

  private finishInterrupt(): void {
    if (this.state === "interrupting") this.state = "idle";
  }

  private restoreInterrupt(previousState: ChildState): void {
    if (this.state === "interrupting") this.state = previousState;
  }

  private assertControllable(): void {
    if (this.state === "stopped" || this.state === "failed") {
      throw new Error(`Subagent ${this.id} is ${this.state} and cannot accept messages.`);
    }
  }

  private touch(): void {
    this.updatedAt = Date.now();
  }

  private appendTranscript(text: string): void {
    this.transcript = appendBoundedTail(this.transcript, text, MAX_TRANSCRIPT_CHARS);
    this.touch();
  }

  private request(command: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (this.proc.stdin.destroyed || this.proc.exitCode !== null) {
      return Promise.reject(new Error(`Subagent ${this.id} process is not running.`));
    }
    const id = `${this.id}-${String(++this.requestSequence)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for subagent RPC command ${String(command.type)}.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { command: String(command.type), resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private attachStreams(): void {
    const decoder = new StringDecoder("utf8");
    let stdoutRejected = false;
    const rejectOversizedOutput = () => {
      stdoutRejected = true;
      this.stdoutLine = "";
      this.stdoutBytes = 0;
      this.proc.stdout.destroy();
      this.fail("Child RPC output exceeded the 4 MiB JSONL line limit.");
      this.terminateProcess();
    };
    this.proc.stdout.on("data", (chunk: Buffer) => {
      if (stdoutRejected) return;
      const text = decoder.write(chunk);
      let start = 0;
      for (;;) {
        const newline = text.indexOf("\n", start);
        if (newline === -1) break;
        const segment = text.slice(start, newline);
        if (this.stdoutBytes + Buffer.byteLength(segment) > MAX_JSONL_LINE_BYTES) {
          rejectOversizedOutput();
          return;
        }
        const combined = this.stdoutLine + segment;
        const line = combined.endsWith("\r") ? combined.slice(0, -1) : combined;
        this.stdoutLine = "";
        this.stdoutBytes = 0;
        if (line) this.handleLine(line);
        start = newline + 1;
      }
      const remainder = text.slice(start);
      this.stdoutLine += remainder;
      this.stdoutBytes += Buffer.byteLength(remainder);
      if (this.stdoutBytes > MAX_JSONL_LINE_BYTES) rejectOversizedOutput();
    });
    this.proc.stdout.on("end", () => {
      if (stdoutRejected) return;
      const final = this.stdoutLine + decoder.end();
      if (final.trim()) this.handleLine(final.endsWith("\r") ? final.slice(0, -1) : final);
    });
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.stderr = appendBoundedTail(this.stderr, chunk.toString("utf8"), MAX_STDERR_CHARS);
      this.touch();
    });
    this.proc.on("error", (error) => {
      this.fail(error.message);
    });
    this.proc.on("close", (code, signal) => {
      this.stopTreeMonitor?.();
      this.stopTreeMonitor = undefined;
      if (this.stoppedIntentionally) this.state = "stopped";
      else {
        if (this.state !== "failed") this.fail(`Child process exited (${String(signal ?? code ?? "unknown")}).`);
        // The root may have crashed while tools or recursively-created children
        // were still alive. Sweep the process tree observed during its lifetime.
        this.terminateProcess();
      }
      this.rejectPending(new Error(this.error ?? "Subagent process closed."));
      this.touch();
    });
    this.proc.stdin.on("error", () => {
      // Pending requests and process close report actionable errors.
    });
  }

  // RPC lines may be responses, UI requests, or asynchronous session events.
  // eslint-disable-next-line sonarjs/cognitive-complexity
  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.appendTranscript(`\n[rpc parse error] ${line.slice(0, 500)}\n`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.appendTranscript(`\n[rpc protocol error] expected an object\n`);
      return;
    }
    const event = parsed as Record<string, unknown>;
    if (event.type === "response" && typeof event.id === "string") {
      const pending = this.pending.get(event.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(event.id);
      if (event.success === false)
        pending.reject(new Error(typeof event.error === "string" ? event.error : `${pending.command} failed.`));
      else pending.resolve(event);
      return;
    }
    if (event.type === "extension_ui_request" && typeof event.id === "string") {
      const method = event.method;
      if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
        this.proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
        this.appendTranscript(`\n[extension dialog cancelled: ${method}]\n`);
      }
      return;
    }
    this.handleEvent(event);
  }

  // Keep the wire protocol's event variants visible in one exhaustive dispatcher.
  // eslint-disable-next-line sonarjs/cognitive-complexity
  private handleEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case "agent_start":
        this.state = "running";
        break;
      case "agent_settled":
        this.activeTools.clear();
        if (this.state !== "failed" && this.state !== "stopped") this.state = "idle";
        break;
      case "turn_end":
        this.turns++;
        break;
      case "queue_update": {
        const steering = Array.isArray(event.steering) ? event.steering.length : 0;
        const followUp = Array.isArray(event.followUp) ? event.followUp.length : 0;
        this.pendingMessages = steering + followUp;
        break;
      }
      case "message_update": {
        const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.delta === "string") this.appendTranscript(delta.delta);
        break;
      }
      case "message_end": {
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.role === "assistant") {
          const text = extractTextContent(message.content);
          if (text) this.lastAssistantText = appendBoundedTail("", text, MAX_TRANSCRIPT_CHARS);
          if (message.stopReason === "error") {
            this.fail(
              typeof message.errorMessage === "string" ? message.errorMessage : "Child model returned an error.",
            );
            this.terminateProcess();
          }
        }
        break;
      }
      case "tool_execution_start": {
        const name = displayString(event.toolName, "tool");
        const argsPreview = JSON.stringify(event.args ?? {}).slice(0, 500);
        const startedAt = Date.now();
        const key =
          typeof event.toolCallId === "string"
            ? event.toolCallId
            : `${name}:${String(startedAt)}:${String(this.toolCalls)}`;
        this.toolCalls++;
        this.activeTools.set(key, { name, argsPreview, startedAt });
        this.appendTranscript(`\n→ ${name} ${argsPreview}\n`);
        break;
      }
      case "tool_execution_end": {
        if (typeof event.toolCallId === "string") this.activeTools.delete(event.toolCallId);
        else {
          const name = displayString(event.toolName, "tool");
          for (const [key, tool] of this.activeTools) {
            if (tool.name === name) this.activeTools.delete(key);
          }
        }
        this.appendTranscript(
          `\n← ${displayString(event.toolName, "tool")}${event.isError === true ? " (error)" : ""}\n`,
        );
        break;
      }
      case "compaction_end":
        if (event.aborted !== true && event.result) this.compactions++;
        break;
      case "extension_error":
        this.appendTranscript(`\n[extension error] ${displayString(event.error, "unknown")}\n`);
        break;
    }
    this.touch();
  }

  private fail(message: string): void {
    this.state = "failed";
    this.error = message;
    this.touch();
  }

  private terminateProcess(): void {
    if (this.terminationStarted) return;
    const pid = this.proc.pid;
    if (!pid) return;
    this.terminationStarted = true;
    this.stopTreeMonitor?.();
    this.stopTreeMonitor = undefined;
    this.terminationDone = new Promise((resolve) => {
      this.resolveTermination = resolve;
    });
    this.signalProcessTree("SIGTERM", false);
    const finish = () => {
      if (this.terminationPoll) clearInterval(this.terminationPoll);
      if (this.killTimer) clearTimeout(this.killTimer);
      this.terminationPoll = undefined;
      this.killTimer = undefined;
      this.resolveTermination?.();
      this.resolveTermination = undefined;
    };
    this.terminationPoll = setInterval(() => {
      const treeDead = this.terminationPids.every((target) => !this.pidIsAlive(target));
      const windowsDone = process.platform !== "win32" || this.windowsKillersInFlight === 0;
      if (treeDead && windowsDone) finish();
    }, 50);
    this.killTimer = setTimeout(() => {
      this.signalProcessTree("SIGKILL", true);
      setTimeout(finish, 100);
    }, FORCE_KILL_DELAY_MS);
  }

  private pidIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private signalProcessTree(signal: NodeJS.Signals, force: boolean): void {
    const pid = this.proc.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      const currentTree = processTreePids(pid);
      this.terminationPids = [...new Set([...this.terminationPids, ...currentTree])];
      // A cached PID may have been reused after SIGTERM. taskkill only targets
      // the root and descendants whose ancestry was verified in this sample.
      for (const target of currentTree) {
        this.windowsKillersInFlight++;
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          this.windowsKillersInFlight = Math.max(0, this.windowsKillersInFlight - 1);
        };
        const killer = spawn("taskkill", ["/PID", String(target), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore" });
        killer.on("close", settle);
        killer.on("error", settle);
        killer.unref();
      }
      return;
    }
    if (this.options.ownsProcessGroup !== false) {
      try {
        process.kill(-pid, signal);
      } catch {
        // The group may already be gone; known nested groups are handled below.
      }
    }
    const currentTree = processTreePids(pid);
    if (!force) this.terminationPids = [...new Set([...this.terminationPids, ...currentTree])];
    // The owned process group catches descendants that were reparented when the
    // root exited. Individually signal only freshly verified descendants so a
    // stale cached numeric PID can never receive SIGKILL.
    for (const target of currentTree) {
      try {
        process.kill(target, signal);
      } catch {
        // Continue best-effort through the rest of the tree.
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
