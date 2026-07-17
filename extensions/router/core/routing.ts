import type { Archetype } from "./archetype.ts";
import { BOOTSTRAP_ROUTE_POLICIES, type CandidateRef, POLICY_VERSION, reviewerRefs } from "./policy.ts";
import { type EffortLevel, findPromptProfile, type ModelVendor } from "./profiles.ts";

export interface RegistryModelSnapshot {
	provider: string;
	modelId: string;
	name: string;
	vendor: ModelVendor;
	contextWindow: number;
	maxOutputTokens: number;
	available: boolean;
	reasoning: boolean;
	supportedEfforts: readonly EffortLevel[];
	inputTypes: readonly ("text" | "image")[];
	toolCapable: boolean;
	costPerMillion: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

export interface RouteRequirements {
	estimatedFinishedTokens: number;
	requiresImages: boolean;
	requiresTools: boolean;
}

export type ExclusionCode =
	| "not_in_registry"
	| "unavailable"
	| "context_headroom"
	| "image_unsupported"
	| "tools_unsupported"
	| "effort_unsupported"
	| "profile_missing"
	| "duplicate_model"
	| "fallback_vendor";

export interface CandidateExclusion {
	candidate: string;
	code: ExclusionCode;
	detail: string;
}

export interface RouteChoice {
	provider: string;
	modelId: string;
	vendor: ModelVendor;
	effort: EffortLevel;
	ability: number;
	profileId: string;
	contextWindow: number;
	score?: number;
	rankReason: "bootstrap" | "telemetry" | "review_ability" | "fixed_builder_fallback";
}

export interface RouteSample {
	provider: string;
	modelId: string;
	archetype: Archetype;
	comparableSamples: number;
	acceptedRate: number;
	p75ModelAndToolCost: number;
	p75WallTimeMs: number;
	probabilityHumanIntervention: number;
	probabilityRetry: number;
}

export interface CostWeights {
	developerWaitValuePerMs: number;
	humanInterventionCost: number;
	retryCost: number;
}

export interface OrdinaryRouteDecision {
	kind: "ordinary";
	policyVersion: string;
	archetype: Archetype;
	primary: RouteChoice;
	fallback: RouteChoice;
	exclusions: CandidateExclusion[];
	telemetryMature: boolean;
}

export interface ReviewRouteDecision {
	kind: "review";
	policyVersion: string;
	archetype: "code_review";
	primary: RouteChoice;
	fallback: RouteChoice;
	builderFallback: RouteChoice;
	exclusions: CandidateExclusion[];
	telemetryMature: boolean;
	ceilingMismatchVendors: ModelVendor[];
}

export interface UnroutableDecision {
	kind: "unroutable";
	policyVersion: string;
	archetype: Archetype;
	reason: string;
	exclusions: CandidateExclusion[];
}

export type RouteDecision = OrdinaryRouteDecision | ReviewRouteDecision | UnroutableDecision;

const DEFAULT_COST_WEIGHTS: CostWeights = {
	developerWaitValuePerMs: 0,
	humanInterventionCost: 25,
	retryCost: 10,
};

export function canonicalVendor(provider: string, modelId: string): ModelVendor | undefined {
	const normalizedId = modelId.toLowerCase();
	if (normalizedId.startsWith("gpt-") || normalizedId.startsWith("o1") || normalizedId.startsWith("o3")) {
		return "openai";
	}
	if (normalizedId.startsWith("claude-")) return "anthropic";
	if (normalizedId.startsWith("gemini-")) return "google";
	if (provider === "openai" || provider === "openai-codex") return "openai";
	if (provider === "anthropic") return "anthropic";
	if (provider === "google" || provider === "google-vertex") return "google";
	return undefined;
}

export function robustCostToDone(sample: RouteSample, weights: CostWeights = DEFAULT_COST_WEIGHTS): number {
	return (
		sample.p75ModelAndToolCost +
		weights.developerWaitValuePerMs * sample.p75WallTimeMs +
		weights.humanInterventionCost * sample.probabilityHumanIntervention +
		weights.retryCost * sample.probabilityRetry
	);
}

function modelKey(model: Pick<RegistryModelSnapshot, "provider" | "modelId">): string {
	return `${model.provider}/${model.modelId}`;
}

function findSnapshot(
	ref: CandidateRef,
	registry: readonly RegistryModelSnapshot[],
): RegistryModelSnapshot | undefined {
	return registry.find((model) => model.provider === ref.provider && model.modelId === ref.modelId);
}

function evaluateCandidate(
	ref: CandidateRef,
	registry: readonly RegistryModelSnapshot[],
	archetype: Archetype,
	requirements: RouteRequirements,
	exclusions: CandidateExclusion[],
): RouteChoice | undefined {
	const key = `${ref.provider}/${ref.modelId}`;
	const model = findSnapshot(ref, registry);
	if (!model) {
		exclusions.push({ candidate: key, code: "not_in_registry", detail: "exact provider/model ID is absent" });
		return undefined;
	}
	if (!model.available) {
		exclusions.push({ candidate: key, code: "unavailable", detail: "endpoint auth/availability is not configured" });
		return undefined;
	}
	if (requirements.estimatedFinishedTokens > Math.floor(model.contextWindow * 0.7)) {
		exclusions.push({
			candidate: key,
			code: "context_headroom",
			detail: `${requirements.estimatedFinishedTokens} estimated tokens exceed 70% of ${model.contextWindow}`,
		});
		return undefined;
	}
	if (requirements.requiresImages && !model.inputTypes.includes("image")) {
		exclusions.push({ candidate: key, code: "image_unsupported", detail: "route includes image input" });
		return undefined;
	}
	if (requirements.requiresTools && !model.toolCapable) {
		exclusions.push({ candidate: key, code: "tools_unsupported", detail: "route requires tools" });
		return undefined;
	}
	if (!model.supportedEfforts.includes(ref.effort)) {
		exclusions.push({ candidate: key, code: "effort_unsupported", detail: `${ref.effort} effort is unsupported` });
		return undefined;
	}
	const profile = findPromptProfile(model.vendor, model.modelId, archetype, ref.effort);
	if (!profile) {
		exclusions.push({
			candidate: key,
			code: "profile_missing",
			detail: `no validated ${archetype}/${ref.effort} profile exists`,
		});
		return undefined;
	}
	return {
		provider: model.provider,
		modelId: model.modelId,
		vendor: model.vendor,
		effort: ref.effort,
		ability: ref.ability,
		profileId: profile.id,
		contextWindow: model.contextWindow,
		rankReason: "bootstrap",
	};
}

function deduplicateChoices(choices: readonly RouteChoice[], exclusions: CandidateExclusion[]): RouteChoice[] {
	const seen = new Set<string>();
	return choices.filter((choice) => {
		const key = `${choice.vendor}/${choice.modelId}`;
		if (seen.has(key)) {
			exclusions.push({
				candidate: `${choice.provider}/${choice.modelId}`,
				code: "duplicate_model",
				detail: "same vendor/model is already represented through another endpoint",
			});
			return false;
		}
		seen.add(key);
		return true;
	});
}

function telemetryOrder(
	choices: RouteChoice[],
	archetype: Archetype,
	qualityFloor: number,
	samples: readonly RouteSample[],
	weights?: CostWeights,
): { choices: RouteChoice[]; mature: boolean } {
	const comparable = choices.map((choice) =>
		samples.find(
			(sample) =>
				sample.provider === choice.provider && sample.modelId === choice.modelId && sample.archetype === archetype,
		),
	);
	const mature =
		choices.length > 0 &&
		comparable.every((sample) => sample && sample.comparableSamples >= 30 && sample.acceptedRate >= qualityFloor);
	if (!mature) return { choices, mature: false };

	return {
		mature: true,
		choices: choices
			.map((choice, index) => {
				const sample = comparable[index];
				return {
					...choice,
					score: sample ? robustCostToDone(sample, weights) : Number.POSITIVE_INFINITY,
					rankReason: "telemetry" as const,
				};
			})
			.sort((left, right) => (left.score ?? Number.POSITIVE_INFINITY) - (right.score ?? Number.POSITIVE_INFINITY)),
	};
}

export function selectOrdinaryRoute(
	archetype: Exclude<Archetype, "code_review">,
	registry: readonly RegistryModelSnapshot[],
	requirements: RouteRequirements,
	samples: readonly RouteSample[] = [],
	weights?: CostWeights,
): RouteDecision {
	const policy = BOOTSTRAP_ROUTE_POLICIES[archetype];
	const exclusions: CandidateExclusion[] = [];
	const evaluated = [...policy.primary, ...policy.fallback]
		.map((candidate) => evaluateCandidate(candidate, registry, archetype, requirements, exclusions))
		.filter((choice): choice is RouteChoice => choice !== undefined);
	const deduplicated = deduplicateChoices(evaluated, exclusions);
	const ranked = telemetryOrder(deduplicated, archetype, policy.qualityFloor, samples, weights);
	const primary = ranked.choices[0];
	const fallback = ranked.choices.find((choice) =>
		choice.vendor === "openai" || choice.vendor === "anthropic" ? choice.modelId !== primary?.modelId : false,
	);

	if (!primary || !fallback) {
		return {
			kind: "unroutable",
			policyVersion: POLICY_VERSION,
			archetype,
			reason: "two eligible ordinary choices, including an OpenAI/Anthropic fallback, were not available",
			exclusions,
		};
	}
	return {
		kind: "ordinary",
		policyVersion: POLICY_VERSION,
		archetype,
		primary,
		fallback,
		exclusions,
		telemetryMature: ranked.mature,
	};
}

function builderChoice(
	builder: RegistryModelSnapshot,
	builderEffort: EffortLevel,
	builderAbility: number,
): RouteChoice | undefined {
	const profile = findPromptProfile(builder.vendor, builder.modelId, "code_review", builderEffort);
	if (!profile) return undefined;
	return {
		provider: builder.provider,
		modelId: builder.modelId,
		vendor: builder.vendor,
		effort: builderEffort,
		ability: builderAbility,
		profileId: profile.id,
		contextWindow: builder.contextWindow,
		rankReason: "fixed_builder_fallback",
	};
}

export function selectReviewRoute(
	registry: readonly RegistryModelSnapshot[],
	requirements: RouteRequirements,
	builder: RegistryModelSnapshot,
	builderEffort: EffortLevel,
	builderAbility: number,
): RouteDecision {
	const exclusions: CandidateExclusion[] = [];
	const vendors = (["openai", "anthropic", "google"] as const).filter((vendor) => vendor !== builder.vendor);
	const ceilingMismatchVendors: ModelVendor[] = [];
	const choices: RouteChoice[] = [];

	for (const vendor of vendors) {
		const refsForVendor = reviewerRefs(vendor, builderAbility);
		const eligible = refsForVendor
			.map((ref) => evaluateCandidate(ref, registry, "code_review", requirements, exclusions))
			.find((choice): choice is RouteChoice => choice !== undefined);
		if (eligible) {
			if (eligible.ability < builderAbility) ceilingMismatchVendors.push(vendor);
			choices.push({ ...eligible, rankReason: "review_ability" });
		}
	}

	choices.sort((left, right) => {
		const leftDistance = Math.abs(left.ability - builderAbility);
		const rightDistance = Math.abs(right.ability - builderAbility);
		return leftDistance - rightDistance;
	});
	const fixedBuilder = builderChoice(builder, builderEffort, builderAbility);
	const primary = choices[0];
	const fallback = choices[1];
	if (choices.length !== 2 || !primary || !fallback || !fixedBuilder) {
		return {
			kind: "unroutable",
			policyVersion: POLICY_VERSION,
			archetype: "code_review",
			reason: "review requires two non-builder vendors and a validated fixed builder fallback",
			exclusions,
		};
	}
	return {
		kind: "review",
		policyVersion: POLICY_VERSION,
		archetype: "code_review",
		primary,
		fallback,
		builderFallback: fixedBuilder,
		exclusions,
		telemetryMature: false,
		ceilingMismatchVendors,
	};
}

export function registrySnapshotId(models: readonly RegistryModelSnapshot[]): string {
	return models
		.map((model) => `${modelKey(model)}:${model.contextWindow}:${model.available ? "1" : "0"}`)
		.sort()
		.join("|");
}
