import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { describe, it } from "node:test";
import { complete, Type, validateToolArguments } from "@earendil-works/pi-ai/compat";
import { CLASSIFIER_TOOL_NAME, classifyTask } from "../classifier.ts";
import { compilePrompt } from "../core/compiler.ts";
import { TaskFeaturesSchema } from "../core/features.ts";
import { ProgramPlanSchema, validateProgramPlan } from "../core/planning.ts";
import { findPromptProfile } from "../core/profiles.ts";
import { canonicalVendor } from "../core/routing.ts";
import { requireToolCall } from "../core/tool-choice.ts";
import { calibrationError, scoreFeatureAxes } from "./score.ts";

const exportedBifrostKey = process.env.BIFROST_VIRTUAL_KEY;
const exportedBifrostBase = process.env.BIFROST_BASE_URL;
if (!exportedBifrostKey || !exportedBifrostBase) {
	try {
		loadEnvFile(new URL("../../../.env.bifrost.local", import.meta.url));
	} catch (error) {
		if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
	}
}
const bifrostKey = exportedBifrostKey ?? process.env.BIFROST_VIRTUAL_KEY;
const bifrostBase = exportedBifrostBase ?? process.env.BIFROST_BASE_URL;
const enabled = Boolean(bifrostKey && bifrostBase);
const fixtures = JSON.parse(await readFile(new URL("./corpus/routes.json", import.meta.url), "utf8"));
function positiveInteger(value, fallback) {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
const limit = positiveInteger(process.env.ROUTER_EVAL_LIMIT, fixtures.length);

function model(id, provider) {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: bifrostBase?.replace(/\/$/, "").endsWith("/v1")
			? bifrostBase.replace(/\/$/, "")
			: `${bifrostBase?.replace(/\/$/, "")}/v1`,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	};
}

const classifierTool = {
	name: CLASSIFIER_TOOL_NAME,
	description: "Return semantic task features only.",
	parameters: TaskFeaturesSchema,
};

function classifierVendor(modelId) {
	const vendor = canonicalVendor("bifrost", modelId);
	if (!vendor) throw new Error(`Cannot derive classifier vendor for ${modelId}`);
	return vendor;
}

function classifierTransport(selectedModel, vendor) {
	return async (request) => {
		const started = performance.now();
		const response = await complete(
			selectedModel,
			{
				systemPrompt: request.systemPrompt,
				messages: [{ role: "user", content: request.userPrompt, timestamp: Date.now() }],
				tools: [classifierTool],
			},
			{
				apiKey: bifrostKey,
				maxTokens: 4_096,
				maxRetries: 1,
				onPayload: (payload) => requireToolCall(payload, selectedModel.api, CLASSIFIER_TOOL_NAME),
			},
		);
		const toolCall = response.content.find((part) => part.type === "toolCall" && part.name === CLASSIFIER_TOOL_NAME);
		if (!toolCall) {
			const contentTypes = response.content.map((part) => part.type).join(",") || "none";
			throw new Error(
				`Bifrost classifier omitted the schema tool call (stop=${response.stopReason}, content=${contentTypes})`,
			);
		}
		return {
			arguments: validateToolArguments(classifierTool, toolCall),
			provider: selectedModel.provider,
			modelId: selectedModel.id,
			vendor,
			latencyMs: Math.round(performance.now() - started),
			usage: {
				input: response.usage.input,
				output: response.usage.output,
				cacheRead: response.usage.cacheRead,
				cacheWrite: response.usage.cacheWrite,
				cost: response.usage.cost.total,
			},
		};
	};
}

const synopsis = {
	version: 1,
	sessionId: "real-eval",
	workspace: "/evaluation/repository",
	activeTools: ["read", "bash", "edit", "write"],
	context: { tokens: 12_000, contextWindow: 1_000_000, percent: 1.2 },
	repository: {
		root: "/evaluation/repository",
		dirty: false,
		changedFiles: [],
		languageBuckets: ["typescript"],
	},
	artifactState: { readFiles: [], modifiedFiles: [], failedTools: [] },
	priorDecisions: [],
	recentGoals: [],
	recentOutcomes: [],
};

describe("real Bifrost routing evaluation", { skip: !enabled }, () => {
	it("measures classifier accuracy and calibration without provider mocks", async () => {
		const primaryId = process.env.ROUTER_EVAL_PRIMARY_MODEL ?? "gpt-5.5";
		const secondaryId = process.env.ROUTER_EVAL_SECONDARY_MODEL ?? "claude-sonnet-5";
		const primaryVendor = classifierVendor(primaryId);
		const secondaryVendor = classifierVendor(secondaryId);
		assert.notEqual(primaryVendor, secondaryVendor, "classifier eval requires provider-diverse models");
		const results = [];
		for (const fixture of fixtures.slice(0, limit)) {
			const classification = await classifyTask({
				prompt: fixture.prompt,
				synopsis,
				primary: classifierTransport(model(primaryId, `bifrost-${primaryVendor}`), primaryVendor),
				secondary: classifierTransport(model(secondaryId, `bifrost-${secondaryVendor}`), secondaryVendor),
			});
			const expectedAxes = Object.fromEntries(
				["intent", "workflowType", "actionMode", "horizon", "risk", "reviewIntent"]
					.filter((axis) => axis in fixture.featureOverrides)
					.map((axis) => [axis, fixture.featureOverrides[axis]]),
			);
			const score = scoreFeatureAxes(classification.features, expectedAxes);
			const expectedReview = fixture.featureOverrides.reviewIntent === true;
			const actualReview = classification.features.reviewIntent;
			const disagreement =
				classification.primaryFeatures && classification.secondaryFeatures
					? ["intent", "workflowType", "actionMode", "horizon", "risk", "reviewIntent"].some(
							(axis) => classification.primaryFeatures[axis] !== classification.secondaryFeatures[axis],
						)
					: false;
			results.push({
				id: fixture.id,
				accuracy: score.accuracy,
				mismatches: score.mismatches,
				actualAxes: Object.fromEntries(Object.keys(expectedAxes).map((axis) => [axis, classification.features[axis]])),
				confidence: classification.features.confidence,
				correct: score.accuracy === 1,
				archetype: classification.archetype.archetype,
				expectedArchetype: fixture.expected.archetype,
				expectedReview,
				actualReview,
				disagreement,
				escalated: classification.escalated,
				failedClosed: classification.failedClosed,
				attempts: classification.attempts,
			});
		}
		const axisAccuracy = results.reduce((total, result) => total + result.accuracy, 0) / results.length;
		const archetypeAccuracy =
			results.filter((result) => result.archetype === result.expectedArchetype).length / results.length;
		const calibration = calibrationError(results);
		const falseReviewRate =
			results.filter((result) => !result.expectedReview && result.actualReview).length /
			Math.max(1, results.filter((result) => !result.expectedReview).length);
		const missedReviewRate =
			results.filter((result) => result.expectedReview && !result.actualReview).length /
			Math.max(1, results.filter((result) => result.expectedReview).length);
		const escalated = results.filter((result) => result.escalated);
		const disagreementRate = escalated.filter((result) => result.disagreement).length / Math.max(1, escalated.length);
		const attempts = results.flatMap((result) => result.attempts);
		const latencyMs = attempts.reduce((total, attempt) => total + (attempt.latencyMs ?? 0), 0);
		const cost = attempts.reduce((total, attempt) => total + (attempt.usage?.cost ?? 0), 0);
		const hardPolicyViolations = results.filter((result) => result.expectedReview && !result.actualReview).length;
		const failedClosedCount = results.filter((result) => result.failedClosed).length;
		console.log(
			JSON.stringify(
				{
					axisAccuracy,
					archetypeAccuracy,
					calibration,
					falseReviewRate,
					missedReviewRate,
					disagreementRate,
					hardPolicyViolations,
					failedClosedCount,
					classificationLatencyMs: latencyMs,
					classificationCost: cost,
					results,
				},
				null,
				2,
			),
		);
		if (results.length === fixtures.length) {
			assert.ok(axisAccuracy >= 0.8, `classifier axis accuracy ${axisAccuracy} is below 0.8`);
			assert.ok(archetypeAccuracy >= 0.8, `archetype accuracy ${archetypeAccuracy} is below 0.8`);
		} else {
			assert.equal(failedClosedCount, 0, "partial classifier canary failed closed");
			assert.ok(archetypeAccuracy >= 0.8, `partial classifier archetype accuracy ${archetypeAccuracy} is below 0.8`);
		}
		const review = results.find((result) => result.id === "code-review-001");
		if (review) assert.equal(review.archetype, "code_review", "explicit review intent was missed");
		assert.equal(hardPolicyViolations, 0, "real classifier produced a hard-policy violation");
	});

	it("evaluates every archetype as a model/profile paired treatment", async () => {
		const treatments = [
			{
				archetype: "fast_classification",
				vendor: "openai",
				modelId: "gpt-5.6-luna",
				effort: "low",
				request:
					'Summarize in one sentence: "This repository packages pi extensions. Each extension has deterministic tests, and installation is scripted."',
			},
			{
				archetype: "exact_extraction",
				vendor: "openai",
				modelId: "gpt-5.6-terra",
				effort: "medium",
				request: 'Return exactly JSON matching {"name": string, "age": number} for: name=Ada, age=36.',
			},
			{
				archetype: "deliberate_tool_workflow",
				vendor: "openai",
				modelId: "gpt-5.5",
				effort: "medium",
				request:
					"Return a dry-run release checklist in this response with an explicit human checkpoint before publish; do not create files or ask where to save it.",
			},
			{
				archetype: "median_repository_implementation",
				vendor: "openai",
				modelId: "gpt-5.6-terra",
				effort: "medium",
				request:
					"Return a TypeScript patch adding a non-empty check to function save(name: string), plus one unit test.",
			},
			{
				archetype: "terminal_heavy_implementation",
				vendor: "openai",
				modelId: "gpt-5.6-terra",
				effort: "high",
				request: "Diagnose EADDRINUSE on port 3000 and give the minimal safe inspect, fix, and verify commands.",
			},
			{
				archetype: "algorithmic_iterative_coding",
				vendor: "google",
				modelId: "gemini-3.5-flash",
				effort: "medium",
				request:
					"Implement a self-contained TypeScript function that parses comma-separated integers, with edge-case tests.",
			},
			{
				archetype: "code_review",
				vendor: "google",
				modelId: "gemini-3.5-flash",
				effort: "high",
				request:
					"Review `function divide(a,b){ return a/b }` for actionable correctness issues; include evidence anchors.",
			},
			{
				archetype: "implementation_planning",
				vendor: "anthropic",
				modelId: "claude-opus-4-8",
				effort: "high",
				request: "Plan a three-PR additive database migration with dependencies, acceptance, rollout, and rollback.",
			},
			{
				archetype: "large_program_planning",
				vendor: "anthropic",
				modelId: "claude-fable-5",
				effort: "high",
				request: "Plan a twelve-PR service extraction program with a dependency DAG and reversible rollout gates.",
			},
			{
				archetype: "long_context_synthesis",
				vendor: "anthropic",
				modelId: "claude-sonnet-5",
				effort: "medium",
				request:
					"Synthesize: document A requires weekly deploys; document B freezes deploys in December. State the conflict.",
			},
			{
				archetype: "highest_risk_advisory",
				vendor: "openai",
				modelId: "gpt-5.6-sol",
				effort: "max",
				request:
					"Advise on an irreversible production data deletion with ambiguous retention requirements; do not authorize it.",
			},
		];
		const profileLimit = positiveInteger(process.env.ROUTER_EVAL_PROFILE_LIMIT, treatments.length);
		const JudgeSchema = Type.Object(
			{
				pass: Type.Boolean(),
				instructionAdherence: Type.Number({ minimum: 0, maximum: 1 }),
				unnecessaryClarification: Type.Boolean(),
				prematureStop: Type.Boolean(),
				outputSchemaValid: Type.Boolean(),
				toolSelectionAccurate: Type.Boolean(),
				progressClaimsAccurate: Type.Boolean(),
				rationale: Type.String({ maxLength: 2_000 }),
			},
			{ additionalProperties: false },
		);
		const judgeTool = {
			name: "report_profile_judgment",
			description: "Score the paired model/profile treatment against the request and profile contract.",
			parameters: JudgeSchema,
		};
		const planTool = {
			name: "submit_implementation_plan",
			description: "Submit the complete implementation-plan DAG.",
			parameters: ProgramPlanSchema,
		};
		const results = [];
		for (const treatment of treatments.slice(0, profileLimit)) {
			const profile = findPromptProfile(treatment.vendor, treatment.modelId, treatment.archetype, treatment.effort);
			assert.ok(profile, `missing profile for ${treatment.archetype}`);
			const compiled = compilePrompt({
				baseSystemPrompt: "Be safe and accurate.",
				profile,
				synopsis,
				userRequest: treatment.request,
				archetype: treatment.archetype,
			});
			const planning =
				treatment.archetype === "implementation_planning" || treatment.archetype === "large_program_planning";
			const workerResponse = await complete(
				model(treatment.modelId, `bifrost-${treatment.vendor}`),
				{
					systemPrompt: compiled.systemPrompt,
					messages: [
						{ role: "user", content: compiled.contextMessage, timestamp: Date.now() },
						{ role: "user", content: compiled.userRequest, timestamp: Date.now() },
					],
					...(planning ? { tools: [planTool] } : {}),
				},
				{
					apiKey: bifrostKey,
					maxTokens: 4_096,
					maxRetries: 1,
					...(planning
						? { onPayload: (payload) => requireToolCall(payload, "openai-completions", planTool.name) }
						: {}),
				},
			);
			let planValid;
			if (planning) {
				const planCall = workerResponse.content.find(
					(part) => part.type === "toolCall" && part.name === "submit_implementation_plan",
				);
				planValid = planCall ? validateProgramPlan(validateToolArguments(planTool, planCall)).success : false;
			}
			const judgeId =
				treatment.vendor === "anthropic"
					? (process.env.ROUTER_EVAL_OPENAI_JUDGE_MODEL ?? "gpt-5.5")
					: (process.env.ROUTER_EVAL_ANTHROPIC_JUDGE_MODEL ?? "claude-sonnet-5");
			const judgeVendor = treatment.vendor === "anthropic" ? "openai" : "anthropic";
			const judgeResponse = await complete(
				model(judgeId, `bifrost-${judgeVendor}`),
				{
					systemPrompt: "Judge instruction adherence conservatively. Call report_profile_judgment exactly once.",
					messages: [
						{
							role: "user",
							content: JSON.stringify({
								request: treatment.request,
								archetype: treatment.archetype,
								profileId: profile.id,
								outputContract: compiled.outputContract,
								response: workerResponse.content,
								planValid,
							}),
							timestamp: Date.now(),
						},
					],
					tools: [judgeTool],
				},
				{
					apiKey: bifrostKey,
					maxTokens: 1_024,
					maxRetries: 1,
					onPayload: (payload) => requireToolCall(payload, "openai-completions", judgeTool.name),
				},
			);
			const judgmentCall = judgeResponse.content.find(
				(part) => part.type === "toolCall" && part.name === "report_profile_judgment",
			);
			assert.ok(judgmentCall, `judge omitted structured judgment for ${treatment.archetype}`);
			const judgment = validateToolArguments(judgeTool, judgmentCall);
			results.push({
				...treatment,
				profileId: profile.id,
				judgeId,
				planValid,
				judgment,
				workerUsage: workerResponse.usage,
				judgeUsage: judgeResponse.usage,
			});
		}
		const passRate =
			results.filter((result) => result.judgment.pass && result.planValid !== false).length / results.length;
		const unnecessaryClarificationRate =
			results.filter((result) => result.judgment.unnecessaryClarification).length / results.length;
		const prematureStopRate = results.filter((result) => result.judgment.prematureStop).length / results.length;
		const outputSchemaValidity = results.filter((result) => result.judgment.outputSchemaValid).length / results.length;
		const toolSelectionAccuracy =
			results.filter((result) => result.judgment.toolSelectionAccurate).length / results.length;
		const progressClaimAccuracy =
			results.filter((result) => result.judgment.progressClaimsAccurate).length / results.length;
		console.log(
			JSON.stringify(
				{
					passRate,
					unnecessaryClarificationRate,
					prematureStopRate,
					outputSchemaValidity,
					toolSelectionAccuracy,
					progressClaimAccuracy,
					results,
				},
				null,
				2,
			),
		);
		assert.ok(passRate >= 0.8, `paired-treatment pass rate ${passRate} is below 0.8`);
	});
});
