import type { Archetype } from "./archetype.ts";
import { evidenceAbility } from "./evidence.ts";
import type { AbilityTier } from "./evidence.ts";
import { MODEL_VENDORS } from "./profiles.ts";
import { canonicalModelId } from "./scope.ts";
import type { EffortLevel, ModelVendor } from "./profiles.ts";

export const POLICY_VERSION = "router-policy-v10";

/**
 * Backward-compatible endpoint classification retained for lease validation and diagnostics. Tiers
 * break equal-effective-cost ties only; weighted effective cost remains the primary order.
 */
export const ENDPOINT_TIERS = ["manufacturer", "gateway", "resale"] as const;
export type EndpointTier = (typeof ENDPOINT_TIERS)[number];

export type CandidateRef = {
  /**
   * The manufacturer's model ID. Concrete endpoints are resolved from the live scoped registry at
   * decision time, so policy never names a provider: a hand-maintained provider table drifts from the
   * machine it runs on, naming endpoints the operator never scoped in and missing ones they did.
   * Evidence priors, effort policies, ability bands, and prompt profiles are all keyed by this.
   */
  logicalModelId: string;
  vendor: ModelVendor;
  effort: EffortLevel;
  ability: AbilityTier;
  /**
   * Authorized only as a retry after a failed attempt, never as a first attempt. Used for the
   * hard-task escalation prior, whose measured hard-task lead comes with same-task flakiness too high
   * to make it any archetype's default.
   */
  escalationOnly?: boolean;
  /**
   * Scoped frugal candidate: authorized only where step count rather than token cost is the binding
   * constraint, which in the implemented policy means tight context headroom, since fewer steps yields
   * a lower peak context.
   */
  scopedFrugal?: boolean;
  /**
   * Backed only by single-attempt benchmark evidence. `core/routing.ts` refuses such a candidate
   * outside read-only consequence, because the source never measured regression breakage, partial
   * credit, repeat determinism, wall time or peak context — five of the six terms the cost-to-done
   * model consumes. An ability band derived from that source is therefore not permission to mutate.
   */
  singleAttemptEvidence?: boolean;
  allowAlias: boolean;
  restricted: boolean;
};

/**
 * Vendor for each logical model the policy can name. Explicit rather than inferred from the ID, so a
 * new candidate must declare which vendor ladder and prompt-profile family it belongs to.
 */
export const MODEL_VENDOR: Readonly<Record<string, ModelVendor>> = {
  "gpt-6-luna": "openai",
  "gpt-6-astra": "openai",
  "gpt-5.6-terra": "openai",
  "gpt-6-sol": "openai",
  "gpt-6.1-sol": "openai",
  "gpt-6.2-sol": "openai",
  "gpt-6.2-astra": "openai",
  "gpt-oss-120b": "openai",
  "claude-opus-5-5": "anthropic",
  "claude-opus-4-6": "anthropic",
  "claude-fable-5": "anthropic",
  "claude-sonnet-5": "anthropic",
  "claude-haiku-4-5": "anthropic",
  "gemini-3.8-flash": "google",
  "gemini-3.6-flash": "google",
  "gemini-2.5-pro": "google",
  "gemini-2.5-flash": "google",
  "minimax-m2.5": "minimax",
  "kimi-k2.5": "moonshot",
  "kimi-k2-thinking": "moonshot",
};

/**
 * Every candidate this policy can name must carry an evidence-derived ability band, either from a
 * DeepSWE rollout row for that exact (model, effort) pair or from the consensus-only table in
 * core/evidence.ts. Hand-declared bands are deliberately not supported: the one entry that used to
 * exist (`gpt-5.4@medium`) was never measured at that effort, and a policy-local number that no
 * source backs is indistinguishable from a guess.
 *
 * There is no longer an exception to this rule. `gpt-5.4-mini` was admitted as an "unmeasured peer"
 * pinned to band 1 on a purely per-token-price argument; that argument was withdrawn when the pinned
 * registry showed the price relationship inverted, and the rung was removed with it.
 */
function abilityFor(modelId: string, effort: EffortLevel): AbilityTier {
  const evidenceTier = evidenceAbility(modelId, effort);
  if (evidenceTier !== undefined) return evidenceTier;
  throw new Error(`no evidence band exists for ${modelId}@${effort}`);
}

/** Declares one logical (model, effort) candidate. Endpoint expansion happens in core/routing.ts. */
function candidates(logicalModelId: string, effort: EffortLevel): CandidateRef[] {
  const vendor = MODEL_VENDOR[logicalModelId];
  if (!vendor) throw new Error(`no vendor is declared for ${logicalModelId}`);
  return [
    {
      logicalModelId,
      vendor,
      effort,
      ability: abilityFor(logicalModelId, effort),
      allowAlias: false,
      restricted: false,
    },
  ];
}

const LUNA_MEDIUM = candidates("gpt-6-luna", "medium");
const LUNA_HIGH = candidates("gpt-6-luna", "high");
const LUNA_MAX = candidates("gpt-6-luna", "max");
const TERRA_MEDIUM = candidates("gpt-5.6-terra", "medium");
const TERRA_HIGH = candidates("gpt-5.6-terra", "high");
const TERRA_MAX = candidates("gpt-5.6-terra", "max");
const GPT_OSS_HIGH = candidates("gpt-oss-120b", "high");
// Declare successors newest first so availability ladders and equal evidence scores prefer them.
// Each generation still resolves to its own scoped endpoints and telemetry.
const SOL_MODELS = ["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-sol"];
const SOL_LOW = SOL_MODELS.flatMap((id) => candidates(id, "low"));
const SOL_MEDIUM = SOL_MODELS.flatMap((id) => candidates(id, "medium"));
const SOL_HIGH = SOL_MODELS.flatMap((id) => candidates(id, "high"));
const SOL_MAX = SOL_MODELS.flatMap((id) => candidates(id, "max"));
const ASTRA_HIGH = [...candidates("gpt-6.2-astra", "high"), ...candidates("gpt-6-astra", "high")];
const HAIKU_LOW = candidates("claude-haiku-4-5", "low");
/**
 * MiniMax M2.5, admitted to the bounded read-only ladders only.
 *
 * It displaces Claude Haiku 4.5 as the cheap rung on measurement rather than on price. On SWE-bench
 * Multilingual, the one source measuring both, it leads Haiku by 3.8 points of mean resolve over eight
 * languages (68.6% against 64.8%), costs 3.9x less per resolved task ($0.155 against $0.612), and uses
 * fewer median API calls (62.6 against 67.6). On SWE-bench Verified it leads gpt-oss-120b by 49.8
 * points at 2.3x lower cost per resolved task.
 *
 * Its evidence is single-attempt, so `singleAttemptEvidence` confines it to read-only consequence.
 * That flag, not its ability band, is what keeps it away from mutating work: the band derived from
 * this source is 2, which would otherwise clear the irreversible floor.
 *
 * It is declared in the fallback chain and never as a declared primary. It is deliberately NOT
 * forcibly demoted at selection time, so if every rung ahead of it is ineligible - Luna unavailable,
 * for instance - it can become the selected primary of a read-only route. That is intended, and the
 * contrast with `escalationOnly` is the reason: that flag is demoted unconditionally because its
 * candidate has a *measured* unfitness for a first attempt, 52.7% same-task flakiness. Here the
 * problem is absence of evidence, not measured unreliability, and the only alternative in that state
 * is the rung this one displaced - which measures worse on every axis the sources share. Forcing a
 * non-single-attempt primary would mean deliberately choosing the worse-measured model. Being first on
 * read-only work is also no more dangerous than being second on it, because the confinement above is
 * what bounds the damage, not the position in the chain.
 *
 * Haiku is retained behind it rather than replaced. The reason is availability, not capability: this
 * endpoint is text-only, so an image-bearing bounded task excludes it on the capability gate, and
 * Haiku is then the cheapest image-capable rung before the ladder jumps to gpt-5.6-terra at roughly
 * 2.4x its effective rate. Ordering MiniMax first is safe precisely because that gate handles the
 * exception without ordering having to.
 *
 * `low` follows the rung it displaces. No source measures this model per effort — the submissions ran
 * at a "high reasoning" setting and measured agentic repository work, not bounded classification — so
 * the effort is chosen to match the rung rather than claimed as measured.
 */
const MINIMAX_LOW = candidates("minimax-m2.5", "low").map((ref) => ({ ...ref, singleAttemptEvidence: true }));
/**
 * Reachable Kimi open-weight rungs, confined to read-only work because their quality evidence is
 * single-attempt. Both sit within the approximate Haiku-to-Luna capability range and stay within 3x
 * Luna's direct output-weighted list rate: K2.5 is 2.53x and K2 Thinking is 2.13x. K2.5 resolves 70.8% on
 * SWE-bench Verified, supports image input, and leads the retained Ruby split at 68.2%; K2 Thinking
 * resolves 63.4% and Artificial Analysis records 120.98 output tokens/s versus Haiku's 81.09.
 */
const KIMI_25_LOW = candidates("kimi-k2.5", "low").map((ref) => ({ ...ref, singleAttemptEvidence: true }));
const KIMI_THINKING_LOW = candidates("kimi-k2-thinking", "low").map((ref) => ({
  ...ref,
  singleAttemptEvidence: true,
}));
const OPUS_LOW = candidates("claude-opus-5-5", "low");
const OPUS_MEDIUM = candidates("claude-opus-5-5", "medium");
const OPUS_HIGH = candidates("claude-opus-5-5", "high");
const OPUS_XHIGH = candidates("claude-opus-5-5", "xhigh");
const OPUS_MAX = candidates("claude-opus-5-5", "max");
const FABLE_XHIGH = candidates("claude-fable-5", "xhigh");
const OPUS_46_HIGH = candidates("claude-opus-4-6", "high").map((ref) => ({ ...ref, scopedFrugal: true }));
/**
 * General Google availability chain. Direct `google` endpoints are filtered from non-review work in
 * core/routing.ts because their operator quota is too low for general traffic; Vertex and other
 * scoped surfaces remain eligible. gemini-3.5-flash stays absent because its measured context
 * overflow disqualifies it.
 */
const GEMINI_GENERAL_HIGH = [
  ...candidates("gemini-3.6-flash", "high"),
  ...candidates("gemini-2.5-pro", "high"),
  ...candidates("gemini-2.5-flash", "high"),
];

/**
 * Review-only Google chain. Gemini 3.8 Flash at high effort leads on the refreshed corroborated
 * evidence: 69.2 CursorBench and 73.8% DeepSWE, with consensus performance_best 93.55 (band 4).
 * Its dedicated prompt profile resolves only for code_review, and direct Google is admitted only
 * there. Older generations remain availability fallbacks because a weaker independent review is
 * preferable to losing the Google reviewer entirely.
 */
const GEMINI_REVIEW_HIGH = [...candidates("gemini-3.8-flash", "high"), ...GEMINI_GENERAL_HIGH];

export type BootstrapRoutePolicy = {
  archetype: Archetype;
  primary: readonly CandidateRef[];
  fallback: readonly CandidateRef[];
  /**
   * Minimum observed accepted rate before telemetry may outrank the evidence priors. Calibrated
   * against achievable behavior rather than aspiration: the best measured deterministic pass rate in
   * the evidence corpus is 72.8%, and a route cannot be accepted more often than it completes
   * correctly, so implementation-class floors sit below that ceiling. Non-agentic archetypes keep
   * their original high floors because the agentic corpus does not measure those task types.
   */
  qualityFloor: number;
  /** Reference deterministic pass rate for this archetype class, recorded for telemetry comparison. */
  deterministicPassFloor: number;
  /** Archetypes authorized to exceed a model's measured effort saturation tier. */
  allowSuperSaturation: boolean;
  /**
   * Whether this archetype always changes repository state. Used only as a floor under the
   * task-derived consequence tier, so a classifier that under-reads a task cannot downgrade an
   * inherently state-changing archetype to read-only.
   */
  mutatesRepository: boolean;
  /**
   * Whether the measured agentic priors may reorder this archetype's pool. False for archetypes whose
   * task type the corpus does not measure: a multi-step repository pass rate says nothing about
   * single-shot classification or schema extraction, so those keep their declared order and use the
   * pool only for availability.
   */
  evidenceRanked: boolean;
  /**
   * Deliberate policy prior that outranks the evidence cost objective for this archetype's first
   * attempt. It may encode a refreshed corpus-wide default or a capability-first choice whose failure
   * cost is paid downstream. Fallbacks stay evidence-ranked, and the pin is ignored when the pinned
   * choice is not eligible.
   */
  pinnedPrimary?: {
    logicalModelId: string;
    effort: EffortLevel;
    reason: string;
    /** Keep a measured language-specific route when one exists instead of applying the corpus-wide default. */
    deferToLanguageEvidence?: boolean;
  };
};

export const BOOTSTRAP_ROUTE_POLICIES: Record<Archetype, BootstrapRoutePolicy> = {
  fast_classification: {
    archetype: "fast_classification",
    // gpt-6-luna at medium, not low. Both are authorized for read-only consequence and both bill at
    // the same rate, so the choice is token volume: medium takes 22 median steps against low's 12, but
    // low is the worst-measured configuration in the corpus (1.6% pass, 27.7% regression breakage,
    // consensus 0.0) and measures below the claude-haiku-4-5 rung behind it. Nothing justifies leading
    // with it.
    //
    // Medium being the primary is safe without an effort-policy exception, and deliberately relies on a
    // gate that already exists rather than a new one. gpt-6-luna declares an agentic minimum of high,
    // which authorizeEffort applies whenever consequence reaches reversible, so a classification-shaped
    // task that actually mutates or carries critical risk has medium refused for it and falls through to
    // luna@high. The refusal is measured, not assumed: 23.5% regression breakage at medium against 9.1%
    // at high. See decisions.md for the tradeoff this accepts.
    primary: LUNA_MEDIUM,
    // The cheap band-1 tiers serve ordinary classification. The band-2+ entry exists so a
    // classification task carrying critical risk or an irreversible action mode is still routable;
    // core/policy.test.mjs enforces that it stays.
    //
    // luna@high sits directly behind luna@medium so the first response to rising consequence is more
    // effort on the same model rather than a different model, which is both cheaper and the only
    // transition in this ladder backed by a per-effort measurement.
    //
    // minimax-m2.5 displaces claude-haiku-4-5 as the cheap rung and Haiku is retained behind it as the
    // cheapest image-capable fallback; see MINIMAX_LOW for why that ordering is safe.
    //
    // gpt-oss-120b at high effort precedes gpt-5.6-terra at medium: this archetype is not
    // evidence-ranked, so the declared order is the executed order, and on the only comparable
    // measurement the two share, gpt-oss leads (consensus performance_best 36.5 against terra@medium's
    // 16.3) while also sitting at the corpus cost floor. terra@medium's measured agentic behavior does
    // not rescue the comparison either: 35.1% pass with a 14.7% regression-break rate, the worst of
    // any tier in this ladder. It stays in the ladder only as the availability backup for gpt-oss,
    // which is reachable on a single Amazon Bedrock route and is therefore absent on most machines.
    //
    // gpt-6-sol at medium is gone. Under the pi 0.84.1 registry it was strictly dominated by the
    // claude-opus-5-5 medium rung behind it, which is a higher ability band (3 against 2) and a lower
    // effective rate (6.161 against 7.442), so it added a rung without adding a reason. Pi 0.85.1 cuts
    // Sol below Opus 5 (6.532 against 7.423 at the current Bedrock weight), so the cut now rests on
    // the ability band alone; see specs/routing-layer/registry-refresh-2026-09-22.md.
    //
    // claude-opus-5-5 at high replaces it as the second high-consequence rung, and the reason is
    // routability rather than capability. Irreversible consequence bars every band-1 rung here and the
    // read-only confinement bars minimax-m2.5, so without a second survivor this ladder had exactly one
    // eligible logical candidate for critical-risk work. selectOrdinaryRoute requires a primary AND at
    // least one fallback, so one survivor is unroutable unless that model happens to expose two scoped
    // endpoints - which makes safety-relevant routability depend on how an operator scoped their
    // registry. Opus 5 at high is the same model one effort up, keeping this ladder's rule that rising
    // consequence buys more effort before it buys a different model.
    fallback: [
      ...LUNA_HIGH,
      ...MINIMAX_LOW,
      ...KIMI_25_LOW,
      ...KIMI_THINKING_LOW,
      ...GPT_OSS_HIGH,
      ...HAIKU_LOW,
      ...TERRA_MEDIUM,
      ...OPUS_MEDIUM,
      ...OPUS_HIGH,
    ],
    qualityFloor: 0.96,
    deterministicPassFloor: 0.96,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: false,
  },
  exact_extraction: {
    archetype: "exact_extraction",
    primary: TERRA_MEDIUM,
    // minimax-m2.5 joins on the same basis as in fast_classification and sits ahead of the rung it
    // displaces. The rest of this ladder is deliberately untouched: gpt-6-sol was removed only from
    // fast_classification, because schema-emission fidelity is what orders this archetype and no source
    // measures it, so there is no evidence here to justify dropping a rung.
    fallback: [
      ...MINIMAX_LOW,
      ...KIMI_25_LOW,
      ...KIMI_THINKING_LOW,
      ...HAIKU_LOW,
      ...SOL_LOW,
      ...GPT_OSS_HIGH,
      ...SOL_MEDIUM,
      ...OPUS_MEDIUM,
    ],
    qualityFloor: 0.98,
    deterministicPassFloor: 0.98,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: false,
  },
  deliberate_tool_workflow: {
    archetype: "deliberate_tool_workflow",
    primary: SOL_MEDIUM,
    // gpt-5.4 at medium is gone from this ladder. It was carried only as a legacy fallback and had no
    // rollout row at that effort at all; the one gpt-5.4 configuration the corpus does measure (xhigh)
    // passes 51.8% with 12.4% regression breakage for $10.91 per pass, worse than every tier above it.
    // Two current-generation entries replace it:
    //
    //  - gpt-5.6-terra at high is the cheap rung this archetype was reaching for: 53.8% pass at $2.11
    //    per pass and 315s median, which is cheaper and faster than sol@medium ($3.05, 355s) for
    //    procedural work whose steps are dictated rather than designed. Its consensus band is 43.0, so
    //    it is band 1 and consequence gating bars it from the irreversible checkpoints in this
    //    archetype on its own; it serves the local_read and reversible members of the same ladder.
    //  - claude-opus-5-5 at medium is the non-OpenAI tail, and the closest measured neighbour of the Sol
    //    tiers (68.1% pass and consensus 79.0 against sol@high's 69.3% and 79.9, $4.86 per pass against
    //    sol@medium's $3.05, 588s median against 355s). It gives a workflow with external side effects a
    //    vendor alternative, which an all-OpenAI ladder could not.
    fallback: [...SOL_HIGH, ...SOL_LOW, ...TERRA_HIGH, ...OPUS_MEDIUM],
    qualityFloor: 0.8,
    deterministicPassFloor: 0.61,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: true,
  },
  median_repository_implementation: {
    archetype: "median_repository_implementation",
    primary: OPUS_MEDIUM,
    fallback: [...SOL_HIGH, ...OPUS_HIGH, ...TERRA_HIGH, ...OPUS_46_HIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.68,
    allowSuperSaturation: false,
    mutatesRepository: true,
    evidenceRanked: true,
    pinnedPrimary: {
      logicalModelId: "claude-opus-5-5",
      effort: "medium",
      reason:
        "the refreshed effectiveness report recommends Opus low/medium as the default agentic coding route and Sol high as the challenger; measured language-specific routing remains authoritative",
      deferToLanguageEvidence: true,
    },
  },
  stacked_pr_implementation: {
    archetype: "stacked_pr_implementation",
    primary: OPUS_HIGH,
    fallback: [...SOL_HIGH, ...SOL_MAX],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.72,
    allowSuperSaturation: false,
    mutatesRepository: true,
    evidenceRanked: true,
  },
  terminal_heavy_implementation: {
    archetype: "terminal_heavy_implementation",
    primary: SOL_HIGH,
    fallback: [...OPUS_HIGH, ...TERRA_MAX, ...TERRA_HIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.69,
    allowSuperSaturation: false,
    mutatesRepository: true,
    evidenceRanked: true,
  },
  algorithmic_iterative_coding: {
    archetype: "algorithmic_iterative_coding",
    primary: SOL_MEDIUM,
    fallback: [...OPUS_MEDIUM, ...GEMINI_GENERAL_HIGH, ...TERRA_HIGH, ...LUNA_HIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.61,
    allowSuperSaturation: false,
    mutatesRepository: true,
    evidenceRanked: true,
  },
  code_review: {
    archetype: "code_review",
    primary: OPUS_HIGH,
    fallback: SOL_HIGH,
    qualityFloor: 0.75,
    deterministicPassFloor: 0.72,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: true,
  },
  implementation_planning: {
    archetype: "implementation_planning",
    primary: OPUS_HIGH,
    fallback: [...SOL_HIGH, ...ASTRA_HIGH, ...FABLE_XHIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.72,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: true,
    pinnedPrimary: {
      logicalModelId: "claude-opus-5-5",
      effort: "high",
      reason:
        "planning is capability-first: Opus 5 holds the top consensus band (92.2) and the lowest regression breakage, and a defective plan propagates across every pull request it authorizes",
    },
  },
  large_program_planning: {
    archetype: "large_program_planning",
    primary: OPUS_XHIGH,
    fallback: [...ASTRA_HIGH, ...SOL_MAX, ...FABLE_XHIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.72,
    allowSuperSaturation: true,
    mutatesRepository: false,
    evidenceRanked: true,
    pinnedPrimary: {
      logicalModelId: "claude-opus-5-5",
      effort: "xhigh",
      reason:
        "program planning is capability-first and long-horizon; Opus 5 at xhigh leads the corpus (72.5% pass, consensus 97.1) and Fable 5 at xhigh costs 1.5x more per pass for less",
    },
  },
  long_context_synthesis: {
    archetype: "long_context_synthesis",
    primary: OPUS_MEDIUM,
    // gpt-5.5 at xhigh used to hold the OpenAI tail here on its long-context numbers: 0% context
    // overflow, p90 peak context 219,152, and the highest partial credit on failure in the ladder
    // (83.1%), which is what a synthesis route degrades into when it does not fully succeed. It is
    // retired anyway, because gpt-5.6-terra at max matches the shape and beats it on every number that
    // matters: 69.6% pass against 67.0%, $7.10 per pass against $10.78, 928s median against 1,588s,
    // consensus 84.7 against 68.8, with the same 0% overflow at a comparable p90 peak of 266,934. Terra
    // is also effort-hungry rather than saturated early, so max is its measured top tier and not a
    // super-saturation reach. claude-opus-4-6 precedes it because a scoped-frugal candidate is admitted
    // only where step count binds, and where it is admitted its 23.6 median API calls are the cheapest
    // way through a large-document pass.
    fallback: [...SOL_HIGH, ...OPUS_46_HIGH, ...TERRA_MAX],
    qualityFloor: 0.72,
    deterministicPassFloor: 0.68,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: true,
  },
  highest_risk_advisory: {
    archetype: "highest_risk_advisory",
    primary: OPUS_MAX,
    fallback: [...ASTRA_HIGH, ...SOL_MAX, ...OPUS_HIGH],
    qualityFloor: 0.8,
    deterministicPassFloor: 0.73,
    allowSuperSaturation: true,
    mutatesRepository: false,
    evidenceRanked: true,
    pinnedPrimary: {
      logicalModelId: "claude-opus-5-5",
      effort: "max",
      reason:
        "highest-risk work is quality-first: Opus 5 at max leads determinism (54.9% all-repeat pass) and regression safety (5.2% corpus-wide), and the cost of a wrong verdict is not paid inside the task",
    },
  },
};

/**
 * Reviewer ladders, ordered by evidence-derived ability.
 *
 * Declared as a partial map rather than a total record over ModelVendor, so a newly supported vendor
 * does not oblige anyone to invent reviewer tiers for it. A vendor absent here simply contributes no
 * reviewer, which `reviewerRefs` reports as an empty list and `selectReviewRoute` handles by looking
 * to the remaining vendors.
 *
 * Claude Sonnet 5 is absent: at high effort it measures in the lowest ability band (48.2% pass, 138
 * median steps, p90 peak context 286,022), so it can no longer serve as a mid-tier reviewer.
 *
 * The ability-1 OpenAI and Anthropic rungs are also absent. A reviewer must be able to reason about
 * a diff, and the lowest-band configurations either cliff catastrophically (gpt-6-luna at low
 * effort passes 1.5% and breaks previously passing tests at 27.7%) or carry no agentic measurement
 * at all (claude-haiku-4-5). Google's review-only rung leads with Gemini 3.8 Flash at high effort
 * (band 4), then degrades through older generations when that endpoint is unavailable. The rung is
 * intentionally an ordered availability chain rather than a set of equal-ability configurations.
 */
const REVIEWER_TIERS: Partial<Record<ModelVendor, readonly (readonly CandidateRef[])[]>> = {
  openai: [ASTRA_HIGH, SOL_MEDIUM, SOL_HIGH, SOL_MAX],
  anthropic: [OPUS_LOW, OPUS_MEDIUM, OPUS_HIGH, FABLE_XHIGH],
  google: [GEMINI_REVIEW_HIGH],
};

/** Vendors that actually declare a reviewer ladder, in MODEL_VENDORS order. */
export function reviewerVendors(): readonly ModelVendor[] {
  return MODEL_VENDORS.filter((vendor) => (REVIEWER_TIERS[vendor]?.length ?? 0) > 0);
}

/**
 * Authorized hard-task escalation choice. Used only after a failed attempt on ambiguous or complex
 * work, where the evidence favors changing the model prior over raising effort on a saturated
 * incumbent. It is never any archetype's primary.
 */
export const HARD_TASK_ESCALATION_REFS: readonly CandidateRef[] = LUNA_MAX.map((ref) => ({
  ...ref,
  escalationOnly: true,
}));

// Derived, never hand-maintained: every candidate reachable through the bootstrap route policies,
// the reviewer tiers, or the escalation path is automatically part of the authoritative ability
// table, so a newly added candidate cannot silently fall through to the regex heuristic in
// pi-state.ts.
const ALL_CANDIDATE_REFS: readonly CandidateRef[] = [
  ...Object.values(BOOTSTRAP_ROUTE_POLICIES).flatMap((policy) => [...policy.primary, ...policy.fallback]),
  ...MODEL_VENDORS.flatMap((vendor) => (REVIEWER_TIERS[vendor] ?? []).flat()),
  ...HARD_TASK_ESCALATION_REFS,
];

/**
 * Ability is a per-(model, effort) judgment derived from cross-source consensus bands, not a uniform
 * effort bump: gpt-5.6-terra stays in a low band at high effort while claude-opus-5-5 reaches the top
 * band, because effort scales quality differently per model. This table is the single source of
 * truth; heuristics elsewhere must defer to it.
 */
export function policyAbility(modelId: string, effort: EffortLevel): AbilityTier | undefined {
  const canonical = canonicalModelId(modelId);
  return ALL_CANDIDATE_REFS.find(
    (ref) => (ref.logicalModelId === modelId || ref.logicalModelId === canonical) && ref.effort === effort,
  )?.ability;
}

export function reviewerRefs(vendor: ModelVendor, minimumAbility: number): readonly CandidateRef[] {
  const tiers = REVIEWER_TIERS[vendor];
  // A vendor with no declared ladder contributes no reviewer rather than throwing, so the review
  // path stays defined for every member of an arbitrarily sized vendor set.
  if (!tiers || tiers.length === 0) return [];
  const eligibleTiers = tiers.filter((tier) => (tier[0]?.ability ?? 0) >= minimumAbility);
  return eligibleTiers.length > 0 ? eligibleTiers.flat() : [...(tiers.at(-1) ?? [])];
}
