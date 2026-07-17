import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveArchetype } from "./archetype.ts";
import { conservativeFeatures } from "./features.ts";
import {
	canonicalVendor,
	registrySnapshotId,
	robustCostToDone,
	selectOrdinaryRoute,
	selectReviewRoute,
} from "./routing.ts";

function model(provider, modelId, vendor, contextWindow = 1_000_000) {
	return {
		provider,
		modelId,
		name: modelId,
		vendor,
		contextWindow,
		maxOutputTokens: 128_000,
		available: true,
		reasoning: true,
		supportedEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		inputTypes: ["text", "image"],
		toolCapable: true,
		costPerMillion: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
	};
}

function registry() {
	return [
		model("openai-codex", "gpt-5.6-luna", "openai"),
		model("openai-codex", "gpt-5.6-terra", "openai"),
		model("openai-codex", "gpt-5.6-sol", "openai"),
		model("openai-codex", "gpt-5.5", "openai"),
		model("openai-codex", "gpt-5.4", "openai"),
		model("anthropic", "claude-haiku-4-5", "anthropic"),
		model("anthropic", "claude-sonnet-5", "anthropic"),
		model("anthropic", "claude-opus-4-8", "anthropic"),
		model("anthropic", "claude-fable-5", "anthropic"),
		model("github-copilot", "gemini-3.5-flash", "google"),
	];
}

const REQUIREMENTS = { estimatedFinishedTokens: 50_000, requiresImages: false, requiresTools: true };

describe("deriveArchetype", () => {
	it("routes planning by horizon before implementation", () => {
		const features = {
			...conservativeFeatures(),
			intent: "plan",
			workflowType: "implementation_planning",
			horizon: "two_to_ten_prs",
			risk: "medium",
			ambiguity: "medium",
			reviewIntent: false,
		};
		assert.equal(deriveArchetype(features).archetype, "implementation_planning");
		assert.equal(
			deriveArchetype({ ...features, horizon: "eleven_to_hundred_prs" }).archetype,
			"large_program_planning",
		);
	});
});

describe("ordinary route selection", () => {
	it("selects bootstrap primary and required OpenAI/Anthropic fallback", () => {
		const decision = selectOrdinaryRoute("median_repository_implementation", registry(), REQUIREMENTS);
		assert.equal(decision.kind, "ordinary");
		assert.equal(decision.primary.modelId, "gpt-5.6-terra");
		assert.equal(decision.fallback.modelId, "claude-sonnet-5");
		assert.ok(["openai", "anthropic"].includes(decision.fallback.vendor));
		assert.notEqual(decision.primary.profileId, "");
	});

	it("rejects candidates that exceed 70% context headroom", () => {
		const smallRegistry = registry().map((candidate) => ({ ...candidate, contextWindow: 100_000 }));
		const decision = selectOrdinaryRoute("median_repository_implementation", smallRegistry, {
			...REQUIREMENTS,
			estimatedFinishedTokens: 70_001,
		});
		assert.equal(decision.kind, "unroutable");
		assert.ok(decision.exclusions.some((exclusion) => exclusion.code === "context_headroom"));
	});

	it("preserves bootstrap order until every comparable candidate is mature", () => {
		const samples = [
			{
				provider: "openai-codex",
				modelId: "gpt-5.6-terra",
				archetype: "median_repository_implementation",
				comparableSamples: 30,
				acceptedRate: 0.99,
				p75ModelAndToolCost: 100,
				p75WallTimeMs: 100,
				probabilityHumanIntervention: 0,
				probabilityRetry: 0,
			},
		];
		const decision = selectOrdinaryRoute("median_repository_implementation", registry(), REQUIREMENTS, samples);
		assert.equal(decision.kind, "ordinary");
		assert.equal(decision.telemetryMature, false);
		assert.equal(decision.primary.modelId, "gpt-5.6-terra");
	});
});

describe("review route selection", () => {
	it("selects both non-builder vendors and fixes the builder as final fallback", () => {
		const models = registry();
		const builder = models.find((candidate) => candidate.modelId === "gpt-5.6-terra");
		const decision = selectReviewRoute(models, REQUIREMENTS, builder, "medium", 2);
		assert.equal(decision.kind, "review");
		assert.deepEqual(new Set([decision.primary.vendor, decision.fallback.vendor]), new Set(["anthropic", "google"]));
		assert.equal(decision.builderFallback.vendor, "openai");
		assert.equal(decision.builderFallback.rankReason, "fixed_builder_fallback");
	});
});

describe("routing helpers", () => {
	it("normalizes gateway model IDs to their actual vendor", () => {
		assert.equal(canonicalVendor("github-copilot", "claude-sonnet-5"), "anthropic");
		assert.equal(canonicalVendor("github-copilot", "gemini-3.5-flash"), "google");
		assert.equal(canonicalVendor("openai-codex", "gpt-5.6-terra"), "openai");
	});

	it("calculates robust cost-to-done and stable snapshots", () => {
		assert.equal(
			robustCostToDone(
				{
					provider: "openai",
					modelId: "x",
					archetype: "fast_classification",
					comparableSamples: 30,
					acceptedRate: 1,
					p75ModelAndToolCost: 2,
					p75WallTimeMs: 10,
					probabilityHumanIntervention: 0.1,
					probabilityRetry: 0.2,
				},
				{ developerWaitValuePerMs: 0.5, humanInterventionCost: 10, retryCost: 5 },
			),
			9,
		);
		assert.equal(registrySnapshotId(registry()), registrySnapshotId([...registry()].reverse()));
	});
});
