import { createHash } from "node:crypto";
import { extname } from "node:path";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskFeatures } from "./core/features.ts";
import type { LeaseState, TaskLease } from "./core/lease.ts";
import type { EffortLevel, ModelVendor } from "./core/profiles.ts";
import { canonicalVendor, type RegistryModelSnapshot, type RouteRequirements } from "./core/routing.ts";
import type { RepositoryMetadata, SynopsisEntry } from "./core/synopsis.ts";

interface ObjectLike {
	[key: string]: unknown;
}

function object(value: unknown): ObjectLike | undefined {
	return value !== null && typeof value === "object" ? (value as ObjectLike) : undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => object(part))
		.filter((part): part is ObjectLike => Boolean(part) && part?.type === "text")
		.map((part) => string(part.text) ?? "")
		.join("\n");
}

export function normalizeSessionEntries(entries: readonly unknown[]): SynopsisEntry[] {
	const result: SynopsisEntry[] = [];
	const toolPaths = new Map<string, string>();
	for (const rawEntry of entries) {
		const entry = object(rawEntry);
		if (!entry) continue;
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			const details = object(entry.details);
			const summary = string(entry.summary);
			result.push({
				kind: entry.type,
				...(summary ? { text: summary } : {}),
				readFiles: stringArray(details?.readFiles),
				modifiedFiles: stringArray(details?.modifiedFiles),
			});
			continue;
		}
		if (entry.type !== "message") continue;
		const message = object(entry.message);
		if (!message) continue;
		if (message.role === "user") {
			result.push({ kind: "user", text: contentText(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			const stopReason = string(message.stopReason);
			result.push({
				kind: "assistant",
				text: contentText(message.content),
				...(stopReason ? { stopReason } : {}),
			});
			if (Array.isArray(message.content)) {
				for (const rawPart of message.content) {
					const part = object(rawPart);
					if (!part || part.type !== "toolCall") continue;
					const argumentsObject = object(part.arguments);
					const path = string(argumentsObject?.path);
					const id = string(part.id);
					if (path && id) toolPaths.set(id, path);
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			const toolCallId = string(message.toolCallId);
			const toolName = string(message.toolName);
			const path = toolCallId ? toolPaths.get(toolCallId) : undefined;
			result.push({
				kind: "tool",
				...(toolName ? { toolName } : {}),
				...(path ? { path } : {}),
				isError: message.isError === true,
			});
		}
	}
	return result;
}

function isTaskLease(value: unknown): value is TaskLease {
	const lease = object(value);
	const selected = object(lease?.selected);
	return (
		lease?.version === 1 &&
		typeof lease.taskId === "string" &&
		typeof lease.archetype === "string" &&
		typeof selected?.provider === "string" &&
		typeof selected.modelId === "string" &&
		typeof lease.promptProfileId === "string"
	);
}

export function restoreLeaseState(entries: readonly unknown[], defaultMode: LeaseState["mode"]): LeaseState {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = object(entries[index]);
		if (entry?.type !== "custom" || entry.customType !== "model-router-state") continue;
		const data = object(entry.data);
		const mode = data?.mode === "off" || data?.mode === "shadow" || data?.mode === "active" ? data.mode : defaultMode;
		return {
			mode,
			...(isTaskLease(data?.active) ? { active: data.active } : {}),
			manualOverride: data?.manualOverride === true,
		};
	}
	return { mode: defaultMode, manualOverride: false };
}

export function buildRegistrySnapshot(ctx: ExtensionContext): RegistryModelSnapshot[] {
	const available = new Set(ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`));
	const snapshots: RegistryModelSnapshot[] = [];
	for (const model of ctx.modelRegistry.getAll()) {
		const vendor = canonicalVendor(model.provider, model.id);
		if (!vendor) continue;
		snapshots.push({
			provider: model.provider,
			modelId: model.id,
			name: model.name,
			vendor,
			contextWindow: model.contextWindow,
			maxOutputTokens: model.maxTokens,
			available: available.has(`${model.provider}/${model.id}`),
			reasoning: model.reasoning,
			supportedEfforts: getSupportedThinkingLevels(model) as EffortLevel[],
			inputTypes: model.input,
			toolCapable: !model.id.includes("realtime") && !model.id.includes("deep-research"),
			costPerMillion: { ...model.cost },
		});
	}
	return snapshots;
}

export function snapshotForModel(
	model: Model<Api> | undefined,
	registry: readonly RegistryModelSnapshot[],
): RegistryModelSnapshot | undefined {
	return model
		? registry.find((candidate) => candidate.provider === model.provider && candidate.modelId === model.id)
		: undefined;
}

export function modelAbility(modelId: string, effort: EffortLevel): number {
	let ability = 2;
	if (/luna|haiku|nano|mini/.test(modelId)) ability = 1;
	if (/terra|sonnet|gemini-3\.5-flash/.test(modelId)) ability = 2;
	if (/sol|opus/.test(modelId)) ability = 3;
	if (/fable|pro|max/.test(modelId)) ability = 4;
	if ((effort === "xhigh" || effort === "max") && ability < 4) ability++;
	return ability;
}

export function estimateFinishedTokens(currentTokens: number, features: TaskFeatures): number {
	const responseAndReasoning = features.expectedAgentTurns * 1_500;
	const changeEvidence = features.expectedFilesChanged * 1_000;
	return Math.max(
		0,
		Math.ceil(currentTokens + features.expectedToolOutputTokens + responseAndReasoning + changeEvidence + 16_384),
	);
}

export function routeRequirements(
	currentTokens: number,
	features: TaskFeatures,
	hasImages: boolean,
): RouteRequirements {
	return {
		estimatedFinishedTokens: estimateFinishedTokens(currentTokens, features),
		requiresImages: hasImages,
		requiresTools: features.toolDependence !== "none",
	};
}

export function promptFingerprint(prompt: string): string {
	return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | undefined> {
	const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: 5_000 });
	return result.code === 0 ? result.stdout.replace(/\s+$/, "") : undefined;
}

function languageBuckets(files: readonly string[]): string[] {
	const buckets = new Set<string>();
	const names: Record<string, string> = {
		".ts": "typescript",
		".tsx": "typescript",
		".js": "javascript",
		".mjs": "javascript",
		".py": "python",
		".rs": "rust",
		".go": "go",
		".java": "java",
		".rb": "ruby",
		".swift": "swift",
	};
	for (const file of files) {
		const bucket = names[extname(file).toLowerCase()];
		if (bucket) buckets.add(bucket);
	}
	return [...buckets].sort();
}

export async function readRepositoryMetadata(pi: ExtensionAPI, cwd: string): Promise<RepositoryMetadata> {
	const [root, head, upstream, status, tracked] = await Promise.all([
		git(pi, cwd, ["rev-parse", "--show-toplevel"]),
		git(pi, cwd, ["rev-parse", "HEAD"]),
		git(pi, cwd, ["rev-parse", "--verify", "@{upstream}"]),
		git(pi, cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]),
		git(pi, cwd, ["ls-files"]),
	]);
	const changedFiles = (status ?? "")
		.split("\n")
		.filter(Boolean)
		.map((line) => line.slice(3).split(" -> ").at(-1) ?? line.slice(3));
	const trackedFiles = (tracked ?? "").split("\n").filter(Boolean).slice(0, 20_000);
	return {
		root: root ?? cwd,
		...(head ? { head } : {}),
		...(upstream ? { upstream } : {}),
		dirty: changedFiles.length > 0,
		changedFiles,
		languageBuckets: languageBuckets(trackedFiles),
	};
}

export function latestReportedContextTokens(entries: readonly unknown[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = object(entries[index]);
		const message = object(entry?.message);
		if (entry?.type !== "message" || message?.role !== "assistant") continue;
		const usage = object(message.usage);
		const input = typeof usage?.input === "number" ? Math.max(0, usage.input) : 0;
		const cacheRead = typeof usage?.cacheRead === "number" ? Math.max(0, usage.cacheRead) : 0;
		const output = typeof usage?.output === "number" ? Math.max(0, usage.output) : 0;
		return Math.ceil(input + cacheRead + output);
	}
	return 0;
}

export function cacheEstimate(entries: readonly unknown[]): { cachedTokens: number; expectedReuseRatio: number } {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = object(entries[index]);
		const message = object(entry?.message);
		if (entry?.type !== "message" || message?.role !== "assistant") continue;
		const usage = object(message.usage);
		const cachedTokens = typeof usage?.cacheRead === "number" ? Math.max(0, usage.cacheRead) : 0;
		const input = typeof usage?.input === "number" ? Math.max(0, usage.input) : 0;
		return {
			cachedTokens,
			expectedReuseRatio: input > 0 ? Math.min(1, cachedTokens / input) : 0,
		};
	}
	return { cachedTokens: 0, expectedReuseRatio: 0 };
}

export function vendorForCurrentModel(model: Model<Api> | undefined): ModelVendor | undefined {
	return model ? canonicalVendor(model.provider, model.id) : undefined;
}
