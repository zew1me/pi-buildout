import type { Archetype } from "./archetype.ts";
import { BOOTSTRAP_ROUTE_POLICIES, POLICY_VERSION, reviewerRefs } from "./policy.ts";
import type { CandidateRef } from "./policy.ts";
import { findPromptProfile } from "./profiles.ts";
import type { EffortLevel, ModelVendor } from "./profiles.ts";

export type RegistryModelSnapshot = {
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
};

export type RouteRequirements = {
  estimatedFinishedTokens: number;
  requiresImages: boolean;
  requiresTools: boolean;
};

type ExclusionCode =
  | "not_in_registry"
  | "unavailable"
  | "context_headroom"
  | "image_unsupported"
  | "tools_unsupported"
  | "effort_unsupported"
  | "profile_missing"
  | "duplicate_model"
  | "fallback_vendor";

type CandidateExclusion = {
  candidate: string;
  code: ExclusionCode;
  detail: string;
};

type RouteScoreComponents = {
  p75ModelAndToolCost: number;
  developerWaitCost: number;
  humanInterventionCost: number;
  retryCost: number;
};

export type RouteChoice = {
  provider: string;
  modelId: string;
  vendor: ModelVendor;
  effort: EffortLevel;
  ability: number;
  profileId: string;
  contextWindow: number;
  score?: number;
  scoreComponents?: RouteScoreComponents;
  rankReason: "bootstrap" | "telemetry" | "controlled_holdout" | "review_ability" | "fixed_builder_fallback";
};

export type RouteSample = {
  provider: string;
  modelId: string;
  archetype: Archetype;
  contextBucket?: string;
  risk?: string;
  interactivity?: string;
  languageBucket?: string;
  comparableSamples: number;
  acceptedRate: number;
  p50ModelAndToolCost?: number;
  p75ModelAndToolCost: number;
  p90ModelAndToolCost?: number;
  p50WallTimeMs?: number;
  p75WallTimeMs: number;
  p90WallTimeMs?: number;
  probabilityHumanIntervention: number;
  probabilityRetry: number;
};

export type CostWeights = {
  developerWaitValuePerMs: number;
  humanInterventionCost: number;
  retryCost: number;
};

type OrdinaryRouteDecision = {
  kind: "ordinary";
  policyVersion: string;
  archetype: Archetype;
  primary: RouteChoice;
  // Every eligible endpoint after the selected primary remains authorized for
  // sequential availability recovery. This includes alternate providers for
  // the same model, which is essential when one provider's credentials fail.
  fallbacks: RouteChoice[];
  exclusions: CandidateExclusion[];
  telemetryMature: boolean;
  controlledHoldout: boolean;
};

type ReviewRouteDecision = {
  kind: "review";
  policyVersion: string;
  archetype: "code_review";
  primary: RouteChoice;
  fallback: RouteChoice;
  builderFallback: RouteChoice;
  exclusions: CandidateExclusion[];
  telemetryMature: boolean;
  ceilingMismatchVendors: ModelVendor[];
};

type UnroutableDecision = {
  kind: "unroutable";
  policyVersion: string;
  archetype: Archetype;
  reason: string;
  exclusions: CandidateExclusion[];
};

export type RouteDecision = OrdinaryRouteDecision | ReviewRouteDecision | UnroutableDecision;

const DEFAULT_COST_WEIGHTS: CostWeights = {
  developerWaitValuePerMs: 0.000_001,
  humanInterventionCost: 25,
  retryCost: 10,
};

// Amazon Bedrock cross-region inference profiles prefix the underlying vendor path with a
// region code ("us.", "eu.", "au.", "jp.", "global."). Strip it only when it is immediately
// followed by a known vendor path segment so unrelated IDs are not misparsed.
const BEDROCK_REGION_PREFIX = /^(?:us|eu|au|jp|apac|global)\.(?=anthropic\.|openai\.|amazon\.)/;

export function canonicalVendor(provider: string, modelId: string): ModelVendor | undefined {
  const normalizedId = modelId.toLowerCase();
  const bareId = (normalizedId.split("/").at(-1) ?? normalizedId).replace(BEDROCK_REGION_PREFIX, "");
  if (
    bareId.startsWith("gpt-") ||
    bareId.startsWith("openai.gpt-") ||
    bareId.startsWith("o1") ||
    bareId.startsWith("o3")
  ) {
    return "openai";
  }
  if (bareId.startsWith("claude-") || bareId.startsWith("anthropic.claude-")) return "anthropic";
  if (bareId.startsWith("gemini-")) return "google";
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
      detail: `${String(requirements.estimatedFinishedTokens)} estimated tokens exceed 70% of ${String(model.contextWindow)}`,
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
    // Deduplicate only an exact endpoint. Different providers for one model
    // are deliberate availability fallbacks, not duplicate route choices.
    const key = `${choice.provider}/${choice.modelId}`;
    if (seen.has(key)) {
      exclusions.push({
        candidate: key,
        code: "duplicate_model",
        detail: "the exact provider/model endpoint is listed more than once",
      });
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function isControlledHoldout(key: string, oneIn = 20): boolean {
  let hash = 2166136261;
  for (const character of key) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % Math.max(1, oneIn) === 0;
}

function telemetryOrder(
  choices: RouteChoice[],
  archetype: Archetype,
  qualityFloor: number,
  samples: readonly RouteSample[],
  weights?: CostWeights,
  explorationKey?: string,
): { choices: RouteChoice[]; mature: boolean; controlledHoldout: boolean } {
  const comparable = choices.map((choice) =>
    samples.find(
      (sample) =>
        sample.provider === choice.provider && sample.modelId === choice.modelId && sample.archetype === archetype,
    ),
  );
  const mature =
    choices.length > 0 &&
    comparable.every((sample) => sample && sample.comparableSamples >= 30 && sample.acceptedRate >= qualityFloor);
  if (!mature) return { choices, mature: false, controlledHoldout: false };

  const appliedWeights = weights ?? DEFAULT_COST_WEIGHTS;
  const scored = choices.map((choice, index) => {
    const sample = comparable[index];
    if (!sample) throw new Error("mature route is missing its comparable telemetry sample");
    return {
      ...choice,
      score: robustCostToDone(sample, appliedWeights),
      scoreComponents: {
        p75ModelAndToolCost: sample.p75ModelAndToolCost,
        developerWaitCost: appliedWeights.developerWaitValuePerMs * sample.p75WallTimeMs,
        humanInterventionCost: appliedWeights.humanInterventionCost * sample.probabilityHumanIntervention,
        retryCost: appliedWeights.retryCost * sample.probabilityRetry,
      },
      rankReason: "telemetry" as const,
    };
  });
  const controlledHoldout = explorationKey ? isControlledHoldout(explorationKey) : false;
  return {
    mature: true,
    controlledHoldout,
    choices: controlledHoldout
      ? scored.map((choice) => ({ ...choice, rankReason: "controlled_holdout" as const }))
      : scored.sort((left, right) => left.score - right.score),
  };
}

export function selectOrdinaryRoute(
  archetype: Exclude<Archetype, "code_review">,
  registry: readonly RegistryModelSnapshot[],
  requirements: RouteRequirements,
  samples: readonly RouteSample[] = [],
  weights?: CostWeights,
  explorationKey?: string,
): RouteDecision {
  const policy = BOOTSTRAP_ROUTE_POLICIES[archetype];
  const exclusions: CandidateExclusion[] = [];
  const evaluated = [...policy.primary, ...policy.fallback]
    .map((candidate) => evaluateCandidate(candidate, registry, archetype, requirements, exclusions))
    .filter((choice): choice is RouteChoice => choice !== undefined);
  const deduplicated = deduplicateChoices(evaluated, exclusions);
  const ranked = telemetryOrder(deduplicated, archetype, policy.qualityFloor, samples, weights, explorationKey);
  const [primary, ...fallbacks] = ranked.choices;

  if (!primary || fallbacks.length === 0) {
    return {
      kind: "unroutable",
      policyVersion: POLICY_VERSION,
      archetype,
      reason: "a primary and at least one eligible fallback endpoint were not available",
      exclusions,
    };
  }
  return {
    kind: "ordinary",
    policyVersion: POLICY_VERSION,
    archetype,
    primary,
    fallbacks,
    exclusions,
    telemetryMature: ranked.mature,
    controlledHoldout: ranked.controlledHoldout,
  };
}

function builderChoice(
  builder: RegistryModelSnapshot,
  builderEffort: EffortLevel,
  builderAbility: number,
  registry: readonly RegistryModelSnapshot[],
  requirements: RouteRequirements,
  exclusions: CandidateExclusion[],
): RouteChoice | undefined {
  const ability = Math.max(1, Math.min(4, Math.round(builderAbility))) as CandidateRef["ability"];
  const eligible = evaluateCandidate(
    {
      provider: builder.provider,
      modelId: builder.modelId,
      vendor: builder.vendor,
      effort: builderEffort,
      ability,
      allowAlias: false,
      restricted: false,
    },
    registry,
    "code_review",
    requirements,
    exclusions,
  );
  return eligible ? { ...eligible, rankReason: "fixed_builder_fallback" } : undefined;
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
  const fixedBuilder = builderChoice(builder, builderEffort, builderAbility, registry, requirements, exclusions);
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
  const canonical = models
    .map(
      (model) =>
        `${modelKey(model)}:${String(model.contextWindow)}:${String(model.maxOutputTokens)}:${model.available ? "1" : "0"}:${model.supportedEfforts.join(",")}`,
    )
    .sort()
    .join("|");
  let first = 2166136261;
  let second = 2246822507;
  for (const character of canonical) {
    const code = character.codePointAt(0) ?? 0;
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489909);
  }
  return `registry-v1:${String(models.length)}:${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}
