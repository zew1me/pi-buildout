import type { TaskLease } from "./lease.ts";
import type { RouteChoice } from "./routing.ts";

// Cross-lease endpoint circuit breaking and background health recovery are tracked in
// specs/routing-layer/future-work.md; this module intentionally handles only bounded in-lease fallback.
export type FailureKind = "availability" | "model_error" | "quality" | "deterministic_verification";

export type FallbackResolution =
  | { action: "use_choice"; choice: RouteChoice; lease: TaskLease; reason: string; reviewFellBackToBuilder: boolean }
  | { action: "restore_previous"; choice?: RouteChoice; lease: TaskLease; reason: string }
  | { action: "skip_review"; lease: TaskLease; reason: string };

export function validateFallbackTopology(lease: TaskLease): string[] {
  const errors: string[] = [];
  if (lease.archetype === "code_review") {
    if (lease.fallbacks.length !== 2)
      errors.push("review lease must have one independent fallback and fixed builder fallback");
    const vendors = new Set([lease.selected, ...lease.fallbacks].map((choice) => choice.vendor));
    if (vendors.size !== 3) errors.push("review attempts must cover both non-builder vendors and the builder vendor");
  } else if (lease.fallbacks.length === 0) {
    errors.push("ordinary lease must have at least one fallback");
  }
  return errors;
}

export function resolveFallback(lease: TaskLease, failure: FailureKind, now: string): FallbackResolution {
  const nextAttempt = lease.attemptIndex + 1;
  const nextChoice = lease.fallbacks[lease.attemptIndex];
  if (nextChoice) {
    const isBuilderFallback = lease.archetype === "code_review" && nextAttempt === 2;
    const updated: TaskLease = {
      ...lease,
      updatedAt: now,
      attemptIndex: nextAttempt,
      selected: nextChoice,
      promptProfileId: nextChoice.profileId,
    };
    return {
      action: "use_choice",
      choice: nextChoice,
      lease: updated,
      reason: isBuilderFallback
        ? `both independent review attempts failed; fixed builder fallback after ${failure}`
        : `sequential fallback after ${failure}`,
      reviewFellBackToBuilder: isBuilderFallback,
    };
  }

  if (lease.archetype === "code_review") {
    return { action: "skip_review", lease, reason: "all review attempts failed; preserve the parent task lease" };
  }
  return {
    action: "restore_previous",
    ...(lease.previousSelection ? { choice: lease.previousSelection } : {}),
    lease,
    reason: "all authorized ordinary provider choices exhausted; restoring the previous selection",
  };
}
