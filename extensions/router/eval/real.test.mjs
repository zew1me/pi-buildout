import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { complete, Type, validateToolArguments } from "@earendil-works/pi-ai/compat";
import { CLASSIFIER_TOOL_NAME, classifyTask } from "../classifier.ts";
import { compilePrompt } from "../core/compiler.ts";
import { TaskFeaturesSchema } from "../core/features.ts";
import { ProgramPlanSchema, validateProgramPlan } from "../core/planning.ts";
import { findPromptProfile } from "../core/profiles.ts";
import { calibrationError, scoreFeatureAxes } from "./score.ts";

const bifrostKey = process.env.BIFROST_VIRTUAL_KEY;
const bifrostBase = process.env.BIFROST_BASE_URL;
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
			{ apiKey: bifrostKey, maxTokens: 4_096, maxRetries: 1 },
		);
		const toolCall = response.content.find((part) => part.type === "toolCall" && part.name === CLASSIFIER_TOOL_NAME);
		if (!toolCall) throw new Error("Bifrost classifier omitted the schema tool call");
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
		const primaryId = process.env.ROUTER_EVAL_PRIMARY_MODEL ?? "gpt-5.6-luna";
		const secondaryId = process.env.ROUTER_EVAL_SECONDARY_MODEL ?? "claude-sonnet-5";
		const results = [];
		for (const fixture of fixtures.slice(0, limit)) {
			const classification = await classifyTask({
				prompt: fixture.prompt,
				synopsis,
				primary: classifierTransport(model(primaryId, "bifrost-openai"), "openai"),
				secondary: classifierTransport(model(secondaryId, "bifrost-anthropic"), "anthropic"),
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
		assert.ok(axisAccuracy >= 0.8, `classifier axis accuracy ${axisAccuracy} is below 0.8`);
		assert.ok(archetypeAccuracy >= 0.8, `archetype accuracy ${archetypeAccuracy} is below 0.8`);
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
				request: "Summarize in one sentence: this repository packages tested pi extensions.",
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
				request: "Write a dry-run release checklist with an explicit human checkpoint before publish.",
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
				rationale: Type.String({ maxLength: 500 }),
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
				{ apiKey: bifrostKey, maxTokens: 4_096, maxRetries: 1 },
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
					? (process.env.ROUTER_EVAL_OPENAI_JUDGE_MODEL ?? "gpt-5.6-terra")
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
								outputContract: profile.outputContract,
								response: workerResponse.content,
								planValid,
							}),
							timestamp: Date.now(),
						},
					],
					tools: [judgeTool],
				},
				{ apiKey: bifrostKey, maxTokens: 1_024, maxRetries: 1 },
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
		console.log(JSON.stringify({ passRate, unnecessaryClarificationRate, prematureStopRate, results }, null, 2));
		assert.ok(passRate >= 0.8, `paired-treatment pass rate ${passRate} is below 0.8`);
	});
});
