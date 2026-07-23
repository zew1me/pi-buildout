import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOOTSTRAP_ROUTE_POLICIES, reviewerRefs } from "./policy.ts";
import { MODEL_VENDORS } from "./profiles.ts";

function reachableRefs() {
  return [
    ...Object.values(BOOTSTRAP_ROUTE_POLICIES).flatMap((policy) => [...policy.primary, ...policy.fallback]),
    // minimumAbility 1 makes every reviewer tier eligible, so this covers all of them.
    ...MODEL_VENDORS.flatMap((vendor) => reviewerRefs(vendor, 1)),
  ];
}

describe("policy ability table invariants", () => {
  it("never maps one (modelId, effort) pair to conflicting abilities", () => {
    const seen = new Map();
    for (const ref of reachableRefs()) {
      const key = `${ref.modelId}@${ref.effort}`;
      const known = seen.get(key);
      assert.ok(
        known === undefined || known === ref.ability,
        `${key} maps to conflicting abilities ${String(known)} and ${String(ref.ability)}`,
      );
      seen.set(key, ref.ability);
    }
  });
});
