import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ClassificationResult } from "./classifier.ts";
import { compilePrompt } from "./core/compiler.ts";
import { type FailureKind, resolveFallback } from "./core/fallback.ts";
import {
	type BoundaryGateResult,
	changeEffortWithinLease,
	createTaskLease,
	deterministicBoundaryGate,
	installLease,
	type LeaseState,
	markManualOverride,
	type RouterMode,
	resolveContinuity,
	setHardBoundary,
	type TaskLease,
} from "./core/lease.ts";
import { ProgramPlanSchema, validateProgramPlan } from "./core/planning.ts";
import { type EffortLevel, findPromptProfile, PROMPT_PROFILES } from "./core/profiles.ts";
import {
	type RegistryModelSnapshot,
	type RouteChoice,
	type RouteDecision,
	type RouteSample,
	registrySnapshotId,
	selectOrdinaryRoute,
	selectReviewRoute,
} from "./core/routing.ts";
import { buildSessionSynopsis, type RepositoryMetadata, type SessionSynopsis } from "./core/synopsis.ts";
import { classifyTaskWithPi } from "./pi-classifier.ts";
import {
	buildRegistrySnapshot,
	cacheEstimate,
	latestReportedContextTokens,
	modelAbility,
	normalizeSessionEntries,
	promptFingerprint,
	readRepositoryMetadata,
	restoreLeaseState,
	routeRequirements,
	snapshotForModel,
} from "./pi-state.ts";
import {
	type AttemptOutcome,
	aggregateRouteSamples,
	JsonlTelemetryStore,
	type RouterTelemetryEvent,
	withRouterSpan,
} from "./telemetry.ts";

const STATE_ENTRY = "model-router-state";
const CONTEXT_MESSAGE = "model-router-context";

interface PendingInput {
	gate: BoundaryGateResult;
	repository: Promise<RepositoryMetadata>;
	cache: { cachedTokens: number; expectedReuseRatio: number };
	hasImages: boolean;
	source: "interactive" | "rpc" | "extension";
}

interface LastRoute {
	classification?: ClassificationResult;
	decision?: RouteDecision;
	boundaryReason?: string;
}

interface AttemptMetrics {
	provider: string;
	modelId: string;
	archetype: TaskLease["archetype"];
	modelAndToolCost: number;
	wallTimeMs: number;
	retried: boolean;
}

type AttemptDisposition = "unknown" | "pending" | "success" | "aborted" | "incomplete" | "failed";

export function deterministicCheckCommand(command: string): string | undefined {
	const normalized = command.trim();
	if (!/\b(?:test|check|lint|typecheck|audit|scan)\b/i.test(normalized)) return undefined;
	// Do not treat shell constructs that can mask an earlier non-zero exit as verification evidence.
	if (/\|\||[;|\n\r]|(^|[^&])&([^&]|$)|(^|\s)!(?=\s)/.test(normalized)) return undefined;
	return normalized.slice(0, 500);
}

function defaultMode(): RouterMode {
	const configured = process.env.PI_ROUTER_MODE;
	return configured === "off" || configured === "active" || configured === "shadow" ? configured : "shadow";
}

function assistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function currentTokens(ctx: ExtensionContext): number {
	return Math.max(ctx.getContextUsage()?.tokens ?? 0, latestReportedContextTokens(ctx.sessionManager.getBranch()));
}

function contextSizeBucket(ctx: ExtensionContext, features: TaskLease["features"]): string {
	const tokens = routeRequirements(currentTokens(ctx), features, false).estimatedFinishedTokens;
	const numeric =
		tokens < 32_000 ? "lt32k" : tokens < 128_000 ? "32k-128k" : tokens < 512_000 ? "128k-512k" : "gte512k";
	return `${features.contextShape}:${numeric}`;
}

function statusLabel(state: LeaseState): string {
	const lease = state.active;
	if (!lease) return `route:${state.mode}`;
	return `route:${state.mode}${lease.executionFailed ? ":failed" : ""} ${lease.selected.vendor}/${lease.selected.modelId} ${lease.selected.effort}`;
}

function previousChoice(
	model: RegistryModelSnapshot | undefined,
	effort: EffortLevel,
	archetype: TaskLease["archetype"],
): RouteChoice | undefined {
	if (!model) return undefined;
	const profile = findPromptProfile(model.vendor, model.modelId, archetype, effort);
	if (!profile) return undefined;
	return {
		provider: model.provider,
		modelId: model.modelId,
		vendor: model.vendor,
		effort,
		ability: modelAbility(model.modelId, effort),
		profileId: profile.id,
		contextWindow: model.contextWindow,
		rankReason: "bootstrap",
	};
}

function telemetryOutcomes(events: readonly RouterTelemetryEvent[]): AttemptOutcome[] {
	const outcomes: AttemptOutcome[] = [];
	for (const event of events) {
		if (event.kind !== "outcome") continue;
		const data = event.data;
		if (
			typeof data.provider !== "string" ||
			typeof data.modelId !== "string" ||
			typeof data.archetype !== "string" ||
			typeof data.accepted !== "boolean" ||
			typeof data.modelAndToolCost !== "number" ||
			typeof data.wallTimeMs !== "number" ||
			typeof data.humanIntervention !== "boolean" ||
			typeof data.retried !== "boolean"
		) {
			continue;
		}
		outcomes.push(data as unknown as AttemptOutcome);
	}
	return outcomes;
}

export default function routerExtension(pi: ExtensionAPI): void {
	const telemetry = new JsonlTelemetryStore(
		process.env.PI_ROUTER_TELEMETRY_PATH ?? join(getAgentDir(), "router-telemetry", "events.jsonl"),
	);
	let state: LeaseState = { mode: defaultMode(), manualOverride: false };
	let pendingInput: PendingInput | undefined;
	let nextParentTaskId: string | undefined;
	let lastRoute: LastRoute = {};
	let lastUpstream: string | undefined;
	let applyingSelection = false;
	let lastProviderFailure: FailureKind | undefined;
	let attemptStartedAt = 0;
	let attemptTurns = 0;
	let attemptToolCalls = 0;
	let agentRunSequence = 0;
	const deterministicCheckCalls = new Map<string, string>();
	const deterministicCheckResults = new Map<string, boolean>();
	const validatedPlanAttempts = new Set<string>();
	let lastAttemptMetrics: AttemptMetrics | undefined;
	let reviewParentAttemptMetrics: AttemptMetrics | undefined;
	const accumulatedTaskCosts = new Map<string, number>();
	const taskStartedAt = new Map<string, number>();
	let telemetryHealthy = true;
	let attemptDisposition: AttemptDisposition = "unknown";

	function persistState(): void {
		pi.appendEntry(STATE_ENTRY, {
			mode: state.mode,
			manualOverride: state.manualOverride,
			active: state.active,
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("model-router", ctx.ui.theme.fg(state.mode === "active" ? "accent" : "muted", statusLabel(state)));
	}

	function disableForTelemetryFailure(ctx: ExtensionContext, error: unknown): void {
		if (!telemetryHealthy) return;
		telemetryHealthy = false;
		if (state.mode === "active") {
			state = { ...state, mode: "shadow" };
			persistState();
			updateStatus(ctx);
		}
		ctx.ui.notify(
			`Router telemetry failed; automatic routing is disabled for this session: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}

	async function record(
		ctx: ExtensionContext,
		kind: RouterTelemetryEvent["kind"],
		data: Record<string, unknown>,
		extra: Partial<
			Omit<RouterTelemetryEvent, "version" | "eventId" | "timestamp" | "kind" | "sessionId" | "data">
		> = {},
	): Promise<void> {
		if (!telemetryHealthy) return;
		try {
			await telemetry.append({
				version: 1,
				eventId: randomUUID(),
				timestamp: new Date().toISOString(),
				kind,
				sessionId: ctx.sessionManager.getSessionId(),
				...extra,
				data,
			});
		} catch (error) {
			disableForTelemetryFailure(ctx, error);
		}
	}

	async function synopsis(ctx: ExtensionContext, repository: RepositoryMetadata): Promise<SessionSynopsis> {
		const usage = ctx.getContextUsage();
		const vendor = ctx.model ? snapshotForModel(ctx.model, buildRegistrySnapshot(ctx))?.vendor : undefined;
		return buildSessionSynopsis({
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			...(ctx.model
				? {
						builder: {
							provider: ctx.model.provider,
							modelId: ctx.model.id,
							...(vendor ? { vendor } : {}),
							effort: pi.getThinkingLevel(),
						},
					}
				: {}),
			activeTools: pi.getActiveTools(),
			contextTokens: usage?.tokens ?? 0,
			contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 1,
			entries: normalizeSessionEntries(ctx.sessionManager.getBranch()),
			repository,
		});
	}

	async function route(
		ctx: ExtensionContext,
		classification: ClassificationResult,
		hasImages: boolean,
		languageBucket: string,
		contextBucket: string,
		explorationKey: string,
	): Promise<{ decision: RouteDecision; registry: RegistryModelSnapshot[] }> {
		const registry = buildRegistrySnapshot(ctx);
		const requirements = routeRequirements(currentTokens(ctx), classification.features, hasImages);
		let events: RouterTelemetryEvent[] = [];
		try {
			events = await telemetry.read();
		} catch (error) {
			disableForTelemetryFailure(ctx, error);
		}
		const routeSamples: RouteSample[] = aggregateRouteSamples(telemetryOutcomes(events)).filter(
			(sample) =>
				sample.contextBucket === contextBucket &&
				sample.risk === classification.features.risk &&
				sample.interactivity === classification.features.interactivity &&
				sample.languageBucket === languageBucket,
		);
		const archetype = classification.archetype.archetype;
		if (
			(archetype === "implementation_planning" || archetype === "large_program_planning") &&
			!pi.getActiveTools().includes("submit_implementation_plan")
		) {
			return {
				registry,
				decision: {
					kind: "unroutable",
					policyVersion: "router-policy-v1",
					archetype,
					reason: "planning route requires the active submit_implementation_plan validator tool",
					exclusions: [],
				},
			};
		}
		if (archetype === "code_review") {
			const builder = snapshotForModel(ctx.model, registry);
			if (!builder) {
				return {
					registry,
					decision: {
						kind: "unroutable",
						policyVersion: "router-policy-v1",
						archetype,
						reason: "review routing requires a recognized current builder model",
						exclusions: [],
					},
				};
			}
			return {
				registry,
				decision: selectReviewRoute(
					registry,
					requirements,
					builder,
					pi.getThinkingLevel() as EffortLevel,
					modelAbility(builder.modelId, pi.getThinkingLevel() as EffortLevel),
				),
			};
		}
		return {
			registry,
			decision: selectOrdinaryRoute(archetype, registry, requirements, routeSamples, undefined, explorationKey),
		};
	}

	function leasedChoiceEligible(ctx: ExtensionContext, lease: TaskLease, hasImages: boolean): boolean {
		const registry = buildRegistrySnapshot(ctx);
		const model = registry.find(
			(candidate) => candidate.provider === lease.selected.provider && candidate.modelId === lease.selected.modelId,
		);
		if (!model?.available) return false;
		const requirements = routeRequirements(currentTokens(ctx), lease.features, hasImages);
		if (requirements.estimatedFinishedTokens > Math.floor(model.contextWindow * 0.7)) return false;
		if (requirements.requiresImages && !model.inputTypes.includes("image")) return false;
		if (requirements.requiresTools && !model.toolCapable) return false;
		if (!model.supportedEfforts.includes(lease.selected.effort)) return false;
		return Boolean(
			findPromptProfile(model.vendor, model.modelId, lease.archetype, lease.selected.effort)?.id ===
				lease.promptProfileId,
		);
	}

	async function applyChoice(ctx: ExtensionContext, choice: RouteChoice): Promise<boolean> {
		applyingSelection = true;
		try {
			if (ctx.model?.provider === choice.provider && ctx.model.id === choice.modelId) {
				if (pi.getThinkingLevel() !== choice.effort) pi.setThinkingLevel(choice.effort);
				return true;
			}
			const model = ctx.modelRegistry.find(choice.provider, choice.modelId);
			if (!model) return false;
			const selected = await pi.setModel(model);
			if (!selected) return false;
			pi.setThinkingLevel(choice.effort);
			return true;
		} catch {
			return false;
		} finally {
			applyingSelection = false;
		}
	}

	async function applyWithAvailabilityFallback(
		ctx: ExtensionContext,
		lease: TaskLease,
	): Promise<TaskLease | undefined> {
		let candidate = lease;
		while (!(await applyChoice(ctx, candidate.selected))) {
			const fallback = resolveFallback(candidate, "availability", new Date().toISOString());
			await record(
				ctx,
				"fallback",
				{
					action: fallback.action,
					reason: fallback.reason,
					failure: "availability",
					failedSelection: candidate.selected,
					...(fallback.action === "use_choice" ? { nextSelection: fallback.choice } : {}),
				},
				{
					taskId: candidate.taskId,
					routeKey: candidate.archetype,
					archetype: candidate.archetype,
					provider: candidate.selected.provider,
					modelId: candidate.selected.modelId,
					effort: candidate.selected.effort,
					promptProfileId: candidate.promptProfileId,
					policyVersion: candidate.policyVersion,
					modelSnapshotId: candidate.modelSnapshotId,
				},
			);
			if (fallback.action !== "use_choice") {
				if (fallback.action === "restore_previous" && fallback.choice) await applyChoice(ctx, fallback.choice);
				return undefined;
			}
			candidate = fallback.lease;
		}
		return candidate;
	}

	async function restoreParentAfterReview(
		ctx: ExtensionContext,
		child: TaskLease,
		outcome: "completed" | "skipped",
	): Promise<void> {
		if (!child.parentLease) return;
		const parent = {
			...child.parentLease,
			updatedAt: new Date().toISOString(),
			reviewCompleted: true,
		};
		await applyChoice(ctx, parent.selected);
		state = installLease(state, parent);
		const reviewMetrics = lastAttemptMetrics;
		lastAttemptMetrics = reviewParentAttemptMetrics
			? {
					...reviewParentAttemptMetrics,
					modelAndToolCost: reviewParentAttemptMetrics.modelAndToolCost + (reviewMetrics?.modelAndToolCost ?? 0),
					wallTimeMs: reviewParentAttemptMetrics.wallTimeMs + (reviewMetrics?.wallTimeMs ?? 0),
					retried: reviewParentAttemptMetrics.retried || (reviewMetrics?.retried ?? false),
				}
			: undefined;
		reviewParentAttemptMetrics = undefined;
		persistState();
		updateStatus(ctx);
		await record(
			ctx,
			"outcome",
			{ reviewOutcome: outcome, reviewTaskId: child.taskId, parentTaskId: parent.taskId },
			{ taskId: parent.taskId, archetype: parent.archetype },
		);
	}

	async function transitionFallback(ctx: ExtensionContext, failure: FailureKind, triggerTurn: boolean): Promise<void> {
		const active = state.active;
		if (!active || state.mode !== "active") return;
		const fallback = resolveFallback(active, failure, new Date().toISOString());
		await record(
			ctx,
			"fallback",
			{
				action: fallback.action,
				reason: fallback.reason,
				failure,
				failedSelection: active.selected,
				...(fallback.action === "use_choice"
					? { nextSelection: fallback.choice, reviewFellBackToBuilder: fallback.reviewFellBackToBuilder }
					: {}),
			},
			{
				taskId: active.taskId,
				routeKey: active.archetype,
				archetype: active.archetype,
				provider: active.selected.provider,
				modelId: active.selected.modelId,
				effort: active.selected.effort,
				promptProfileId: active.promptProfileId,
				policyVersion: active.policyVersion,
				modelSnapshotId: active.modelSnapshotId,
			},
		);
		if (fallback.action === "use_choice") {
			if (!(await applyChoice(ctx, fallback.choice))) {
				attemptDisposition = "failed";
				return;
			}
			state = installLease(state, fallback.lease);
			attemptDisposition = "pending";
			attemptStartedAt = Date.now();
			attemptTurns = 0;
			attemptToolCalls = 0;
			deterministicCheckCalls.clear();
			deterministicCheckResults.clear();
			persistState();
			updateStatus(ctx);
			if (triggerTurn) {
				pi.sendMessage(
					{
						customType: CONTEXT_MESSAGE,
						content:
							"The previous routed attempt failed. Continue the same task with existing evidence; do not broaden scope.",
						display: false,
						details: { taskId: active.taskId, fallbackReason: failure },
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			}
			return;
		}
		if (fallback.action === "restore_previous") {
			attemptDisposition = "failed";
			if (fallback.choice) await applyChoice(ctx, fallback.choice);
			state = installLease(state, { ...fallback.lease, executionFailed: true });
			persistState();
			updateStatus(ctx);
		}
		if (fallback.action === "skip_review" && active.parentLease) {
			attemptDisposition = "failed";
			await restoreParentAfterReview(ctx, active, "skipped");
		}
		ctx.ui.notify(fallback.reason, fallback.action === "skip_review" ? "warning" : "error");
	}

	async function startIndependentReview(ctx: ExtensionContext, parent: TaskLease): Promise<void> {
		if (
			state.mode !== "active" ||
			state.manualOverride ||
			parent.manualOverride ||
			!parent.reviewRequired ||
			parent.reviewCompleted ||
			parent.parentLease ||
			parent.archetype === "code_review"
		) {
			return;
		}
		const registry = buildRegistrySnapshot(ctx);
		const builder = registry.find(
			(candidate) => candidate.provider === parent.selected.provider && candidate.modelId === parent.selected.modelId,
		);
		if (!builder) return;
		const decision = selectReviewRoute(
			registry,
			routeRequirements(currentTokens(ctx), parent.features, false),
			builder,
			parent.selected.effort,
			parent.selected.ability,
		);
		if (decision.kind !== "review") {
			await record(
				ctx,
				"route_decision",
				{
					kind: "unroutable_review",
					reason: decision.kind === "unroutable" ? decision.reason : "review selector returned an ordinary route",
					exclusions: decision.exclusions,
				},
				{
					taskId: parent.taskId,
					routeKey: "code_review",
					archetype: parent.archetype,
					policyVersion: decision.policyVersion,
					modelSnapshotId: registrySnapshotId(registry),
				},
			);
			ctx.ui.notify("Required independent review is unroutable; inspect router telemetry before continuing", "error");
			return;
		}
		reviewParentAttemptMetrics = lastAttemptMetrics;
		lastAttemptMetrics = undefined;
		const now = new Date().toISOString();
		const reviewFeatures = {
			...parent.features,
			intent: "review" as const,
			workflowType: "code_review" as const,
			actionMode: "local_read" as const,
			reviewIntent: true,
			independenceRequirement: "different_vendor_review" as const,
			taskContinuity: "new_task" as const,
		};
		const child = createTaskLease({
			taskId: randomUUID(),
			parentTaskId: parent.taskId,
			parentLease: parent,
			startedAt: now,
			updatedAt: now,
			archetype: "code_review",
			features: reviewFeatures,
			selected: decision.primary,
			fallbacks: [decision.fallback, decision.builderFallback],
			modelSnapshotId: registrySnapshotId(registry),
			policyVersion: decision.policyVersion,
			lastPromptFingerprint: promptFingerprint(`review:${parent.taskId}`),
			...(parent.repositoryLanguageBucket ? { repositoryLanguageBucket: parent.repositoryLanguageBucket } : {}),
			...(parent.contextSizeBucket ? { contextSizeBucket: parent.contextSizeBucket } : {}),
		});
		const applied = await applyWithAvailabilityFallback(ctx, child);
		if (!applied) {
			await restoreParentAfterReview(ctx, child, "skipped");
			return;
		}
		state = installLease(state, applied);
		accumulatedTaskCosts.set(applied.taskId, 0);
		taskStartedAt.set(applied.taskId, Date.now());
		persistState();
		updateStatus(ctx);
		attemptStartedAt = Date.now();
		attemptTurns = 0;
		attemptToolCalls = 0;
		deterministicCheckCalls.clear();
		deterministicCheckResults.clear();
		await record(
			ctx,
			"route_decision",
			{
				kind: "required_independent_review",
				parentTaskId: parent.taskId,
				selection: decision.primary,
				exclusions: decision.exclusions,
				ceilingMismatchVendors: decision.ceilingMismatchVendors,
				fallbacks: applied.fallbacks.map((choice) => `${choice.provider}/${choice.modelId}`),
			},
			{
				taskId: applied.taskId,
				routeKey: "code_review",
				archetype: "code_review",
				provider: applied.selected.provider,
				modelId: applied.selected.modelId,
				effort: applied.selected.effort,
				promptProfileId: applied.promptProfileId,
				policyVersion: applied.policyVersion,
				modelSnapshotId: applied.modelSnapshotId,
			},
		);
		attemptDisposition = "pending";
		pi.sendMessage(
			{
				customType: CONTEXT_MESSAGE,
				content: [
					`Perform the required independent review for parent task ${parent.taskId}.`,
					"Inspect the current diff and deterministic test evidence. Do not edit files.",
					"Report only actionable findings with severity and file/evidence anchors; say explicitly when there are none.",
				].join("\n"),
				display: true,
				details: { parentTaskId: parent.taskId, reviewTaskId: applied.taskId },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	pi.registerTool({
		name: "submit_implementation_plan",
		label: "Validate implementation plan",
		description:
			"Submit a complete implementation-plan DAG. Required on implementation_planning and large_program_planning routes. Validates IDs, dependencies, cycles, acceptance criteria, rollout, and rollback.",
		parameters: ProgramPlanSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const active = state.active;
			if (
				!active ||
				(active.archetype !== "implementation_planning" && active.archetype !== "large_program_planning")
			) {
				throw new Error("submit_implementation_plan is only valid inside a planning lease");
			}
			const validation = validateProgramPlan(params);
			await record(
				ctx,
				"outcome",
				{
					planValidated: validation.success,
					validationErrors: validation.errors,
					topologicalOrder: validation.topologicalOrder,
				},
				{ taskId: active.taskId, archetype: active.archetype },
			);
			if (!validation.success) throw new Error(`Invalid implementation plan: ${validation.errors.join("; ")}`);
			validatedPlanAttempts.add(`${active.taskId}:${active.attemptIndex}:${agentRunSequence}`);
			return {
				content: [
					{
						type: "text",
						text: `Validated implementation-plan DAG (${validation.topologicalOrder.length} PRs): ${validation.topologicalOrder.join(" -> ")}`,
					},
				],
				details: { plan: params, topologicalOrder: validation.topologicalOrder },
			};
		},
	});

	pi.on("session_start", async (event, ctx) => {
		attemptDisposition = "unknown";
		state = restoreLeaseState(ctx.sessionManager.getBranch(), defaultMode());
		nextParentTaskId = event.reason === "fork" ? state.active?.taskId : undefined;
		if (event.reason !== "reload") state = setHardBoundary(state, event.reason === "fork" ? "subagent" : "new_session");
		const repository = await readRepositoryMetadata(pi, ctx.cwd);
		lastUpstream = repository.upstream;
		updateStatus(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		state = setHardBoundary(state, "post_compaction");
		persistState();
		await record(ctx, "boundary", { boundary: "post_compaction" }, state.active ? { taskId: state.active.taskId } : {});
	});

	pi.on("session_before_fork", async (_event, ctx) => {
		await record(
			ctx,
			"boundary",
			{ boundary: "subagent_fork_requested" },
			state.active ? { taskId: state.active.taskId } : {},
		);
	});

	pi.on("input", async (event, ctx) => {
		if (state.mode === "off") return { action: "continue" as const };
		const cache = cacheEstimate(ctx.sessionManager.getBranch());
		let gate = deterministicBoundaryGate(state, {
			isUserInput: true,
			source: event.source,
			...(event.streamingBehavior ? { streamingBehavior: event.streamingBehavior } : {}),
			prompt: event.text,
			cachedTokens: cache.cachedTokens,
			expectedReuseRatio: cache.expectedReuseRatio,
		});
		const hasImages = Boolean(event.images?.length);
		if (hasImages && state.active) {
			const selected = buildRegistrySnapshot(ctx).find(
				(candidate) =>
					candidate.provider === state.active?.selected.provider && candidate.modelId === state.active.selected.modelId,
			);
			if (!selected?.inputTypes.includes("image")) {
				gate = { action: "new_task", reason: "image input requires a newly eligible route" };
			}
		}
		pendingInput = {
			gate,
			repository: readRepositoryMetadata(pi, ctx.cwd),
			cache,
			hasImages,
			source: event.source,
		};
		lastRoute = { boundaryReason: gate.reason };
		ctx.ui.setWorkingMessage("Routing...");
		ctx.ui.setWorkingVisible(true);
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (state.mode === "off") return;
		try {
			const pending = pendingInput;
			pendingInput = undefined;
			const repository = pending ? await pending.repository : await readRepositoryMetadata(pi, ctx.cwd);
			if (pending && lastUpstream && repository.upstream && repository.upstream !== lastUpstream) {
				state = setHardBoundary(state, "post_push");
				pending.gate = { action: "new_task", reason: "hard boundary: post_push", hardBoundary: "post_push" };
			}
			lastUpstream = repository.upstream;
			if (pending) {
				lastRoute = { boundaryReason: pending.gate.reason };
				await record(
					ctx,
					"boundary",
					{ action: pending.gate.action, reason: pending.gate.reason, cache: pending.cache, source: pending.source },
					state.active ? { taskId: state.active.taskId } : {},
				);
			}
			const currentSynopsis = await synopsis(ctx, repository);
			let active = state.active;
			let classification: ClassificationResult | undefined;
			let requiresNewLease = pending?.gate.action === "new_task";

			if (pending?.gate.action === "classify_continuity") {
				classification = await withRouterSpan(
					ctx.sessionManager.getSessionId(),
					"router.classify_continuity",
					{ "router.mode": state.mode },
					() => classifyTaskWithPi({ ctx, prompt: event.prompt, synopsis: currentSynopsis }),
				);
				const continuity = resolveContinuity(pending.gate.lease, classification.features, pending.cache);
				requiresNewLease = continuity.action === "new_task";
				lastRoute.boundaryReason = continuity.reason;
				if (!requiresNewLease) active = pending.gate.lease;
			}

			if (requiresNewLease) {
				classification ??= await withRouterSpan(
					ctx.sessionManager.getSessionId(),
					"router.classify",
					{ "router.mode": state.mode },
					() => classifyTaskWithPi({ ctx, prompt: event.prompt, synopsis: currentSynopsis }),
				);
				const routedClassification = classification;
				for (const attempt of routedClassification.attempts) {
					await record(
						ctx,
						"classifier_attempt",
						{ ...attempt },
						{
							archetype: routedClassification.archetype.archetype,
							...(attempt.provider ? { provider: attempt.provider } : {}),
							...(attempt.modelId ? { modelId: attempt.modelId } : {}),
						},
					);
				}
				const languageBucket = repository.languageBuckets.join("+") || "unknown";
				const contextBucket = contextSizeBucket(ctx, routedClassification.features);
				const routed = await withRouterSpan(
					ctx.sessionManager.getSessionId(),
					"router.route",
					{
						"router.mode": state.mode,
						"router.archetype": routedClassification.archetype.archetype,
						"router.risk": routedClassification.features.risk,
					},
					async (span) => {
						const result = await route(
							ctx,
							routedClassification,
							pending?.hasImages ?? Boolean(event.images?.length),
							languageBucket,
							contextBucket,
							promptFingerprint(event.prompt),
						);
						span?.setAttribute("router.decision", result.decision.kind);
						if (result.decision.kind !== "unroutable") {
							span?.setAttribute("router.provider", result.decision.primary.provider);
							span?.setAttribute("router.model", result.decision.primary.modelId);
							span?.setAttribute("router.profile", result.decision.primary.profileId);
						}
						return result;
					},
				);
				lastRoute = { ...lastRoute, classification, decision: routed.decision };
				if (routed.decision.kind === "unroutable") {
					await record(
						ctx,
						"route_decision",
						{
							kind: "unroutable",
							reason: routed.decision.reason,
							exclusions: routed.decision.exclusions,
							classifierOutput: routedClassification.features,
							classifierAttempts: routedClassification.attempts,
						},
						{
							routeKey: routed.decision.archetype,
							archetype: routed.decision.archetype,
							policyVersion: routed.decision.policyVersion,
							modelSnapshotId: registrySnapshotId(routed.registry),
						},
					);
					ctx.ui.notify(`Router retained current model: ${routed.decision.reason}`, "warning");
					return;
				}
				const now = new Date().toISOString();
				const currentSnapshot = snapshotForModel(ctx.model, routed.registry);
				const currentEffort = pi.getThinkingLevel() as EffortLevel;
				const priorSelection = previousChoice(currentSnapshot, currentEffort, routed.decision.archetype);
				const reviewParent =
					routed.decision.kind === "review" &&
					state.active &&
					!(pending?.gate.action === "new_task" && "hardBoundary" in pending.gate)
						? state.active
						: undefined;
				if (reviewParent) {
					reviewParentAttemptMetrics = lastAttemptMetrics;
					lastAttemptMetrics = undefined;
				}
				const lease = createTaskLease({
					taskId: randomUUID(),
					...(reviewParent
						? { parentTaskId: reviewParent.taskId, parentLease: reviewParent }
						: nextParentTaskId
							? { parentTaskId: nextParentTaskId }
							: {}),
					startedAt: now,
					updatedAt: now,
					archetype: routed.decision.archetype,
					features: classification.features,
					selected: routed.decision.primary,
					...(priorSelection ? { previousSelection: priorSelection } : {}),
					fallbacks:
						routed.decision.kind === "review"
							? [routed.decision.fallback, routed.decision.builderFallback]
							: [routed.decision.fallback],
					modelSnapshotId: registrySnapshotId(routed.registry),
					policyVersion: routed.decision.policyVersion,
					lastPromptFingerprint: promptFingerprint(event.prompt),
					reviewRequired: classification.archetype.requiresIndependentReview,
					reviewCompleted: false,
					repositoryLanguageBucket: languageBucket,
					contextSizeBucket: contextBucket,
				});
				state = installLease(state, lease);
				accumulatedTaskCosts.set(lease.taskId, 0);
				taskStartedAt.set(lease.taskId, Date.now());
				nextParentTaskId = undefined;
				persistState();
				active = lease;
				attemptStartedAt = Date.now();
				attemptTurns = 0;
				attemptToolCalls = 0;
				deterministicCheckCalls.clear();
				deterministicCheckResults.clear();
				await record(
					ctx,
					"route_decision",
					{
						kind: routed.decision.kind,
						confidence: classification.features.confidence,
						risk: classification.features.risk,
						failedClosed: classification.failedClosed,
						reviewRequired: lease.reviewRequired === true,
						exclusions: routed.decision.exclusions,
						selection: routed.decision.primary,
						telemetryMature: routed.decision.telemetryMature,
						controlledHoldout: routed.decision.kind === "ordinary" ? routed.decision.controlledHoldout : false,
						fallbacks: lease.fallbacks.map((choice) => `${choice.provider}/${choice.modelId}`),
						classifierOutput: classification.features,
						primaryClassifierOutput: classification.primaryFeatures,
						secondaryClassifierOutput: classification.secondaryFeatures,
						classifierAttempts: classification.attempts,
					},
					{
						taskId: lease.taskId,
						routeKey: lease.archetype,
						archetype: lease.archetype,
						provider: lease.selected.provider,
						modelId: lease.selected.modelId,
						effort: lease.selected.effort,
						promptProfileId: lease.promptProfileId,
						policyVersion: lease.policyVersion,
						modelSnapshotId: lease.modelSnapshotId,
					},
				);
			}

			if (!active || active.manualOverride || state.manualOverride) return;
			if (
				state.mode === "active" &&
				pending &&
				active.reviewRequired &&
				active.reviewCompleted &&
				!active.parentLease
			) {
				active = { ...active, reviewCompleted: false, updatedAt: new Date().toISOString() };
				state = installLease(state, active);
				persistState();
			}
			updateStatus(ctx);
			if (state.mode === "shadow") {
				ctx.ui.notify(
					`Shadow route: ${active.archetype} → ${active.selected.provider}/${active.selected.modelId} (${active.selected.effort})`,
					"info",
				);
				return;
			}
			for (
				let guard = 0;
				guard < 3 && active && !leasedChoiceEligible(ctx, active, pending?.hasImages ?? false);
				guard++
			) {
				const previousAttempt = active.attemptIndex;
				await transitionFallback(ctx, "availability", false);
				active = state.active;
				if (!active || active.executionFailed || active.attemptIndex === previousAttempt) return;
			}
			if (!active || !leasedChoiceEligible(ctx, active, pending?.hasImages ?? false)) return;
			const applied = await applyWithAvailabilityFallback(ctx, active);
			if (!applied) {
				state = installLease(state, { ...active, executionFailed: true });
				persistState();
				updateStatus(ctx);
				return;
			}
			if (applied !== active) {
				state = installLease(state, applied);
				persistState();
				active = applied;
			}
			const profile = PROMPT_PROFILES.find((candidate) => candidate.id === active?.promptProfileId);
			if (!profile) return;
			const compiled = compilePrompt({
				baseSystemPrompt: event.systemPrompt,
				profile,
				synopsis: currentSynopsis,
				userRequest: event.prompt,
				archetype: active.archetype,
			});
			return {
				systemPrompt: compiled.systemPrompt,
				message: {
					customType: CONTEXT_MESSAGE,
					content: compiled.contextMessage ?? "",
					display: false,
					details: { taskId: active.taskId, profileId: active.promptProfileId },
				},
			};
		} finally {
			ctx.ui.setWorkingMessage();
		}
	});

	pi.on("model_select", async (event, ctx) => {
		if (applyingSelection || event.source === "restore") return;
		state = markManualOverride(state);
		persistState();
		updateStatus(ctx);
		await record(
			ctx,
			"outcome",
			{ manualOverride: "model", provider: event.model.provider, modelId: event.model.id },
			state.active
				? {
						taskId: state.active.taskId,
						archetype: state.active.archetype,
						provider: event.model.provider,
						modelId: event.model.id,
						policyVersion: state.active.policyVersion,
						modelSnapshotId: state.active.modelSnapshotId,
					}
				: {},
		);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		if (applyingSelection) return;
		const active = state.active;
		const changed = active
			? changeEffortWithinLease(active, event.level as EffortLevel, new Date().toISOString())
			: undefined;
		if (changed?.success) state = { ...state, active: changed.lease };
		state = markManualOverride(state);
		persistState();
		updateStatus(ctx);
		await record(
			ctx,
			"outcome",
			{
				manualOverride: "effort",
				effort: event.level,
				leaseUpdated: changed?.success ?? false,
				...(!changed?.success && changed ? { reason: changed.reason } : {}),
			},
			state.active
				? {
						taskId: state.active.taskId,
						archetype: state.active.archetype,
						provider: state.active.selected.provider,
						modelId: state.active.selected.modelId,
						effort: event.level,
						promptProfileId: state.active.promptProfileId,
						policyVersion: state.active.policyVersion,
						modelSnapshotId: state.active.modelSnapshotId,
					}
				: {},
		);
	});

	pi.on("agent_start", () => {
		lastProviderFailure = undefined;
		attemptDisposition = "pending";
		agentRunSequence++;
		attemptStartedAt = Date.now();
		attemptTurns = 0;
		attemptToolCalls = 0;
		deterministicCheckCalls.clear();
		deterministicCheckResults.clear();
	});

	pi.on("turn_start", () => {
		attemptTurns++;
	});

	pi.on("tool_execution_end", (event) => {
		attemptToolCalls++;
		const check = deterministicCheckCalls.get(event.toolCallId);
		if (check) {
			deterministicCheckCalls.delete(event.toolCallId);
			deterministicCheckResults.set(check, !event.isError);
		}
	});

	pi.on("tool_call", (event) => {
		if (event.toolName === "bash") {
			const command = deterministicCheckCommand(typeof event.input.command === "string" ? event.input.command : "");
			if (command) deterministicCheckCalls.set(event.toolCallId, command);
		}
		if (!state.active?.parentLease) return;
		if (
			event.toolName === "read" ||
			event.toolName === "grep" ||
			event.toolName === "find" ||
			event.toolName === "ls"
		) {
			return;
		}
		if (event.toolName === "bash") {
			const command = typeof event.input.command === "string" ? event.input.command.trim() : "";
			const safeCommand =
				/^(?:git\s+(?:diff|status|show|log|rev-parse|ls-files)\b|rg\b|grep\b|find\b|ls\b|pwd\b|wc\b|head\b|tail\b|file\b)/.test(
					command,
				) && !/[;&|><`$(){}\n]/.test(command);
			if (safeCommand) return;
		}
		return { block: true, reason: "Independent review lease is read-only" };
	});

	pi.on("after_provider_response", (event) => {
		if (event.status === 429 || event.status >= 500) lastProviderFailure = "availability";
	});

	pi.on("agent_end", async (event, ctx) => {
		const active = state.active;
		if (!active) return;
		const assistants = event.messages.filter(assistantMessage);
		const isActiveAttempt =
			state.mode === "active" &&
			!state.manualOverride &&
			!active.manualOverride &&
			ctx.model?.provider === active.selected.provider &&
			ctx.model.id === active.selected.modelId;
		const relevant = isActiveAttempt
			? assistants.filter(
					(message) => message.provider === active.selected.provider && message.model === active.selected.modelId,
				)
			: assistants;
		const cost = relevant.reduce((total, message) => total + message.usage.cost.total, 0);
		const last = relevant.at(-1);
		const attemptedProvider = last?.provider ?? active.selected.provider;
		const attemptedModel = last?.model ?? active.selected.modelId;
		const wallTimeMs = attemptStartedAt > 0 ? Date.now() - attemptStartedAt : 0;
		const accumulatedCost = (accumulatedTaskCosts.get(active.taskId) ?? 0) + (isActiveAttempt ? cost : 0);
		if (isActiveAttempt) accumulatedTaskCosts.set(active.taskId, accumulatedCost);
		const accumulatedStartedAt =
			taskStartedAt.get(active.taskId) ?? (attemptStartedAt > 0 ? attemptStartedAt : Date.now());
		const accumulatedWallTimeMs = Date.now() - accumulatedStartedAt;
		lastAttemptMetrics = isActiveAttempt
			? {
					provider: attemptedProvider,
					modelId: attemptedModel,
					archetype: active.archetype,
					modelAndToolCost: accumulatedCost,
					wallTimeMs: Math.max(wallTimeMs, accumulatedWallTimeMs),
					retried: active.attemptIndex > 0,
				}
			: undefined;
		const inputTokens = relevant.reduce((total, message) => total + message.usage.input, 0);
		const cachedInputTokens = relevant.reduce((total, message) => total + message.usage.cacheRead, 0);
		await record(
			ctx,
			"attempt_completed",
			{
				shadow: !isActiveAttempt,
				proposedProvider: active.selected.provider,
				proposedModelId: active.selected.modelId,
				cost,
				wallTimeMs,
				inputTokens,
				cachedInputTokens,
				cacheHitRatio: inputTokens > 0 ? cachedInputTokens / inputTokens : 0,
				outputTokens: relevant.reduce((total, message) => total + message.usage.output, 0),
				turns: attemptTurns,
				toolCalls: attemptToolCalls,
				deterministicChecksPassed: [...deterministicCheckResults.values()].filter(Boolean).length,
				deterministicChecksFailed: [...deterministicCheckResults.values()].filter((passed) => !passed).length,
				stopReason: last?.stopReason,
			},
			{
				taskId: active.taskId,
				archetype: active.archetype,
				provider: attemptedProvider,
				modelId: attemptedModel,
				effort: isActiveAttempt ? active.selected.effort : pi.getThinkingLevel(),
				...(isActiveAttempt ? { promptProfileId: active.promptProfileId } : {}),
				policyVersion: active.policyVersion,
				modelSnapshotId: active.modelSnapshotId,
			},
		);
		const deterministicVerificationFailed =
			isActiveAttempt && [...deterministicCheckResults.values()].some((passed) => !passed);
		const planValidationMissing =
			isActiveAttempt &&
			(active.archetype === "implementation_planning" || active.archetype === "large_program_planning") &&
			!validatedPlanAttempts.has(`${active.taskId}:${active.attemptIndex}:${agentRunSequence}`);
		if (deterministicVerificationFailed || planValidationMissing) {
			attemptDisposition = "failed";
			await transitionFallback(ctx, "deterministic_verification", true);
		} else if (isActiveAttempt && (last?.stopReason === "error" || (!last && lastProviderFailure))) {
			attemptDisposition = "failed";
			const failure = lastProviderFailure ?? "model_error";
			lastProviderFailure = undefined;
			await transitionFallback(ctx, failure, true);
		} else if (isActiveAttempt && last?.stopReason === "length") {
			attemptDisposition = "failed";
			await transitionFallback(ctx, "quality", true);
		} else if (isActiveAttempt && last?.stopReason === "stop") {
			attemptDisposition = "success";
		} else if (isActiveAttempt && last?.stopReason === "aborted") {
			attemptDisposition = "aborted";
		} else {
			attemptDisposition = "incomplete";
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const active = state.active;
		if (!active || state.mode !== "active" || active.executionFailed) return;
		if (active.parentLease) {
			if (attemptDisposition === "success") await restoreParentAfterReview(ctx, active, "completed");
			else if (attemptDisposition === "aborted") await restoreParentAfterReview(ctx, active, "skipped");
			return;
		}
		if (attemptDisposition === "success" || attemptDisposition === "unknown") {
			await startIndependentReview(ctx, active);
		}
	});

	pi.registerCommand("route", {
		description: "Show or change model-router mode; record outcomes or trigger deterministic fallback",
		handler: async (args, ctx) => {
			const [command, value] = args.trim().split(/\s+/, 2);
			if (command === "active" || command === "shadow" || command === "off") {
				if (command === "active" && !telemetryHealthy) {
					ctx.ui.notify(
						"Router cannot enter active mode after a telemetry failure; reload after fixing the path",
						"error",
					);
					return;
				}
				state = {
					...state,
					mode: command,
					...(command === "active"
						? {
								manualOverride: false,
								...(state.active ? { active: { ...state.active, manualOverride: false } } : {}),
							}
						: {}),
				};
				if (command === "active" && state.active) {
					accumulatedTaskCosts.set(state.active.taskId, 0);
					taskStartedAt.set(state.active.taskId, Date.now());
				}
				persistState();
				updateStatus(ctx);
				ctx.ui.notify(`Model router mode set to ${command}`, "info");
				return;
			}
			if (command === "reset") {
				state = setHardBoundary({ mode: state.mode, manualOverride: false }, "new_session");
				persistState();
				updateStatus(ctx);
				ctx.ui.notify("Router lease cleared; next user input is a new task", "info");
				return;
			}
			if (command === "accept" || command === "reject") {
				if (!lastAttemptMetrics || !state.active) {
					ctx.ui.notify("No completed routed attempt is available to label", "warning");
					return;
				}
				await record(
					ctx,
					"outcome",
					{
						...lastAttemptMetrics,
						accepted: command === "accept",
						humanIntervention: command === "reject",
						contextBucket: state.active.contextSizeBucket ?? state.active.features.contextShape,
						risk: state.active.features.risk,
						interactivity: state.active.features.interactivity,
						languageBucket: state.active.repositoryLanguageBucket ?? "unknown",
					},
					{ taskId: state.active.taskId, archetype: state.active.archetype },
				);
				ctx.ui.notify(`Recorded routed attempt as ${command === "accept" ? "accepted" : "rejected"}`, "info");
				return;
			}
			if (
				command === "fail" &&
				(value === "availability" || value === "quality" || value === "deterministic_verification")
			) {
				await transitionFallback(ctx, value, true);
				return;
			}
			const lease = state.active;
			const detail = lease
				? [
						`mode=${state.mode}`,
						`task=${lease.taskId}`,
						`route=${lease.archetype}`,
						`model=${lease.selected.provider}/${lease.selected.modelId}`,
						`effort=${lease.selected.effort}`,
						`profile=${lease.promptProfileId}`,
						`attempt=${lease.attemptIndex + 1}/${lease.fallbacks.length + 1}`,
						`execution=${lease.executionFailed ? "failed" : "ready"}`,
						`boundary=${lastRoute.boundaryReason ?? "n/a"}`,
					].join("\n")
				: `mode=${state.mode}\nNo active task lease`;
			ctx.ui.notify(detail, "info");
		},
	});
}
