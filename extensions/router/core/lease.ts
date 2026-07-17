import type { Archetype } from "./archetype.ts";
import type { TaskFeatures } from "./features.ts";
import { findPromptProfile } from "./profiles.ts";
import type { EffortLevel } from "./profiles.ts";
import type { RouteChoice } from "./routing.ts";

export type HardBoundary = "new_session" | "post_compaction" | "post_push" | "subagent";
export type RouterMode = "off" | "shadow" | "active";

export type TaskLease = {
  version: 1;
  taskId: string;
  parentTaskId?: string;
  parentLease?: TaskLease;
  startedAt: string;
  updatedAt: string;
  archetype: Archetype;
  features: TaskFeatures;
  selected: RouteChoice;
  previousSelection?: RouteChoice;
  fallbacks: RouteChoice[];
  attemptIndex: number;
  promptProfileId: string;
  modelSnapshotId: string;
  policyVersion: string;
  lastPromptFingerprint: string;
  manualOverride: boolean;
  reviewRequired?: boolean;
  reviewCompleted?: boolean;
  repositoryLanguageBucket?: string;
  contextSizeBucket?: string;
  executionFailed?: boolean;
};

export type LeaseState = {
  mode: RouterMode;
  active?: TaskLease;
  pendingHardBoundary?: HardBoundary;
  manualOverride: boolean;
};

export type BoundaryInput = {
  isUserInput: boolean;
  source: "interactive" | "rpc" | "extension";
  streamingBehavior?: "steer" | "followUp";
  prompt: string;
  cachedTokens: number;
  expectedReuseRatio: number;
};

export type BoundaryGateResult =
  | { action: "ignore"; reason: string }
  | { action: "continue"; reason: string; lease: TaskLease }
  | { action: "new_task"; reason: string; hardBoundary?: HardBoundary }
  | { action: "classify_continuity"; reason: string; lease: TaskLease };

const CONTINUATION_PATTERN =
  /^(?:yes|yep|ok(?:ay)?|continue|go on|proceed|do it|implement it|fix (?:it|that)|try again|run (?:it|them|the tests)|keep going|sounds good)(?:[.!\s]|$)/i;
const DISCONTINUITY_PATTERN =
  /^(?:new task|separate task|unrelated|switch(?:ing)? topics?|instead[, :] |forget (?:that|the previous)|now (?:review|plan|implement|research)\b)/i;

export function hasSignificantReusableCache(cachedTokens: number, expectedReuseRatio: number): boolean {
  return cachedTokens >= 20_000 && expectedReuseRatio >= 0.5;
}

export function deterministicBoundaryGate(state: LeaseState, input: BoundaryInput): BoundaryGateResult {
  if (!input.isUserInput) return { action: "ignore", reason: "lease evaluation is user-turn-only" };
  if (input.source === "extension") {
    return state.active
      ? { action: "continue", reason: "extension-generated continuation cannot create a task", lease: state.active }
      : { action: "new_task", reason: "extension input has no active lease" };
  }
  if (input.streamingBehavior) {
    return state.active
      ? { action: "continue", reason: "queued steering/follow-up stays inside the running lease", lease: state.active }
      : { action: "new_task", reason: "queued input has no active lease" };
  }
  if (state.pendingHardBoundary) {
    return {
      action: "new_task",
      reason: `hard boundary: ${state.pendingHardBoundary}`,
      hardBoundary: state.pendingHardBoundary,
    };
  }
  if (!state.active) return { action: "new_task", reason: "no active task lease" };

  const prompt = input.prompt.trim();
  if (
    (state.active.archetype === "implementation_planning" || state.active.archetype === "large_program_planning") &&
    /\b(?:implement|execute|start|begin|apply|build|code)\b/i.test(prompt)
  ) {
    return { action: "new_task", reason: "planning and implementation require separate leases" };
  }
  if (DISCONTINUITY_PATTERN.test(prompt)) {
    return { action: "new_task", reason: "explicit semantic discontinuity" };
  }
  if (state.manualOverride || state.active.manualOverride) {
    return { action: "continue", reason: "manual model/effort override remains in force", lease: state.active };
  }
  if (CONTINUATION_PATTERN.test(prompt) || prompt.length <= 12) {
    return { action: "continue", reason: "deterministic continuation signal", lease: state.active };
  }
  return {
    action: "classify_continuity",
    reason: hasSignificantReusableCache(input.cachedTokens, input.expectedReuseRatio)
      ? "semantic alignment is inconclusive and reusable cache is significant"
      : "semantic alignment is inconclusive",
    lease: state.active,
  };
}

export function resolveContinuity(
  lease: TaskLease,
  features: TaskFeatures,
  cache: { cachedTokens: number; expectedReuseRatio: number },
): BoundaryGateResult {
  if (features.taskContinuity === "clear_continuation") {
    return { action: "continue", reason: "continuity classifier found a clear continuation", lease };
  }
  if (features.taskContinuity === "strong_discontinuity") {
    return { action: "new_task", reason: "continuity classifier found strong semantic discontinuity" };
  }
  if (features.taskContinuity === "new_task") {
    if (
      hasSignificantReusableCache(cache.cachedTokens, cache.expectedReuseRatio) &&
      (features.confidence < 0.9 || features.ambiguity !== "low")
    ) {
      return { action: "continue", reason: "significant reusable cache resisted a marginal task switch", lease };
    }
    return { action: "new_task", reason: "continuity classifier found a new task" };
  }
  if (hasSignificantReusableCache(cache.cachedTokens, cache.expectedReuseRatio)) {
    return { action: "continue", reason: "possible continuation retained for significant cache value", lease };
  }
  return { action: "new_task", reason: "possible continuation with low reusable cache value" };
}

export function setHardBoundary(state: LeaseState, boundary: HardBoundary): LeaseState {
  return { ...state, pendingHardBoundary: boundary };
}

export function installLease(state: LeaseState, lease: TaskLease): LeaseState {
  const rest = { ...state };
  delete rest.pendingHardBoundary;
  return { ...rest, active: lease, manualOverride: false };
}

export function markManualOverride(state: LeaseState): LeaseState {
  return {
    ...state,
    manualOverride: true,
    ...(state.active ? { active: { ...state.active, manualOverride: true } } : {}),
  };
}

export function changeEffortWithinLease(
  lease: TaskLease,
  effort: EffortLevel,
  now: string,
): { success: true; lease: TaskLease } | { success: false; reason: string } {
  if (lease.selected.effort === effort) return { success: true, lease };
  const profile = findPromptProfile(lease.selected.vendor, lease.selected.modelId, lease.archetype, effort);
  if (profile?.id !== lease.promptProfileId) {
    return { success: false, reason: "effort is not validated by the leased prompt profile" };
  }
  return {
    success: true,
    lease: {
      ...lease,
      updatedAt: now,
      selected: { ...lease.selected, effort },
    },
  };
}

export function createTaskLease(
  input: Omit<TaskLease, "version" | "attemptIndex" | "promptProfileId" | "manualOverride">,
): TaskLease {
  return {
    version: 1,
    ...input,
    attemptIndex: 0,
    promptProfileId: input.selected.profileId,
    manualOverride: false,
  };
}
