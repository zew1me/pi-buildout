import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { complete, Type, validateToolArguments } from "@earendil-works/pi-ai/compat";
import { CLASSIFIER_TOOL_NAME, classifyTask } from "../classifier.ts";
import { compilePrompt } from "../core/compiler.ts";
import { TaskFeaturesSchema } from "../core/features.ts";
import { findPromptProfile } from "../core/profiles.ts";
import { calibrationError, scoreFeatureAxes } from "./score.ts";

const bifrostKey = process.env.BIFROST_VIRTUAL_KEY;
const bifrostBase = process.env.BIFROST_BASE_URL;
const enabled = Boolean(bifrostKey && bifrostBase);
const fixtures = JSON.parse(await readFile(new URL("./corpus/routes.json", import.meta.url), "utf8"));
const limit = Math.max(1, Number.parseInt(process.env.ROUTER_EVAL_LIMIT ?? String(fixtures.length), 10));

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

function text(response) {
	return response.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
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
			results.push({
				id: fixture.id,
				accuracy: score.accuracy,
				confidence: classification.features.confidence,
				correct: score.accuracy === 1,
				archetype: classification.archetype.archetype,
				expectedArchetype: fixture.expected.archetype,
				attempts: classification.attempts,
			});
		}
		const axisAccuracy = results.reduce((total, result) => total + result.accuracy, 0) / results.length;
		const archetypeAccuracy =
			results.filter((result) => result.archetype === result.expectedArchetype).length / results.length;
		const calibration = calibrationError(results);
		console.log(JSON.stringify({ axisAccuracy, archetypeAccuracy, calibration, results }, null, 2));
		assert.ok(axisAccuracy >= 0.8, `classifier axis accuracy ${axisAccuracy} is below 0.8`);
		assert.ok(archetypeAccuracy >= 0.8, `archetype accuracy ${archetypeAccuracy} is below 0.8`);
		const review = results.find((result) => result.id === "code-review-001");
		if (review) assert.equal(review.archetype, "code_review", "explicit review intent was missed");
	});

	it("evaluates a model and its own prompt profile as one paired treatment", async () => {
		const workerId = process.env.ROUTER_EVAL_WORKER_MODEL ?? "gpt-5.6-luna";
		const judgeId = process.env.ROUTER_EVAL_JUDGE_MODEL ?? "claude-sonnet-5";
		const profile = findPromptProfile("openai", "gpt-5.6-luna", "fast_classification", "low");
		assert.ok(profile);
		const request = "Summarize the purpose of a repository that packages pi extensions in one sentence.";
		const compiled = compilePrompt({
			baseSystemPrompt: "Be safe and accurate.",
			profile,
			synopsis,
			userRequest: request,
		});
		const workerResponse = await complete(
			model(workerId, "bifrost-openai"),
			{
				systemPrompt: compiled.systemPrompt,
				messages: [
					{ role: "user", content: compiled.contextMessage, timestamp: Date.now() },
					{ role: "user", content: compiled.userRequest, timestamp: Date.now() },
				],
			},
			{ apiKey: bifrostKey, maxTokens: 1_024, maxRetries: 1 },
		);
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
			description: "Score the paired treatment.",
			parameters: JudgeSchema,
		};
		const judgeResponse = await complete(
			model(judgeId, "bifrost-anthropic"),
			{
				systemPrompt: "Judge instruction adherence. Call report_profile_judgment exactly once.",
				messages: [
					{
						role: "user",
						content: JSON.stringify({ request, profileId: profile.id, response: text(workerResponse) }),
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
		assert.ok(judgmentCall, "judge omitted structured judgment");
		const judgment = validateToolArguments(judgeTool, judgmentCall);
		console.log(JSON.stringify({ workerId, judgeId, profileId: profile.id, judgment }, null, 2));
		assert.equal(judgment.pass, true, judgment.rationale);
	});
});
