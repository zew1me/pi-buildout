import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BOOTSTRAP_ROUTE_POLICIES, HARD_TASK_ESCALATION_REFS, MODEL_VENDOR, reviewerRefs } from "./policy.ts";
import { ARCHETYPES } from "./archetype.ts";
import { EFFORT_LEVELS, findPromptProfile, MODEL_VENDORS, PROMPT_PROFILES } from "./profiles.ts";
import { canonicalModelId } from "./scope.ts";
import { canonicalVendor } from "./routing.ts";

/**
 * A captured survey of the registry spellings a configured machine exposes, checked in on purpose.
 * Reading the live `@earendil-works/pi-ai` catalog here would make these assertions drift on any
 * dependency bump, and the pinned devDependency does not carry the same set of models as the runtime
 * registry, so a live read is ambiguous as well as unstable.
 */
const REGISTRY_SPELLINGS = JSON.parse(
  readFileSync(new URL("./fixtures/registry-spellings.json", import.meta.url), "utf8"),
);

/** Every (archetype, logical model, effort) triple the bootstrap policy is able to name. */
function policyNamedTriples() {
  const triples = [];
  for (const policy of Object.values(BOOTSTRAP_ROUTE_POLICIES)) {
    for (const ref of [...policy.primary, ...policy.fallback]) {
      triples.push({ archetype: policy.archetype, logicalModelId: ref.logicalModelId, effort: ref.effort });
    }
    if (policy.pinnedPrimary) {
      triples.push({
        archetype: policy.archetype,
        logicalModelId: policy.pinnedPrimary.logicalModelId,
        effort: policy.pinnedPrimary.effort,
      });
    }
    for (const ref of HARD_TASK_ESCALATION_REFS) {
      triples.push({ archetype: policy.archetype, logicalModelId: ref.logicalModelId, effort: ref.effort });
    }
  }
  return triples;
}

/** Fixture endpoints grouped by the logical model their spelling canonicalizes to. */
function spellingsByLogicalModel() {
  const groups = new Map();
  for (const endpoint of REGISTRY_SPELLINGS) {
    const logical = canonicalModelId(endpoint.modelId);
    if (!groups.has(logical)) groups.set(logical, []);
    groups.get(logical).push(endpoint);
  }
  return groups;
}

describe("prompt profile eligibility is declared in canonical logical model IDs", () => {
  it("declares no provider-specific registry spelling in any profile", () => {
    for (const profile of PROMPT_PROFILES) {
      for (const modelId of profile.modelIds) {
        assert.equal(
          modelId,
          canonicalModelId(modelId),
          `${profile.id} declares the non-canonical spelling ${modelId}`,
        );
      }
    }
  });

  it("covers every policy-named logical model in the checked-in registry fixture", () => {
    const covered = spellingsByLogicalModel();
    for (const logicalModelId of Object.keys(MODEL_VENDOR)) {
      assert.ok(
        covered.has(logicalModelId),
        `the registry fixture has no spelling for policy-named model ${logicalModelId}`,
      );
    }
  });

  it("resolves the same profile for every registry spelling of a policy-named triple", () => {
    const groups = spellingsByLogicalModel();
    let asserted = 0;
    for (const { archetype, logicalModelId, effort } of policyNamedTriples()) {
      const vendor = MODEL_VENDOR[logicalModelId];
      assert.ok(vendor, `no vendor is declared for ${logicalModelId}`);
      const canonicalProfile = findPromptProfile(vendor, logicalModelId, archetype, effort);
      assert.ok(canonicalProfile, `no ${archetype}/${effort} profile resolves for policy-named ${logicalModelId}`);
      for (const endpoint of groups.get(logicalModelId) ?? []) {
        assert.equal(
          findPromptProfile(vendor, endpoint.modelId, archetype, effort)?.id,
          canonicalProfile.id,
          `${endpoint.provider}/${endpoint.modelId} resolves a different profile than ${logicalModelId} for ${archetype}/${effort}`,
        );
        asserted += 1;
      }
    }
    assert.ok(asserted > 0, "the fixture produced no spelling assertions at all");
  });

  it("leaves no policy-named fixture endpoint without any resolvable profile", () => {
    // The defect this replaces: eligibility matched an exact registry ID while resolveEndpoints
    // grouped endpoints by canonical ID, so 23 of these 60 endpoints were excluded as
    // profile_missing, 22 of them amazon-bedrock. Canonical matching is strictly additive, so the
    // expected count is now zero.
    const unroutable = [];
    for (const endpoint of REGISTRY_SPELLINGS) {
      const logical = canonicalModelId(endpoint.modelId);
      const vendor = MODEL_VENDOR[logical];
      if (!vendor) continue;
      const resolvable = ARCHETYPES.some((archetype) =>
        EFFORT_LEVELS.some((effort) => findPromptProfile(vendor, endpoint.modelId, archetype, effort)),
      );
      if (!resolvable) unroutable.push(`${endpoint.provider}/${endpoint.modelId}`);
    }
    assert.deepEqual(unroutable, [], "policy-named endpoints resolve no profile and would be excluded");
  });

  it("resolves a profile for the configured Bifrost gateway spelling of Sonnet 5", () => {
    // decisions.md records bifrost/bedrock/anthropic.claude-sonnet-5 as a deliberate Sonnet 5
    // availability alternative, not an exclusion, so it must stay eligible after canonicalization.
    assert.equal(canonicalModelId("bedrock/anthropic.claude-sonnet-5"), "claude-sonnet-5");
    assert.ok(
      findPromptProfile("anthropic", "bedrock/anthropic.claude-sonnet-5", "median_repository_implementation", "medium"),
    );
  });
});

describe("canonical eligibility does not over-admit", () => {
  it("resolves neither a vendor nor a profile for an unrelated regional ID", () => {
    assert.equal(canonicalVendor("amazon-bedrock", "us.gov-cloud-widget-1"), undefined);
    // scope.ts strips the region prefix unconditionally; the result is still nobody's model.
    assert.equal(canonicalModelId("us.gov-cloud-widget-1"), "gov-cloud-widget-1");
    assert.equal(MODEL_VENDOR[canonicalModelId("us.gov-cloud-widget-1")], undefined);
    for (const vendor of MODEL_VENDORS) {
      assert.equal(
        findPromptProfile(vendor, "us.gov-cloud-widget-1", "median_repository_implementation", "medium"),
        undefined,
      );
    }
  });

  it("does not let a different model inherit a neighbour's profile", () => {
    assert.equal(MODEL_VENDOR["claude-opus-4-8"], undefined);
    for (const spelling of [
      "claude-opus-4-8",
      "claude-opus-4.8",
      "eu.anthropic.claude-opus-4-8",
      "anthropic.claude-opus-4-8",
    ]) {
      assert.equal(
        findPromptProfile("anthropic", spelling, "implementation_planning", "high"),
        undefined,
        `${spelling} retained the removed previous-generation planning profile`,
      );
    }

    // claude-opus-4-7 sits between two admitted models and is named by no profile.
    assert.equal(MODEL_VENDOR["claude-opus-4-7"], undefined);
    for (const spelling of [
      "claude-opus-4-7",
      "claude-opus-4.7",
      "us.anthropic.claude-opus-4-7-v1",
      "anthropic.claude-opus-4-7",
    ]) {
      assert.equal(
        findPromptProfile("anthropic", spelling, "implementation_planning", "high"),
        undefined,
        `${spelling} inherited a neighbouring model's profile`,
      );
    }
    // A model on nobody's ladder stays ineligible however it is spelled.
    assert.equal(findPromptProfile("anthropic", "us.amazon.nova-lite-v1:0", "fast_classification", "low"), undefined);
  });

  it("keeps distinct policy-named models on distinct logical IDs", () => {
    const logical = Object.keys(MODEL_VENDOR).map(canonicalModelId);
    assert.equal(new Set(logical).size, logical.length, "two policy-named models collapse to one logical ID");
    // The spellings that previously needed hand-listing must not merge separate generations.
    const pairs = [
      ["anthropic.claude-opus-5-5", "anthropic.claude-sonnet-5"],
      ["openai.gpt-6-luna", "openai.gpt-5.6-terra"],
      ["claude-haiku-4.5", "claude-sonnet-5"],
    ];
    for (const [left, right] of pairs) {
      assert.notEqual(
        canonicalModelId(left),
        canonicalModelId(right),
        `${left} and ${right} collapsed to the same logical ID`,
      );
    }
    // Distinct logical IDs must also not share an identity through the profile lookup.
    assert.notEqual(
      findPromptProfile("anthropic", "us.anthropic.claude-opus-4-6-v1", "median_repository_implementation", "medium")
        ?.id,
      findPromptProfile("anthropic", "anthropic.claude-opus-5-5", "median_repository_implementation", "medium")?.id,
    );
  });
});

describe("review-only Gemini 3.8", () => {
  it("leads Google's reviewer availability chain and resolves no general-work profile", () => {
    const googleReviewers = reviewerRefs("google", 4);
    assert.equal(googleReviewers[0]?.logicalModelId, "gemini-3.8-flash");
    assert.equal(
      findPromptProfile("google", "gemini-3.8-flash", "code_review", "high")?.id,
      "google-gemini-3.8-review-v1",
    );
    for (const archetype of ARCHETYPES.filter((entry) => entry !== "code_review")) {
      for (const effort of EFFORT_LEVELS) {
        assert.equal(findPromptProfile("google", "gemini-3.8-flash", archetype, effort), undefined);
      }
    }
  });
});

describe("the scoped Kimi rungs", () => {
  it("maps both Bedrock spellings to one bounded profile", () => {
    for (const modelId of ["moonshotai.kimi-k2.5", "moonshot.kimi-k2-thinking"]) {
      assert.equal(
        findPromptProfile("moonshot", modelId, "fast_classification", "low")?.id,
        "moonshot-kimi-bounded-v1",
      );
      assert.equal(findPromptProfile("moonshot", modelId, "median_repository_implementation", "low"), undefined);
    }
  });

  it("appears only as a read-only-confined fallback in bounded ladders", () => {
    const bounded = new Set(["fast_classification", "exact_extraction"]);
    const namedBy = [];
    for (const [archetype, policy] of Object.entries(BOOTSTRAP_ROUTE_POLICIES)) {
      const refs = [...policy.primary, ...policy.fallback].filter((ref) => ref.vendor === "moonshot");
      if (refs.length === 0) continue;
      namedBy.push(archetype);
      assert.ok(bounded.has(archetype), `${archetype} must not route a Kimi bounded candidate`);
      assert.ok(refs.every((ref) => ref.singleAttemptEvidence === true));
      assert.ok(policy.primary.every((ref) => ref.vendor !== "moonshot"));
    }
    assert.deepEqual(namedBy.sort(), [...bounded].sort());
  });
});

describe("profile-less vendors", () => {
  it("resolves a vendor for every reachable Grok, GLM, Qwen, and Nemotron spelling", () => {
    // buildRegistrySnapshot drops any endpoint whose vendor is unknown, so these would otherwise be
    // invisible to classifier tiers and diagnostics even when scoped in and reachable.
    const cases = [
      ["github-copilot", "grok-4.7", "xai", "grok-4.7"],
      ["amazon-bedrock", "xai.grok-4.6", "xai", "grok-4.6"],
      ["amazon-bedrock", "us.xai.grok-4.7", "xai", "grok-4.7"],
      ["amazon-bedrock", "global.xai.grok-4.7", "xai", "grok-4.7"],
      ["amazon-bedrock", "zai.glm-5", "zai", "glm-5"],
      ["amazon-bedrock", "zai.glm-4.7-flash", "zai", "glm-4.7-flash"],
      ["amazon-bedrock", "qwen.qwen3-vl-235b-a22b", "qwen", "qwen3-vl-235b-a22b"],
      ["amazon-bedrock", "qwen.qwen3-coder-480b-a35b-v1:0", "qwen", "qwen3-coder-480b-a35b"],
      ["amazon-bedrock", "nvidia.nemotron-super-3-120b", "nvidia", "nemotron-super-3-120b"],
      ["amazon-bedrock", "nvidia.nemotron-nano-3-30b", "nvidia", "nemotron-nano-3-30b"],
      ["amazon-bedrock", "us.moonshotai.kimi-k3", "moonshot", "kimi-k3"],
      ["github-copilot", "mai-code-1.1-flash", "microsoft", "mai-code-1.1-flash"],
    ];
    for (const [provider, modelId, vendor, logical] of cases) {
      assert.equal(canonicalVendor(provider, modelId), vendor, modelId);
      assert.equal(canonicalModelId(modelId), logical, modelId);
    }
  });

  it("grants no prompt profile or route to a vendor it merely recognizes", () => {
    const models = [
      ["xai", "grok-4.7"],
      ["zai", "glm-5"],
      ["qwen", "qwen3-vl-235b-a22b"],
      ["nvidia", "nemotron-super-3-120b"],
      ["microsoft", "mai-code-1.1-flash"],
    ];
    for (const [vendor, modelId] of models) {
      assert.ok(MODEL_VENDORS.includes(vendor), vendor);
      for (const archetype of ARCHETYPES) {
        for (const effort of EFFORT_LEVELS) {
          assert.equal(findPromptProfile(vendor, modelId, archetype, effort), undefined, `${vendor}/${modelId}`);
        }
      }
    }
    for (const policy of Object.values(BOOTSTRAP_ROUTE_POLICIES)) {
      for (const ref of [...policy.primary, ...policy.fallback]) {
        assert.ok(!["xai", "zai", "qwen", "nvidia", "microsoft"].includes(ref.vendor), ref.logicalModelId);
      }
    }
  });

  it("still leaves an unrelated regional ID vendorless", () => {
    assert.equal(canonicalVendor("amazon-bedrock", "us.meta.llama4-scout-17b-instruct-v1:0"), undefined);
    assert.equal(canonicalVendor("amazon-bedrock", "google.gemma-3-27b-it"), undefined);
    assert.equal(canonicalVendor("some-gateway", "qwenish-widget"), undefined);
  });
});

describe("the scoped MiniMax rung", () => {
  it("resolves a vendor for every reachable MiniMax spelling", () => {
    // buildRegistrySnapshot drops any endpoint whose vendor is unknown, and a dropped endpoint is
    // invisible rather than excluded with a reason, so an unresolved vendor is the quietest failure.
    for (const modelId of ["minimax.minimax-m2.5", "minimax.minimax-m2", "minimax.minimax-m2.1"]) {
      assert.equal(canonicalVendor("amazon-bedrock", modelId), "minimax", modelId);
    }
    // Bedrock repeats the brand as both vendor segment and model token; the bare form has only one.
    assert.equal(canonicalVendor("amazon-bedrock", "minimax-m2.5"), "minimax");
    assert.equal(canonicalModelId("minimax.minimax-m2.5"), "minimax-m2.5");
  });

  it("resolves the same bounded profile for the logical ID and the Bedrock spelling", () => {
    for (const archetype of ["fast_classification", "exact_extraction"]) {
      const viaLogical = findPromptProfile("minimax", "minimax-m2.5", archetype, "low");
      assert.equal(viaLogical?.id, "minimax-m2.5-bounded-v1", `${archetype} via logical ID`);
      assert.equal(
        findPromptProfile("minimax", "minimax.minimax-m2.5", archetype, "low")?.id,
        viaLogical?.id,
        `${archetype} via the amazon-bedrock spelling`,
      );
    }
  });

  it("confines the profile to bounded read-only archetypes and the efforts the endpoint exposes", () => {
    const profile = PROMPT_PROFILES.find((entry) => entry.id === "minimax-m2.5-bounded-v1");
    assert.ok(profile);
    assert.deepEqual([...profile.archetypes].sort(), ["exact_extraction", "fast_classification"]);
    // Nothing above `high` exists on the endpoint, so the profile must not offer it.
    for (const effort of ["xhigh", "max"]) {
      assert.ok(!profile.efforts.includes(effort), `profile offers ${effort}, which the endpoint lacks`);
      assert.equal(findPromptProfile("minimax", "minimax-m2.5", "fast_classification", effort), undefined);
    }
    // And it must not resolve for work it has no evidence for.
    for (const archetype of ["median_repository_implementation", "code_review", "implementation_planning"]) {
      assert.equal(findPromptProfile("minimax", "minimax-m2.5", archetype, "low"), undefined, archetype);
    }
  });

  it("gives the refused scoped models no profile at all", () => {
    // Each model was refused on a recorded evidence, cost, or compensating-benefit axis, so it must
    // stay structurally ineligible rather than merely unlisted in a ladder.
    for (const modelId of ["glm-5", "glm-4.7", "deepseek-v3.2", "qwen3-coder-next", "grok-4.3"]) {
      for (const vendor of MODEL_VENDORS) {
        for (const archetype of ARCHETYPES) {
          for (const effort of EFFORT_LEVELS) {
            assert.equal(findPromptProfile(vendor, modelId, archetype, effort), undefined, `${vendor}/${modelId}`);
          }
        }
      }
    }
  });

  it("appears only in the two bounded read-only ladders, and never as a primary", () => {
    assert.equal(MODEL_VENDOR["minimax-m2.5"], "minimax");
    const bounded = new Set(["fast_classification", "exact_extraction"]);
    let laddersNaming = 0;
    for (const [archetype, policy] of Object.entries(BOOTSTRAP_ROUTE_POLICIES)) {
      const named = [...policy.primary, ...policy.fallback].filter((ref) => ref.logicalModelId === "minimax-m2.5");
      if (named.length === 0) continue;
      laddersNaming += 1;
      assert.ok(bounded.has(archetype), `minimax-m2.5 must not appear in ${archetype}`);
      // Never the DECLARED primary. It may still be selected as the primary when every rung ahead of it
      // is ineligible, which routing.test.mjs covers; that is intended and explained in core/policy.ts.
      assert.ok(
        !policy.primary.some((ref) => ref.logicalModelId === "minimax-m2.5"),
        `minimax-m2.5 must not be the declared primary of ${archetype}`,
      );
      for (const ref of named) {
        assert.equal(ref.singleAttemptEvidence, true, `${archetype} names it without the read-only confinement flag`);
        assert.equal(ref.effort, "low");
      }
    }
    assert.equal(laddersNaming, 2, "minimax-m2.5 must be named by exactly the two bounded ladders");
    // It is also not an escalation candidate: hard-task retry is a measured-flakiness decision and this
    // model has no repeat measurement at all.
    assert.ok(!HARD_TASK_ESCALATION_REFS.some((ref) => ref.logicalModelId === "minimax-m2.5"));
  });
});
