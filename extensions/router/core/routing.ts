import type { Archetype } from "./archetype.ts";
import {
  authorizeEffort,
  consequenceRank,
  findEvidencePrior,
  languageEvidence,
  resolveEvidenceLanguage,
  scoreEvidencePrior,
} from "./evidence.ts";
import type { ConsequenceTier, EvidenceCostWeights, EvidenceScoreContext, RoutableLanguage } from "./evidence.ts";
import type { TaskFeatures } from "./features.ts";
import { blendedEndpointCost, calculateEndpointEffectiveCost, compareEndpointEffectiveCost } from "./endpoint-cost.ts";
import { healthVerdict } from "./health.ts";
import type { EndpointHealth } from "./health.ts";
import { providerWeightFor } from "./provider-weights.ts";
import type { ResolvedProviderWeight } from "./provider-weights.ts";
import {
  BOOTSTRAP_ROUTE_POLICIES,
  HARD_TASK_ESCALATION_REFS,
  POLICY_VERSION,
  reviewerRefs,
  reviewerVendors,
} from "./policy.ts";
import type { CandidateRef, EndpointTier } from "./policy.ts";
import { findPromptProfile } from "./profiles.ts";
import { canonicalModelId, endpointTierFor } from "./scope.ts";
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
  /** Validated route weight applied only to endpoint effective cost. */
  providerWeight?: ResolvedProviderWeight;
  /** Last observed outcome for this endpoint, from the probe record. Absent means never probed. */
  health?: EndpointHealth;
};

export type RouteRequirements = {
  estimatedFinishedTokens: number;
  requiresImages: boolean;
  requiresTools: boolean;
};

type ExclusionCode =
  | "not_in_registry"
  | "not_in_scope"
  | "endpoint_unhealthy"
  | "endpoint_pricing_invalid"
  | "unavailable"
  | "context_headroom"
  | "context_headroom_prior"
  | "long_context_pricing_unavailable"
  | "image_unsupported"
  | "tools_unsupported"
  | "effort_unsupported"
  | "effort_unauthorized"
  | "thrash_guard"
  | "scope_unmet"
  | "escalation_without_primary"
  | "profile_missing"
  | "provider_restricted"
  | "duplicate_model";

export type CandidateExclusion = {
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
  /** Manufacturer model ID shared by every endpoint serving this model. */
  logicalModelId: string;
  vendor: ModelVendor;
  effort: EffortLevel;
  ability: number;
  profileId: string;
  contextWindow: number;
  endpointTier: EndpointTier;
  /** Blended per-million route price, absent for flat-rate subscription endpoints. */
  endpointBlendedCost?: number;
  /** Weighted per-million ordering cost, optional for lease compatibility and absent for flat-rate endpoints. */
  endpointEffectiveCost?: number;
  /** Authorized as a retry only; never placed in the primary slot. */
  escalationOnly?: boolean;
  /** Authorized only where step count rather than token cost is the binding constraint. */
  scopedFrugal?: boolean;
  /** Backed only by single-attempt evidence; authorized for read-only consequence only. */
  singleAttemptEvidence?: boolean;
  score?: number;
  scoreComponents?: RouteScoreComponents;
  evidenceScore?: number;
  evidenceLanguage?: RoutableLanguage;
  rankReason: "bootstrap" | "evidence_prior" | "telemetry" | "controlled_holdout" | "review_ability";
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
  /**
   * Remaining independent reviewers in preference order. Sequential attempts, never a panel. The
   * chain is not a fixed length: it holds one entry per eligible non-builder vendor beyond the
   * primary, so a larger supported vendor set yields a longer chain rather than an unroutable review.
   */
  fallbacks: RouteChoice[];
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

/**
 * Evidence-prior weights extend the telemetry weights with two axes the priors can price and
 * observed samples cannot yet: measured regression breakage on repository-mutating work, and
 * measured nondeterminism on unattended work.
 */
const DEFAULT_EVIDENCE_WEIGHTS: EvidenceCostWeights = {
  ...DEFAULT_COST_WEIGHTS,
  regressionBreakCost: 40,
  nondeterminismCost: 15,
};

/** Foreground developer loops price wall time far higher than background work. */
const FOREGROUND_WAIT_MULTIPLIER = 8;

/**
 * Default closeness required before a weakly evidenced language tendency may reorder two candidates.
 * Bounded deliberately: a low-power directional prior should settle a near-tie, never override a
 * measured cost difference. A language may widen this from its own evidence.
 */
const DEFAULT_NEAR_TIE_FRACTION = 0.05;

/**
 * These Bedrock GPT routes expose only their short-context rate; direct OpenAI changes tiers above
 * this boundary. Pi 0.85.1 widened the Bedrock context windows to 1,050,000 without adding a tier.
 */
const BEDROCK_GPT_SHORT_CONTEXT_LIMIT = 272_000;
const BEDROCK_GPT_MODELS: ReadonlySet<string> = new Set([
  "gpt-6.2-astra",
  "gpt-6.2-sol",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-5.6-terra",
  "gpt-6-luna",
]);

/** Applies the missing-price guard to both new route selection and persisted-lease revalidation. */
export function bedrockLongContextPricingUnavailable(
  model: Pick<RegistryModelSnapshot, "provider" | "modelId">,
  estimatedFinishedTokens: number,
): boolean {
  return (
    model.provider === "amazon-bedrock" &&
    BEDROCK_GPT_MODELS.has(canonicalModelId(model.modelId)) &&
    estimatedFinishedTokens > BEDROCK_GPT_SHORT_CONTEXT_LIMIT
  );
}

/**
 * Task shape that modifies scoring without changing which models are policy-authorized. Derived
 * from trusted harness state and classifier features by the extension, never from route cost.
 */
export type RoutingContext = {
  /** Present only when the repository resolves to exactly one measured language. */
  language?: RoutableLanguage | undefined;
  /** High ambiguity or high complexity work; selects the measured hard-task priors. */
  hardTask: boolean;
  /** Autonomous work where a non-deterministic pass is not usable. */
  unattended: boolean;
  /** Foreground developer loop, where wall time dominates. */
  foreground: boolean;
  /** What a wrong result costs, derived from the task's action mode and risk. */
  consequence: ConsequenceTier;
  /** Multiplier on the regression term, lowered when the task runs the tests that would catch it. */
  verificationDiscount: number;
};

/** Review produces findings rather than state changes, so it is evaluated as read-only work. */
const REVIEW_CONTEXT: RoutingContext = {
  hardTask: false,
  unattended: false,
  foreground: false,
  consequence: "read_only",
  verificationDiscount: 1,
};

const DEFAULT_ROUTING_CONTEXT: RoutingContext = {
  hardTask: false,
  unattended: false,
  foreground: false,
  // Conservative default: assume a wrong answer changes reversible state and that nothing verifies it.
  consequence: "reversible",
  verificationDiscount: 1,
};

/**
 * An archetype that always changes repository state cannot be softened to read-only by a classifier
 * that under-reads the task, so the effective consequence is the stronger of the two signals.
 */
function effectiveConsequence(archetype: Archetype, context: RoutingContext): ConsequenceTier {
  const floor: ConsequenceTier = BOOTSTRAP_ROUTE_POLICIES[archetype].mutatesRepository ? "reversible" : "read_only";
  return consequenceRank(context.consequence) >= consequenceRank(floor) ? context.consequence : floor;
}

/**
 * Derives the scoring context from trusted harness state and classifier features. It changes how
 * authorized candidates are ordered; it never adds or removes a candidate, and it never consults
 * route price.
 */
export function deriveRoutingContext(
  features: Pick<
    TaskFeatures,
    "ambiguity" | "interactivity" | "actionMode" | "risk" | "verificationStrength" | "horizon" | "expectedAgentTurns"
  >,
  languageBuckets: readonly string[],
): RoutingContext {
  const language = resolveEvidenceLanguage(languageBuckets);
  return {
    ...DEFAULT_ROUTING_CONTEXT,
    ...(language ? { language } : {}),
    // High ambiguity is the classifier's own signal that the task resembles the corpus's hard tail.
    hardTask: features.ambiguity === "high",
    // Autonomous work cannot rely on a human noticing a non-deterministic pass.
    unattended: features.interactivity === "autonomous",
    foreground: features.interactivity === "developer_loop",
    consequence: consequenceOf(features),
    verificationDiscount: verificationDiscountOf(features),
  };
}

/**
 * Consequence is about what a wrong result costs, so it reads the action mode first and lets critical
 * risk escalate. `information_only` and `local_read` genuinely cannot break anything, which is what
 * makes the cheapest adequate configuration correct for classification and extraction work.
 */
// Only `critical` risk escalates. `high` risk is deliberately left to the action mode, because a
// high-risk read or a high-risk reversible edit is still recoverable, and the archetypes where high
// risk matters most already require an independent review under the risk policy in archetype.ts.
function consequenceOf(features: Pick<TaskFeatures, "actionMode" | "risk">): ConsequenceTier {
  if (features.actionMode === "external_side_effect" || features.actionMode === "destructive") return "irreversible";
  if (features.risk === "critical") return "irreversible";
  if (features.actionMode === "reversible_mutation") return "reversible";
  return "read_only";
}

/**
 * Measured regression breakage is exactly "previously passing tests now fail". A task that runs those
 * tests catches it inside the loop; a task with no verification ships it. The discount is deliberately
 * partial, because a test suite is not a complete guard against silent behavior change.
 */
function verificationDiscountOf(features: Pick<TaskFeatures, "verificationStrength">): number {
  switch (features.verificationStrength) {
    case "security_and_policy":
    case "integration_tests":
      return 0.25;
    case "unit_tests":
      return 0.5;
    case "self_check":
      return 0.85;
    default:
      return 1;
  }
}

function evidenceScoreContext(archetype: Archetype, context: RoutingContext): EvidenceScoreContext {
  return {
    language: context.language,
    consequence: effectiveConsequence(archetype, context),
    verificationDiscount: context.verificationDiscount,
    unattended: context.unattended,
    waitMultiplier: context.foreground ? FOREGROUND_WAIT_MULTIPLIER : 1,
    hardTask: context.hardTask,
  };
}

// Amazon Bedrock cross-region inference profiles prefix the underlying vendor path with a
// region code ("us.", "eu.", "au.", "jp.", "global."). Strip it only when it is immediately
// followed by a known vendor path segment so unrelated IDs are not misparsed.
const BEDROCK_REGION_PREFIX =
  /^(?:us|eu|au|jp|apac|global)\.(?=anthropic\.|openai\.|amazon\.|moonshot\.|moonshotai\.|minimax\.|xai\.|zai\.|qwen\.|nvidia\.)/;

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
  if (bareId.startsWith("kimi-") || bareId.startsWith("moonshot.kimi-") || bareId.startsWith("moonshotai.kimi-")) {
    return "moonshot";
  }
  // Bedrock spells MiniMax models `minimax.minimax-m2.5`, so the vendor segment and the model's own
  // brand token are the same word; the bare form `minimax-m2.5` carries only the latter. Both must
  // resolve, because buildRegistrySnapshot drops any endpoint whose vendor is unknown, and a dropped
  // endpoint is invisible rather than excluded with a reason.
  if (bareId.startsWith("minimax-") || bareId.startsWith("minimax.minimax-")) return "minimax";
  // Bedrock prefixes each of these with its vendor path segment; gateways such as GitHub Copilot use
  // the bare model token. Both spellings must resolve for the same reason as MiniMax above.
  if (bareId.startsWith("grok-") || bareId.startsWith("xai.grok-")) return "xai";
  if (bareId.startsWith("glm-") || bareId.startsWith("zai.glm-")) return "zai";
  if (/^qwen[\d-]/.test(bareId) || bareId.startsWith("qwen.qwen")) return "qwen";
  if (bareId.startsWith("nemotron-") || bareId.startsWith("nvidia.nemotron-")) return "nvidia";
  // Microsoft AI's MAI models, reached through GitHub Copilot as `mai-code-1.1-flash`.
  if (bareId.startsWith("mai-")) return "microsoft";
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

function effectiveProviderWeight(model: RegistryModelSnapshot): ResolvedProviderWeight {
  // Pure routing tests and callers built before scope metadata was introduced remain compatible; a
  // snapshot produced by buildRegistrySnapshot always carries the validated configured resolution.
  return model.providerWeight ?? providerWeightFor(model.provider);
}

type EligibleResolvedEndpoint = {
  model: RegistryModelSnapshot;
  choice: RouteChoice;
};

/**
 * Orders already-eligible, validly priced registry endpoints by weighted effective cost. First-party
 * tier, specificity, and exact endpoint identity provide deterministic tie-breaks, and flat-rate
 * subscription endpoints remain last because their modeled token price is a capability proxy.
 *
 * The registry candidates have already been scoped to the operator's `enabledModels` and evaluated
 * before reaching this function. Keeping eligibility ahead of comparison ensures an unsupported,
 * unhealthy, or malformed endpoint can neither win nor disrupt ordering of the valid endpoints.
 */
function resolveEndpoints(endpoints: readonly EligibleResolvedEndpoint[]): EligibleResolvedEndpoint[] {
  return [...endpoints].sort((left, right) => compareEndpointEffectiveCost(left.choice, right.choice));
}

function evaluateEndpoint(
  ref: CandidateRef,
  model: RegistryModelSnapshot,
  archetype: Archetype,
  requirements: RouteRequirements,
  exclusions: CandidateExclusion[],
  context: RoutingContext = DEFAULT_ROUTING_CONTEXT,
): RouteChoice | undefined {
  const key = `${model.provider}/${model.modelId}`;
  if (!model.available) {
    exclusions.push({ candidate: key, code: "unavailable", detail: "endpoint auth/availability is not configured" });
    return undefined;
  }
  // The direct Gemini API has a low operator quota and is reserved for review work, where an
  // independent Google opinion is uniquely useful. Vertex and other scoped provider surfaces do not
  // share that restriction, so ordinary Gemini routes may still use them.
  if (model.provider === "google" && archetype !== "code_review") {
    exclusions.push({
      candidate: key,
      code: "provider_restricted",
      detail: "direct Google endpoints are reserved for code review",
    });
    return undefined;
  }
  const health = healthVerdict(model.health);
  if (!health.usable) {
    exclusions.push({ candidate: key, code: "endpoint_unhealthy", detail: health.reason });
    return undefined;
  }
  const policy = BOOTSTRAP_ROUTE_POLICIES[archetype];
  // A scoped frugal candidate exists for tasks whose context headroom is already tight, where fewer
  // steps means a lower peak context. Outside that condition it is strictly worse than the current
  // generation, so it is excluded rather than left to rank late.
  if (ref.scopedFrugal === true && !frugalityWarranted(model, requirements)) {
    exclusions.push({
      candidate: key,
      code: "scope_unmet",
      detail: "frugal-scoped candidate requires constrained context headroom",
    });
    return undefined;
  }
  // A candidate backed only by single-attempt evidence is confined to read-only consequence.
  //
  // The ability floor cannot do this job, and relying on it would be the trap. MiniMax M2.5 derives
  // band 2 from that source, which clears the irreversible floor outright, so band gating alone would
  // admit it to exactly the work its evidence cannot speak to: the source measured a single attempt per
  // instance, so regression breakage, partial credit, repeat determinism, wall time and peak context
  // were never observed. Five of the six terms the cost-to-done model consumes are missing.
  //
  // Read-only consequence is where the absence of those five terms cannot hurt: nothing the candidate
  // produces changes state, so a wrong answer costs a retry rather than a repository.
  if (ref.singleAttemptEvidence === true && effectiveConsequence(archetype, context) !== "read_only") {
    exclusions.push({
      candidate: key,
      code: "scope_unmet",
      detail: "single-attempt-evidence candidate is authorized for read-only consequence only",
    });
    return undefined;
  }
  const authorization = authorizeEffort(ref.logicalModelId, ref.effort, {
    allowSuperSaturation: policy.allowSuperSaturation,
    consequence: effectiveConsequence(archetype, context),
    language: context.language,
  });
  if (!authorization.authorized) {
    exclusions.push({ candidate: key, code: "effort_unauthorized", detail: authorization.reason });
    return undefined;
  }
  const headroom = Math.floor(model.contextWindow * 0.7);
  if (requirements.estimatedFinishedTokens > headroom) {
    exclusions.push({
      candidate: key,
      code: "context_headroom",
      detail: `${String(requirements.estimatedFinishedTokens)} estimated tokens exceed 70% of ${String(model.contextWindow)}`,
    });
    return undefined;
  }
  const prior = findEvidencePrior(ref.logicalModelId, ref.effort);
  if (prior) {
    // The task estimate and the configuration's measured p90 peak context are alternative lower
    // bounds on what this run needs, so the window must accommodate the larger of the two rather
    // than their sum. This is what excludes max-effort OpenAI configurations on 272K windows.
    if (prior.p90PeakContextTokens > headroom) {
      exclusions.push({
        candidate: key,
        code: "context_headroom_prior",
        detail: `measured p90 peak context ${String(prior.p90PeakContextTokens)} exceeds 70% of ${String(model.contextWindow)}`,
      });
      return undefined;
    }
    if (prior.contextOverflowRate > 0.02) {
      exclusions.push({
        candidate: key,
        code: "thrash_guard",
        detail: `measured context-overflow rate ${prior.contextOverflowRate.toFixed(3)} exceeds 0.02`,
      });
      return undefined;
    }
    if (archetype === "long_context_synthesis" && prior.p90PeakContextTokens > Math.floor(model.contextWindow * 0.5)) {
      exclusions.push({
        candidate: key,
        code: "thrash_guard",
        detail: `long-context routes require p90 peak context under half the window; measured ${String(prior.p90PeakContextTokens)}`,
      });
      return undefined;
    }
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
  let endpointEffectiveCost: number | undefined;
  try {
    endpointEffectiveCost = calculateEndpointEffectiveCost(model, effectiveProviderWeight(model).weight);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    exclusions.push({
      candidate: key,
      code: "endpoint_pricing_invalid",
      detail: error.message,
    });
    return undefined;
  }
  return {
    provider: model.provider,
    modelId: model.modelId,
    vendor: model.vendor,
    effort: ref.effort,
    ability: ref.ability,
    logicalModelId: ref.logicalModelId,
    profileId: profile.id,
    contextWindow: model.contextWindow,
    endpointTier: endpointTierFor(model.provider),
    ...(endpointEffectiveCost === undefined
      ? {}
      : {
          endpointBlendedCost: blendedEndpointCost(model),
          endpointEffectiveCost,
        }),
    ...(ref.escalationOnly ? { escalationOnly: true } : {}),
    ...(ref.scopedFrugal ? { scopedFrugal: true } : {}),
    ...(ref.singleAttemptEvidence ? { singleAttemptEvidence: true } : {}),
    rankReason: "bootstrap",
  };
}

/**
 * Context headroom is "constrained" when the task estimate already consumes most of what the endpoint
 * can offer. A frugal model earns its place there because fewer steps means a lower peak context.
 */
function frugalityWarranted(model: RegistryModelSnapshot, requirements: RouteRequirements): boolean {
  return requirements.estimatedFinishedTokens > Math.floor(model.contextWindow * 0.5);
}

/**
 * Evaluates a logical candidate across every endpoint that serves it, keeping the eligible ones in
 * preference order so an endpoint failure retries the same model before routing changes models.
 */
function evaluateCandidate(
  ref: CandidateRef,
  registry: readonly RegistryModelSnapshot[],
  archetype: Archetype,
  requirements: RouteRequirements,
  exclusions: CandidateExclusion[],
  context: RoutingContext = DEFAULT_ROUTING_CONTEXT,
): RouteChoice[] {
  const scopedEndpoints = registry.filter((model) => canonicalModelId(model.modelId) === ref.logicalModelId);
  // Filter this pricing guard before resolution computes endpoint cost: a larger request must never
  // be compared at a Bedrock GPT-5.6 short-context rate, even transiently before eligibility rejects it.
  const priceableEndpoints = scopedEndpoints.filter((model) => {
    if (!bedrockLongContextPricingUnavailable(model, requirements.estimatedFinishedTokens)) return true;
    const supported = model.supportedEfforts.includes(ref.effort);
    exclusions.push(
      supported
        ? {
            candidate: `${model.provider}/${model.modelId}`,
            code: "long_context_pricing_unavailable",
            detail: `Bedrock ${canonicalModelId(model.modelId)} has no registered price above ${String(BEDROCK_GPT_SHORT_CONTEXT_LIMIT)} estimated tokens`,
          }
        : {
            candidate: `${model.provider}/${model.modelId}`,
            code: "effort_unsupported",
            detail: `${ref.effort} effort is unsupported`,
          },
    );
    return false;
  });
  if (priceableEndpoints.length === 0) {
    if (scopedEndpoints.length === 0) {
      exclusions.push({
        candidate: `${ref.logicalModelId}@${ref.effort}`,
        code: "not_in_scope",
        detail: "no scoped registry endpoint serves this model",
      });
    }
    return [];
  }
  const eligible = priceableEndpoints
    .map((model): EligibleResolvedEndpoint | undefined => {
      const choice = evaluateEndpoint(ref, model, archetype, requirements, exclusions, context);
      return choice ? { model, choice } : undefined;
    })
    .filter((endpoint): endpoint is EligibleResolvedEndpoint => endpoint !== undefined);
  return resolveEndpoints(eligible).map(({ choice }) => choice);
}

/**
 * An escalation-only candidate may outrank the leaders on the hard-task prior, but its measured
 * flakiness makes it unfit for a first attempt. This runs on the final ordered chain rather than
 * inside one ranking branch, so no archetype and no ranking path can bypass it.
 *
 * It fails closed: when no ordinary candidate survives eligibility, the escalation candidates are
 * dropped entirely rather than promoted, which leaves the route unroutable and preserves the existing
 * model selection. An escalation prior is authorization to retry differently, never a licence to make
 * the least reliable configuration the first attempt.
 */
function demoteEscalationOnly(choices: readonly RouteChoice[], exclusions: CandidateExclusion[]): RouteChoice[] {
  const ordinary = choices.filter((choice) => choice.escalationOnly !== true);
  const escalation = choices.filter((choice) => choice.escalationOnly === true);
  if (escalation.length === 0) return [...ordinary];
  if (ordinary.length === 0) {
    for (const choice of escalation) {
      exclusions.push({
        candidate: `${choice.provider}/${choice.modelId}@${choice.effort}`,
        code: "escalation_without_primary",
        detail: "escalation-only candidates cannot serve as a first attempt and no ordinary candidate was eligible",
      });
    }
    return [];
  }
  return [...ordinary, ...escalation];
}

function deduplicateChoices(choices: readonly RouteChoice[], exclusions: CandidateExclusion[]): RouteChoice[] {
  const seen = new Set<string>();
  return choices.filter((choice) => {
    // Deduplicate only an exact endpoint at an exact effort. Different providers for one model are
    // deliberate availability fallbacks, and the same endpoint at a different effort is a distinct
    // route choice that archetypes such as highest_risk_advisory rely on.
    const key = `${choice.provider}/${choice.modelId}@${choice.effort}`;
    if (seen.has(key)) {
      exclusions.push({
        candidate: key,
        code: "duplicate_model",
        detail: "the exact provider/model endpoint and effort is listed more than once",
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

/**
 * One logical (model, effort) choice and every eligible endpoint that serves it. Endpoints stay
 * grouped so an availability failure retries the same model before the router changes models.
 */
type CandidateGroup = {
  key: string;
  logicalModelId: string;
  effort: EffortLevel;
  endpoints: RouteChoice[];
};

/**
 * Endpoint order within one logical model is weighted effective cost, followed by first-party tier,
 * specificity, and exact identity. Tier breaks only an exact cost tie; it cannot override a cheaper
 * route. Group ordering is separate, so every endpoint for this model stays ahead of a different
 * logical-model fallback.
 */
function orderEndpoints(endpoints: readonly RouteChoice[]): RouteChoice[] {
  return [...endpoints].sort(compareEndpointEffectiveCost);
}

function groupCandidates(choices: readonly RouteChoice[]): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();
  for (const choice of choices) {
    const key = `${choice.logicalModelId}@${choice.effort}`;
    const group = groups.get(key);
    if (group) group.endpoints.push(choice);
    else groups.set(key, { key, logicalModelId: choice.logicalModelId, effort: choice.effort, endpoints: [choice] });
  }
  return [...groups.values()].map((group) => ({ ...group, endpoints: orderEndpoints(group.endpoints) }));
}

function sampleFor(
  choice: RouteChoice,
  archetype: Archetype,
  samples: readonly RouteSample[],
): RouteSample | undefined {
  return samples.find(
    (sample) =>
      sample.provider === choice.provider && sample.modelId === choice.modelId && sample.archetype === archetype,
  );
}

function orderGroups(
  groups: CandidateGroup[],
  archetype: Archetype,
  qualityFloor: number,
  samples: readonly RouteSample[],
  weights: CostWeights | undefined,
  explorationKey: string | undefined,
  context: RoutingContext,
): { choices: RouteChoice[]; mature: boolean; controlledHoldout: boolean } {
  const primaries = groups.map((group) => group.endpoints[0]);
  const comparable = primaries.map((choice) => (choice ? sampleFor(choice, archetype, samples) : undefined));
  const mature =
    groups.length > 0 &&
    comparable.every((sample) => sample && sample.comparableSamples >= 30 && sample.acceptedRate >= qualityFloor);
  const controlledHoldout = explorationKey ? isControlledHoldout(explorationKey) : false;

  if (mature) {
    const appliedWeights = weights ?? DEFAULT_COST_WEIGHTS;
    const matureRankReason: RouteChoice["rankReason"] = controlledHoldout ? "controlled_holdout" : "telemetry";
    const scored = groups.map((group, index) => {
      const sample = comparable[index];
      if (!sample) throw new Error("mature route is missing its comparable telemetry sample");
      const score = robustCostToDone(sample, appliedWeights);
      const scoreComponents = {
        p75ModelAndToolCost: sample.p75ModelAndToolCost,
        developerWaitCost: appliedWeights.developerWaitValuePerMs * sample.p75WallTimeMs,
        humanInterventionCost: appliedWeights.humanInterventionCost * sample.probabilityHumanIntervention,
        retryCost: appliedWeights.retryCost * sample.probabilityRetry,
      };
      return {
        group,
        score,
        endpoints: group.endpoints.map((choice) => ({
          ...choice,
          score,
          scoreComponents,
          rankReason: matureRankReason,
        })),
      };
    });
    const ordered = controlledHoldout ? scored : scored.sort((left, right) => left.score - right.score);
    return { choices: ordered.flatMap((entry) => entry.endpoints), mature: true, controlledHoldout };
  }

  // Archetypes the corpus does not measure keep their declared order: an agentic pass rate is not a
  // proxy for single-shot classification or schema extraction quality.
  if (!BOOTSTRAP_ROUTE_POLICIES[archetype].evidenceRanked) {
    return { mature: false, controlledHoldout: false, choices: groups.flatMap((group) => group.endpoints) };
  }

  // Pre-telemetry ordering uses the measured evidence priors rather than policy list order, so a
  // cheap-but-weak configuration cannot win on token price and a strong configuration does not need
  // to be hand-placed first.
  const scoreContext = evidenceScoreContext(archetype, context);
  const scored = groups.map((group) => {
    const prior = findEvidencePrior(group.logicalModelId, group.effort);
    const evidence = prior ? scoreEvidencePrior(prior, DEFAULT_EVIDENCE_WEIGHTS, scoreContext) : undefined;
    return { group, evidence };
  });
  const ranked = scored
    .filter((entry) => entry.evidence !== undefined)
    .sort((left, right) => (left.evidence?.score ?? 0) - (right.evidence?.score ?? 0));
  // A weakly evidenced language tendency may break a near-tie but can never move a candidate past a
  // materially better score. Ruby is the motivating case: its only current-generation source has four
  // tasks and measures a different construct, which justifies a preference and not a weight.
  const languagePolicy = languageEvidence(context.language);
  const tendency = languagePolicy?.vendorTendency;
  const leader = ranked[0]?.evidence?.score;
  if (tendency !== undefined && leader !== undefined && leader > 0) {
    const limit = leader * (1 + (languagePolicy?.nearTieFraction ?? DEFAULT_NEAR_TIE_FRACTION));
    const preferred = ranked.findIndex(
      (entry) => (entry.evidence?.score ?? Infinity) <= limit && entry.group.endpoints[0]?.vendor === tendency,
    );
    if (preferred > 0) ranked.unshift(...ranked.splice(preferred, 1));
  }
  // Candidates without evidence keep their declared policy order behind every scored candidate.
  const unscored = scored.filter((entry) => entry.evidence === undefined);
  const ordered = [...ranked, ...unscored];
  // A pinned primary is a deliberate capability-first prior. A corpus-wide default may defer to
  // the measured language policy; either way the pin only reorders and never adds a candidate.
  const configuredPin = BOOTSTRAP_ROUTE_POLICIES[archetype].pinnedPrimary;
  const pin =
    configuredPin?.deferToLanguageEvidence &&
    languagePolicy?.confidence !== undefined &&
    languagePolicy.confidence !== "none"
      ? undefined
      : configuredPin;
  const pinIndex = pin
    ? ordered.findIndex(
        (entry) => entry.group.logicalModelId === pin.logicalModelId && entry.group.effort === pin.effort,
      )
    : -1;
  if (pinIndex > 0) ordered.unshift(...ordered.splice(pinIndex, 1));
  return {
    mature: false,
    controlledHoldout: false,
    choices: ordered.flatMap((entry) =>
      entry.group.endpoints.map((choice) => ({
        ...choice,
        ...(entry.evidence
          ? {
              evidenceScore: entry.evidence.score,
              ...(entry.evidence.languageUsed ? { evidenceLanguage: entry.evidence.languageUsed } : {}),
              rankReason: "evidence_prior" as const,
            }
          : {}),
      })),
    ),
  };
}

export function selectOrdinaryRoute(
  archetype: Archetype,
  registry: readonly RegistryModelSnapshot[],
  requirements: RouteRequirements,
  samples: readonly RouteSample[] = [],
  weights?: CostWeights,
  explorationKey?: string,
  context: RoutingContext = DEFAULT_ROUTING_CONTEXT,
): RouteDecision {
  const policy = BOOTSTRAP_ROUTE_POLICIES[archetype];
  const exclusions: CandidateExclusion[] = [];
  // Hard, ambiguous work additionally authorizes the escalation prior as a retry candidate.
  const pool = context.hardTask
    ? [...policy.primary, ...policy.fallback, ...HARD_TASK_ESCALATION_REFS]
    : [...policy.primary, ...policy.fallback];
  const evaluated = pool.flatMap((candidate) =>
    evaluateCandidate(candidate, registry, archetype, requirements, exclusions, context),
  );
  const deduplicated = deduplicateChoices(evaluated, exclusions);
  const ranked = orderGroups(
    groupCandidates(deduplicated),
    archetype,
    policy.qualityFloor,
    samples,
    weights,
    explorationKey,
    context,
  );
  const [primary, ...fallbacks] = demoteEscalationOnly(ranked.choices, exclusions);

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

/**
 * A user-requested standalone review: an explicit review verb, or a reference to a pull request.
 * Tracked-work reviews are generated by the safety lifecycle and never detected from prompt text.
 */
export function isStandaloneReviewRequest(prompt: string): boolean {
  return (
    /\b(?:review|audit|inspect|look\s+over)\b/i.test(prompt) ||
    /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i.test(prompt) ||
    /\b(?:pr|pull request)\s*#?\s*\d+\b/i.test(prompt)
  );
}

export function selectStandaloneReviewRoute(
  registry: readonly RegistryModelSnapshot[],
  requirements: RouteRequirements,
  samples: readonly RouteSample[] = [],
  weights?: CostWeights,
  explorationKey?: string,
  context: RoutingContext = REVIEW_CONTEXT,
): RouteDecision {
  return selectOrdinaryRoute("code_review", registry, requirements, samples, weights, explorationKey, context);
}

/**
 * Independent reviewers a generated review must obtain before it can report a verdict.
 *
 * Two is a floor on independence, not a description of the vendor set. The rule is "every eligible
 * reviewer-ladder vendor other than the builder's, and at least two must be eligible"; it used to be implemented as
 * an equality check against a hardcoded triple, which returned unroutable for any builder outside
 * that triple and would have silently broken tracked review as soon as a fourth vendor was added.
 */
const MINIMUM_INDEPENDENT_REVIEWERS = 2;

export function selectReviewRoute(
  registry: readonly RegistryModelSnapshot[],
  requirements: RouteRequirements,
  builder: RegistryModelSnapshot,
  _builderEffort: EffortLevel,
  builderAbility: number,
): RouteDecision {
  const exclusions: CandidateExclusion[] = [];
  // Derived from the supported vendor set rather than a literal, so the pool grows with MODEL_VENDORS.
  // A vendor that declares no reviewer ladder is excluded here rather than contributing an empty slot.
  const vendors = reviewerVendors().filter((vendor) => vendor !== builder.vendor);
  const ceilingMismatchVendors: ModelVendor[] = [];
  const choices: RouteChoice[] = [];

  for (const vendor of vendors) {
    const refsForVendor = reviewerRefs(vendor, builderAbility);
    const eligible = refsForVendor
      .flatMap((ref) => evaluateCandidate(ref, registry, "code_review", requirements, exclusions, REVIEW_CONTEXT))
      .at(0);
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
  const [primary, ...fallbacks] = choices;
  // Fails closed below the floor. It deliberately does not cap the chain from above: an extra
  // independent reviewer is only ever attempted after the ones before it were unavailable.
  if (!primary || choices.length < MINIMUM_INDEPENDENT_REVIEWERS) {
    return {
      kind: "unroutable",
      policyVersion: POLICY_VERSION,
      archetype: "code_review",
      reason: `tracked-work review requires at least ${String(MINIMUM_INDEPENDENT_REVIEWERS)} eligible non-builder vendors; ${String(choices.length)} eligible`,
      exclusions,
    };
  }
  return {
    kind: "review",
    policyVersion: POLICY_VERSION,
    archetype: "code_review",
    primary,
    fallbacks,
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
