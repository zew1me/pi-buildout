import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { extractTextContent, appendBoundedTail, type ThinkingLevel } from "./helpers.ts";

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
		const match = line.trim().match(/^(\d+)\s+(\d+)$/);
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

function processTreePidsAsync(rootPid: number, onResult: (pids: number[]) => void): void {
	const invocation = processListInvocation();
	execFile(invocation.command, invocation.args, {
		encoding: "utf8",
		timeout: invocation.timeout,
	}, (error, stdout) => {
		onResult(error ? [rootPid] : parseProcessTree(rootPid, stdout));
	});
}

export type ChildState = "starting" | "running" | "idle" | "interrupting" | "stopped" | "failed";

export interface ChildLaunchOptions {
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
}

export interface ChildSnapshot {
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
	pendingMessages: number;
	sessionFile?: string;
	lastAssistantText?: string;
	transcriptTail: string;
	stderr?: string;
	error?: string;
}

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

interface PendingRequest {
	command: string;
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class ManagedSubagent {
	readonly id: string;
	readonly name: string;
	readonly task: string;
	readonly model: string;
	readonly effort: ThinkingLevel;
	readonly classification: ChildLaunchOptions["classification"];
	readonly classificationRationale?: string;
	readonly startedAt = Date.now();

	private readonly proc: ChildProcessWithoutNullStreams;
	private state: ChildState = "starting";
	private updatedAt = Date.now();
	private transcript = "";
	private stderr = "";
	private error?: string;
	private lastAssistantText?: string;
	private sessionFile?: string;
	private pendingMessages = 0;
	private turns = 0;
	private toolCalls = 0;
	private requestSequence = 0;
	private pending = new Map<string, PendingRequest>();
	private stdoutBytes = 0;
	private stdoutLine = "";
	private stoppedIntentionally = false;
	private killTimer?: NodeJS.Timeout;
	private treeMonitor?: NodeJS.Timeout;
	private terminationPoll?: NodeJS.Timeout;
	private terminationPids: number[] = [];
	private windowsKillersInFlight = 0;
	private terminationDone: Promise<void> = Promise.resolve();
	private resolveTermination?: () => void;
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
		if (this.proc.pid) {
			let listingInFlight = false;
			const rememberTree = () => {
				if (listingInFlight) return;
				listingInFlight = true;
				processTreePidsAsync(this.proc.pid!, (current) => {
					listingInFlight = false;
					this.terminationPids = [...new Set([...this.terminationPids, ...current])];
				});
			};
			rememberTree();
			this.treeMonitor = setInterval(rememberTree, process.platform === "win32" ? 2_000 : 250);
			this.treeMonitor.unref();
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
			this.state = "interrupting";
			this.touch();
			await this.request({ type: "abort" });
			// RPC abort is also valid while the session is already settling, in
			// which case no later agent_settled event is guaranteed.
			if (this.state === "interrupting") this.state = "idle";
			this.touch();
		});
	}

	refresh(): Promise<void> {
		return this.serializeControl(async () => {
			if (this.state === "stopped" || this.state === "failed") return;
			try {
				const response = await this.request({ type: "get_state" }, 3_000);
				const data = response.data as Record<string, unknown> | undefined;
				if (!data) return;
				this.pendingMessages = typeof data.pendingMessageCount === "number" ? data.pendingMessageCount : this.pendingMessages;
				this.sessionFile = typeof data.sessionFile === "string" ? data.sessionFile : this.sessionFile;
				if (data.isStreaming === true) this.state = "running";
				else if (this.state !== "starting") this.state = "idle";
				this.touch();
			} catch {
				// Cached state remains useful if a refresh races process shutdown.
			}
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
			pendingMessages: this.pendingMessages,
			...(this.sessionFile ? { sessionFile: this.sessionFile } : {}),
			...(this.lastAssistantText ? { lastAssistantText: this.lastAssistantText } : {}),
			transcriptTail: this.transcript,
			...(this.stderr.trim() ? { stderr: this.stderr.trim() } : {}),
			...(this.error ? { error: this.error } : {}),
		};
	}

	private serializeControl<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.controlTail.then(operation, operation);
		this.controlTail = run.then(() => undefined, () => undefined);
		return run;
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
		const id = `${this.id}-${++this.requestSequence}`;
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
		this.proc.stdout.on("data", (chunk: Buffer) => {
			const text = decoder.write(chunk);
			let start = 0;
			for (;;) {
				const newline = text.indexOf("\n", start);
				if (newline === -1) break;
				const segment = text.slice(start, newline);
				if (this.stdoutBytes + Buffer.byteLength(segment) > MAX_JSONL_LINE_BYTES) {
					this.fail("Child RPC output exceeded the 4 MiB JSONL line limit.");
					this.terminateProcess();
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
			if (this.stdoutBytes > MAX_JSONL_LINE_BYTES) {
				this.fail("Child RPC output exceeded the 4 MiB JSONL line limit.");
				this.terminateProcess();
			}
		});
		this.proc.stdout.on("end", () => {
			const final = this.stdoutLine + decoder.end();
			if (final.trim()) this.handleLine(final.endsWith("\r") ? final.slice(0, -1) : final);
		});
		this.proc.stderr.on("data", (chunk: Buffer) => {
			this.stderr = appendBoundedTail(this.stderr, chunk.toString("utf8"), MAX_STDERR_CHARS);
			this.touch();
		});
		this.proc.on("error", (error) => this.fail(error.message));
		this.proc.on("close", (code, signal) => {
			if (this.treeMonitor) {
				clearInterval(this.treeMonitor);
				this.treeMonitor = undefined;
			}
			if (this.stoppedIntentionally) this.state = "stopped";
			else {
				if (this.state !== "failed") this.fail(`Child process exited (${signal ?? code ?? "unknown"}).`);
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
			if (event.success === false) pending.reject(new Error(typeof event.error === "string" ? event.error : `${pending.command} failed.`));
			else pending.resolve(event);
			return;
		}
		if (event.type === "extension_ui_request" && typeof event.id === "string") {
			const method = event.method;
			if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
				this.proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
				this.appendTranscript(`\n[extension dialog cancelled: ${String(method)}]\n`);
			}
			return;
		}
		this.handleEvent(event);
	}

	private handleEvent(event: Record<string, unknown>): void {
		switch (event.type) {
			case "agent_start":
				this.state = "running";
				break;
			case "agent_settled":
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
						this.fail(typeof message.errorMessage === "string" ? message.errorMessage : "Child model returned an error.");
						this.terminateProcess();
					}
				}
				break;
			}
			case "tool_execution_start":
				this.toolCalls++;
				this.appendTranscript(`\n→ ${String(event.toolName ?? "tool")} ${JSON.stringify(event.args ?? {}).slice(0, 500)}\n`);
				break;
			case "tool_execution_end":
				this.appendTranscript(`\n← ${String(event.toolName ?? "tool")}${event.isError === true ? " (error)" : ""}\n`);
				break;
			case "extension_error":
				this.appendTranscript(`\n[extension error] ${String(event.error ?? "unknown")}\n`);
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
		if (this.killTimer || this.terminationPoll) return;
		const pid = this.proc.pid;
		if (!pid) return;
		this.terminationDone = new Promise((resolve) => { this.resolveTermination = resolve; });
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
			for (const target of this.terminationPids) {
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
		const targets = force ? [...new Set([...this.terminationPids, ...currentTree])] : currentTree;
		for (const target of targets) {
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
