import type { Archetype } from "./archetype.ts";
import type { EffortLevel, ModelVendor } from "./profiles.ts";

export const POLICY_VERSION = "router-policy-v1";

export type CandidateRef = {
  provider: string;
  modelId: string;
  vendor: ModelVendor;
  effort: EffortLevel;
  ability: 1 | 2 | 3 | 4;
  allowAlias: boolean;
  restricted: boolean;
};

function refs(
  vendor: ModelVendor,
  modelId: string,
  effort: EffortLevel,
  ability: CandidateRef["ability"],
  providers: readonly string[],
): CandidateRef[] {
  return providers.map((provider) => ({
    provider,
    modelId,
    vendor,
    effort,
    ability,
    allowAlias: false,
    restricted: false,
  }));
}

const OPENAI_PROVIDERS = ["openai-codex", "openai", "github-copilot"] as const;
const ANTHROPIC_PROVIDERS = ["anthropic", "github-copilot"] as const;
const GOOGLE_PROVIDERS = ["google", "github-copilot"] as const;

const LUNA_LOW = refs("openai", "gpt-5.6-luna", "low", 1, OPENAI_PROVIDERS);
const TERRA_MEDIUM = refs("openai", "gpt-5.6-terra", "medium", 2, OPENAI_PROVIDERS);
const TERRA_HIGH = refs("openai", "gpt-5.6-terra", "high", 2, OPENAI_PROVIDERS);
const SOL_HIGH = refs("openai", "gpt-5.6-sol", "high", 3, OPENAI_PROVIDERS);
const SOL_MAX = refs("openai", "gpt-5.6-sol", "max", 4, OPENAI_PROVIDERS);
const GPT_55_MEDIUM = refs("openai", "gpt-5.5", "medium", 2, ["openai-codex", "openai", "github-copilot"]);
const GPT_54_MEDIUM = refs("openai", "gpt-5.4", "medium", 2, ["openai-codex", "openai", "github-copilot"]);
const HAIKU_LOW = refs("anthropic", "claude-haiku-4-5", "low", 1, ANTHROPIC_PROVIDERS);
const SONNET_MEDIUM = refs("anthropic", "claude-sonnet-5", "medium", 2, ANTHROPIC_PROVIDERS);
const SONNET_HIGH = refs("anthropic", "claude-sonnet-5", "high", 3, ANTHROPIC_PROVIDERS);
const OPUS_HIGH = refs("anthropic", "claude-opus-4-8", "high", 3, ANTHROPIC_PROVIDERS);
const FABLE_HIGH = refs("anthropic", "claude-fable-5", "high", 4, ANTHROPIC_PROVIDERS);
const GEMINI_MEDIUM = [
  ...refs("google", "gemini-3.5-flash", "medium", 2, GOOGLE_PROVIDERS),
  ...refs("google", "gemini-2.5-flash", "medium", 2, ["google-vertex"]),
];
const GEMINI_HIGH = [
  ...refs("google", "gemini-3.5-flash", "high", 3, GOOGLE_PROVIDERS),
  ...refs("google", "gemini-2.5-flash", "high", 2, ["google-vertex"]),
];

export type BootstrapRoutePolicy = {
  archetype: Archetype;
  primary: readonly CandidateRef[];
  fallback: readonly CandidateRef[];
  qualityFloor: number;
};

export const BOOTSTRAP_ROUTE_POLICIES: Record<Archetype, BootstrapRoutePolicy> = {
  fast_classification: {
    archetype: "fast_classification",
    primary: LUNA_LOW,
    fallback: HAIKU_LOW,
    qualityFloor: 0.96,
  },
  exact_extraction: {
    archetype: "exact_extraction",
    primary: TERRA_MEDIUM,
    fallback: HAIKU_LOW,
    qualityFloor: 0.98,
  },
  deliberate_tool_workflow: {
    archetype: "deliberate_tool_workflow",
    primary: GPT_55_MEDIUM,
    fallback: GPT_54_MEDIUM,
    qualityFloor: 0.95,
  },
  median_repository_implementation: {
    archetype: "median_repository_implementation",
    primary: TERRA_MEDIUM,
    fallback: SONNET_HIGH,
    qualityFloor: 0.9,
  },
  terminal_heavy_implementation: {
    archetype: "terminal_heavy_implementation",
    primary: TERRA_HIGH,
    fallback: SONNET_HIGH,
    qualityFloor: 0.9,
  },
  algorithmic_iterative_coding: {
    archetype: "algorithmic_iterative_coding",
    primary: GEMINI_MEDIUM,
    fallback: TERRA_MEDIUM,
    qualityFloor: 0.92,
  },
  code_review: {
    archetype: "code_review",
    primary: SONNET_HIGH,
    fallback: SOL_HIGH,
    qualityFloor: 0.92,
  },
  implementation_planning: {
    archetype: "implementation_planning",
    primary: OPUS_HIGH,
    fallback: SOL_HIGH,
    qualityFloor: 0.9,
  },
  large_program_planning: {
    archetype: "large_program_planning",
    primary: FABLE_HIGH,
    fallback: SOL_MAX,
    qualityFloor: 0.9,
  },
  long_context_synthesis: {
    archetype: "long_context_synthesis",
    primary: SONNET_MEDIUM,
    fallback: SOL_HIGH,
    qualityFloor: 0.92,
  },
  highest_risk_advisory: {
    archetype: "highest_risk_advisory",
    primary: SOL_MAX,
    fallback: OPUS_HIGH,
    qualityFloor: 0.97,
  },
};

export function reviewerRefs(vendor: ModelVendor, minimumAbility: number): readonly CandidateRef[] {
  const tiers: Record<ModelVendor, readonly CandidateRef[][]> = {
    openai: [LUNA_LOW, TERRA_HIGH, SOL_HIGH, SOL_MAX],
    anthropic: [HAIKU_LOW, SONNET_HIGH, OPUS_HIGH, FABLE_HIGH],
    google: [GEMINI_MEDIUM, GEMINI_HIGH],
  };
  const eligibleTiers = tiers[vendor].filter((tier) => (tier[0]?.ability ?? 0) >= minimumAbility);
  return eligibleTiers.length > 0 ? eligibleTiers.flat() : (tiers[vendor].at(-1) ?? []);
}
