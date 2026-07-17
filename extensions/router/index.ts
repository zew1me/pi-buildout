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
	repository: RepositoryMetadata;
	cache: { cachedTokens: number; expectedReuseRatio: number };
	hasImages: boolean;
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

function defaultMode(): RouterMode {
	const configured = process.env.PI_ROUTER_MODE;
	return configured === "off" || configured === "active" || configured === "shadow" ? configured : "shadow";
}

function assistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function currentTokens(ctx: ExtensionContext): number {
	return ctx.getContextUsage()?.tokens ?? 0;
}

function statusLabel(state: LeaseState): string {
	const lease = state.active;
	if (!lease) return `route:${state.mode}`;
	return `route:${state.mode} ${lease.selected.vendor}/${lease.selected.modelId} ${lease.selected.effort}`;
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
	let lastRoute: LastRoute = {};
	let lastUpstream: string | undefined;
	let applyingSelection = false;
	let lastProviderFailure: FailureKind | undefined;
	let attemptStartedAt = 0;
	let attemptTurns = 0;
	let attemptToolCalls = 0;
	let lastAttemptMetrics: AttemptMetrics | undefined;

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

	async function record(
		ctx: ExtensionContext,
		kind: RouterTelemetryEvent["kind"],
		data: Record<string, unknown>,
		extra: Partial<
			Omit<RouterTelemetryEvent, "version" | "eventId" | "timestamp" | "kind" | "sessionId" | "data">
		> = {},
	): Promise<void> {
		await telemetry.append({
			version: 1,
			eventId: randomUUID(),
			timestamp: new Date().toISOString(),
			kind,
			sessionId: ctx.sessionManager.getSessionId(),
			...extra,
			data,
		});
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
	): Promise<{ decision: RouteDecision; registry: RegistryModelSnapshot[] }> {
		const registry = buildRegistrySnapshot(ctx);
		const requirements = routeRequirements(currentTokens(ctx), classification.features, hasImages);
		const routeSamples: RouteSample[] = aggregateRouteSamples(telemetryOutcomes(await telemetry.read()));
		const archetype = classification.archetype.archetype;
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
			decision: selectOrdinaryRoute(archetype, registry, requirements, routeSamples),
		};
	}

	async function applyChoice(ctx: ExtensionContext, choice: RouteChoice): Promise<boolean> {
		if (ctx.model?.provider === choice.provider && ctx.model.id === choice.modelId) {
			if (pi.getThinkingLevel() !== choice.effort) {
				applyingSelection = true;
				try {
					pi.setThinkingLevel(choice.effort);
				} finally {
					applyingSelection = false;
				}
			}
			return true;
		}
		const model = ctx.modelRegistry.find(choice.provider, choice.modelId);
		if (!model) return false;
		applyingSelection = true;
		try {
			const selected = await pi.setModel(model);
			if (!selected) return false;
			pi.setThinkingLevel(choice.effort);
			return true;
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
				{ action: fallback.action, reason: fallback.reason, failure: "availability" },
				{ taskId: candidate.taskId, archetype: candidate.archetype },
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
				...(fallback.action === "use_choice" ? { reviewFellBackToBuilder: fallback.reviewFellBackToBuilder } : {}),
			},
			{ taskId: active.taskId, archetype: active.archetype },
		);
		if (fallback.action === "use_choice") {
			if (!(await applyChoice(ctx, fallback.choice))) return;
			state = installLease(state, fallback.lease);
			attemptStartedAt = Date.now();
			attemptTurns = 0;
			attemptToolCalls = 0;
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
		if (fallback.action === "restore_previous" && fallback.choice) await applyChoice(ctx, fallback.choice);
		if (fallback.action === "skip_review" && active.parentLease) {
			await restoreParentAfterReview(ctx, active, "skipped");
		}
		ctx.ui.notify(fallback.reason, fallback.action === "skip_review" ? "warning" : "error");
	}

	async function startIndependentReview(ctx: ExtensionContext, parent: TaskLease): Promise<void> {
		if (
			state.mode !== "active" ||
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
				{ taskId: parent.taskId, archetype: parent.archetype },
			);
			return;
		}
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
		});
		const applied = await applyWithAvailabilityFallback(ctx, child);
		if (!applied) {
			await restoreParentAfterReview(ctx, child, "skipped");
			return;
		}
		state = installLease(state, applied);
		persistState();
		updateStatus(ctx);
		attemptStartedAt = Date.now();
		attemptTurns = 0;
		attemptToolCalls = 0;
		await record(
			ctx,
			"route_decision",
			{
				kind: "required_independent_review",
				parentTaskId: parent.taskId,
				fallbacks: applied.fallbacks.map((choice) => `${choice.provider}/${choice.modelId}`),
			},
			{
				taskId: applied.taskId,
				archetype: "code_review",
				provider: applied.selected.provider,
				modelId: applied.selected.modelId,
				promptProfileId: applied.promptProfileId,
			},
		);
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

	pi.on("session_start", async (event, ctx) => {
		state = restoreLeaseState(ctx.sessionManager.getBranch(), defaultMode());
		if (event.reason !== "reload") state = setHardBoundary(state, "new_session");
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
		state = setHardBoundary(state, "subagent");
		persistState();
		await record(ctx, "boundary", { boundary: "subagent" }, state.active ? { taskId: state.active.taskId } : {});
	});

	pi.on("input", async (event, ctx) => {
		if (state.mode === "off") return { action: "continue" as const };
		const repository = await readRepositoryMetadata(pi, ctx.cwd);
		if (lastUpstream && repository.upstream && repository.upstream !== lastUpstream) {
			state = setHardBoundary(state, "post_push");
		}
		lastUpstream = repository.upstream;
		const entries = ctx.sessionManager.getBranch();
		const cache = cacheEstimate(entries);
		const gate = deterministicBoundaryGate(state, {
			isUserInput: true,
			source: event.source,
			...(event.streamingBehavior ? { streamingBehavior: event.streamingBehavior } : {}),
			prompt: event.text,
			cachedTokens: cache.cachedTokens,
			expectedReuseRatio: cache.expectedReuseRatio,
		});
		pendingInput = { gate, repository, cache, hasImages: Boolean(event.images?.length) };
		lastRoute = { boundaryReason: gate.reason };
		await record(
			ctx,
			"boundary",
			{ action: gate.action, reason: gate.reason, cache, source: event.source },
			state.active ? { taskId: state.active.taskId } : {},
		);
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (state.mode === "off") return;
		const pending = pendingInput;
		pendingInput = undefined;
		const repository = pending?.repository ?? (await readRepositoryMetadata(pi, ctx.cwd));
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
			const routed = await route(ctx, classification, pending?.hasImages ?? Boolean(event.images?.length));
			lastRoute = { ...lastRoute, classification, decision: routed.decision };
			if (routed.decision.kind === "unroutable") {
				await record(
					ctx,
					"route_decision",
					{ kind: "unroutable", reason: routed.decision.reason, exclusions: routed.decision.exclusions },
					{ archetype: routed.decision.archetype, policyVersion: routed.decision.policyVersion },
				);
				ctx.ui.notify(`Router retained current model: ${routed.decision.reason}`, "warning");
				return;
			}
			const now = new Date().toISOString();
			const currentSnapshot = snapshotForModel(ctx.model, routed.registry);
			const currentEffort = pi.getThinkingLevel() as EffortLevel;
			const priorSelection = previousChoice(currentSnapshot, currentEffort, routed.decision.archetype);
			const lease = createTaskLease({
				taskId: randomUUID(),
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
			});
			state = installLease(state, lease);
			persistState();
			active = lease;
			attemptStartedAt = Date.now();
			attemptTurns = 0;
			attemptToolCalls = 0;
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
					fallbacks: lease.fallbacks.map((choice) => `${choice.provider}/${choice.modelId}`),
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
		updateStatus(ctx);
		if (state.mode === "shadow") {
			ctx.ui.notify(
				`Shadow route: ${active.archetype} → ${active.selected.provider}/${active.selected.modelId} (${active.selected.effort})`,
				"info",
			);
			return;
		}
		const applied = await applyWithAvailabilityFallback(ctx, active);
		if (!applied) return;
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
	});

	pi.on("model_select", async (event, ctx) => {
		if (applyingSelection || event.source === "restore") return;
		state = markManualOverride(state);
		persistState();
		updateStatus(ctx);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		if (applyingSelection) return;
		state = markManualOverride(state);
		persistState();
		updateStatus(ctx);
	});

	pi.on("agent_start", () => {
		lastProviderFailure = undefined;
		if (attemptStartedAt === 0) attemptStartedAt = Date.now();
	});

	pi.on("turn_start", () => {
		attemptTurns++;
	});

	pi.on("tool_execution_end", () => {
		attemptToolCalls++;
	});

	pi.on("tool_call", (event) => {
		if (!state.active?.parentLease) return;
		if (event.toolName === "edit" || event.toolName === "write") {
			return { block: true, reason: "Independent review lease is read-only" };
		}
	});

	pi.on("after_provider_response", (event) => {
		if (event.status === 429 || event.status >= 500) lastProviderFailure = "availability";
	});

	pi.on("agent_end", async (event, ctx) => {
		const active = state.active;
		if (!active) return;
		const assistants = event.messages.filter(assistantMessage);
		const relevant = assistants.filter(
			(message) => message.provider === active.selected.provider && message.model === active.selected.modelId,
		);
		const cost = relevant.reduce((total, message) => total + message.usage.cost.total, 0);
		const last = relevant.at(-1);
		lastAttemptMetrics = {
			provider: active.selected.provider,
			modelId: active.selected.modelId,
			archetype: active.archetype,
			modelAndToolCost: cost,
			wallTimeMs: attemptStartedAt > 0 ? Date.now() - attemptStartedAt : 0,
			retried: active.attemptIndex > 0,
		};
		await record(
			ctx,
			"attempt_completed",
			{
				cost,
				wallTimeMs: lastAttemptMetrics.wallTimeMs,
				inputTokens: relevant.reduce((total, message) => total + message.usage.input, 0),
				cachedInputTokens: relevant.reduce((total, message) => total + message.usage.cacheRead, 0),
				outputTokens: relevant.reduce((total, message) => total + message.usage.output, 0),
				turns: attemptTurns,
				toolCalls: attemptToolCalls,
				stopReason: last?.stopReason,
			},
			{
				taskId: active.taskId,
				archetype: active.archetype,
				provider: active.selected.provider,
				modelId: active.selected.modelId,
				effort: active.selected.effort,
				promptProfileId: active.promptProfileId,
			},
		);
		if (state.mode === "active" && last?.stopReason === "error") {
			const failure = lastProviderFailure ?? "model_error";
			lastProviderFailure = undefined;
			await transitionFallback(ctx, failure, true);
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const active = state.active;
		if (!active || state.mode !== "active") return;
		if (active.parentLease) {
			await restoreParentAfterReview(ctx, active, "completed");
			return;
		}
		await startIndependentReview(ctx, active);
	});

	pi.registerCommand("route", {
		description: "Show or change model-router mode; record outcomes or trigger deterministic fallback",
		handler: async (args, ctx) => {
			const [command, value] = args.trim().split(/\s+/, 2);
			if (command === "active" || command === "shadow" || command === "off") {
				state = { ...state, mode: command };
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
						`boundary=${lastRoute.boundaryReason ?? "n/a"}`,
					].join("\n")
				: `mode=${state.mode}\nNo active task lease`;
			ctx.ui.notify(detail, "info");
		},
	});
}
