import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateProgramPlan } from "./planning.ts";

function plan() {
  return {
    objective: "Migrate the service without interrupting production traffic.",
    assumptions: ["Both storage formats can be read during migration."],
    unknowns: ["Peak dual-write throughput."],
    pullRequests: [
      {
        id: "schema",
        title: "Add the compatible schema",
        goal: "Introduce additive storage fields.",
        dependsOn: [],
        acceptanceCriteria: ["Old readers remain compatible."],
        rollout: "Apply the additive migration first.",
        rollback: "Remove unused additive fields after traffic is drained.",
        risks: ["Migration lock duration."],
        unknowns: [],
      },
      {
        id: "dual-write",
        title: "Dual-write both representations",
        goal: "Populate the new representation safely.",
        dependsOn: ["schema"],
        acceptanceCriteria: ["Both writes are verified in integration tests."],
        rollout: "Canary at one percent, then ramp.",
        rollback: "Disable the dual-write feature flag.",
        risks: ["Inconsistent partial writes."],
        unknowns: ["Required retry budget."],
      },
    ],
  };
}

describe("validateProgramPlan", () => {
  it("accepts a typed DAG and returns dependency-first order", () => {
    const result = validateProgramPlan(plan());
    assert.equal(result.success, true, result.errors.join("\n"));
    assert.deepEqual(result.topologicalOrder, ["schema", "dual-write"]);
  });

  it("rejects unknown dependencies, duplicates, self-dependencies, and cycles", () => {
    const unknown = plan();
    unknown.pullRequests[1].dependsOn = ["missing", "missing"];
    assert.match(validateProgramPlan(unknown).errors.join("\n"), /unknown pull request|repeats dependency/);

    const cyclic = plan();
    cyclic.pullRequests[0].dependsOn = ["dual-write"];
    assert.match(validateProgramPlan(cyclic).errors.join("\n"), /dependency cycle/);

    const self = plan();
    self.pullRequests[0].dependsOn = ["schema"];
    assert.match(validateProgramPlan(self).errors.join("\n"), /depends on itself/);

    const duplicate = plan();
    duplicate.pullRequests[1].id = "schema";
    assert.match(validateProgramPlan(duplicate).errors.join("\n"), /duplicate pull request id/);
  });

  it("rejects plans without acceptance, rollout, or rollback contracts", () => {
    const invalid = plan();
    invalid.pullRequests[0].acceptanceCriteria = [];
    invalid.pullRequests[0].rollout = "";
    invalid.pullRequests[0].rollback = "";
    const result = validateProgramPlan(invalid);
    assert.equal(result.success, false);
    assert.ok(result.errors.length >= 3);
  });
});
