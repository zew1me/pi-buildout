import assert from "node:assert/strict";
import test from "node:test";
import {
	appendBoundedTail,
	boundContextForModel,
	clampThinkingLevel,
	formatModelCatalog,
	parseClassifierDecision,
	supportedThinkingLevels,
	truncateMiddle,
} from "./helpers.ts";

test("classifier parser accepts fenced JSON and rejects invalid effort", () => {
	assert.deepEqual(
		parseClassifierDecision('analysis\n```json\n{"model":"openai/gpt-5.6-luna","effort":"high","rationale":"hard"}\n```'),
		{ model: "openai/gpt-5.6-luna", effort: "high", rationale: "hard" },
	);
	assert.equal(parseClassifierDecision('{"model":"x/y","effort":"extreme"}'), undefined);
	assert.equal(parseClassifierDecision("not json"), undefined);
});

test("thinking support follows model maps and clamps safely", () => {
	const model = {
		provider: "test",
		id: "reasoner",
		reasoning: true,
		thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: null },
	};
	assert.deepEqual(supportedThinkingLevels(model), ["off", "low", "medium", "high", "xhigh"]);
	assert.equal(clampThinkingLevel("minimal", model), "low");
	assert.equal(clampThinkingLevel("max", model), "xhigh");
	assert.equal(clampThinkingLevel("high", { provider: "x", id: "plain", reasoning: false }), "off");
	assert.deepEqual(
		supportedThinkingLevels({ provider: "openai", id: "gpt-5.6-luna", reasoning: true, thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" } }),
		["off", "low", "medium", "high", "xhigh"],
	);
});

test("model catalog exposes exact ids, effort choices, context and cost", () => {
	const catalog = formatModelCatalog([{
		provider: "openai-codex",
		id: "gpt-5.6-luna",
		reasoning: true,
		contextWindow: 272000,
		cost: { input: 2.5, output: 15 },
	}]);
	assert.match(catalog, /openai-codex\/gpt-5\.6-luna/);
	assert.match(catalog, /effort=off\|minimal\|low\|medium\|high/);
	assert.match(catalog, /context=272000/);
	assert.match(catalog, /input=\$2\.5\/M/);
});

test("bounded text helpers retain useful tails without exceeding limits", () => {
	const source = `begin-${"x".repeat(500)}-end`;
	const compact = truncateMiddle(source, 120);
	assert.ok(compact.length <= 120);
	assert.match(compact, /^begin-/);
	assert.match(compact, /-end$/);
	assert.equal(appendBoundedTail("abcdef", "ghij", 5), "fghij");
});

test("child context is bounded to a conservative fraction of its model window", () => {
	const summary = "x".repeat(50_000);
	const bounded = boundContextForModel(summary, "short task", {
		provider: "local",
		id: "small",
		contextWindow: 8_000,
	});
	assert.ok(bounded.length <= 9_590);
	assert.equal(boundContextForModel(summary, "x".repeat(10_000), {
		provider: "local",
		id: "tiny",
		contextWindow: 1_000,
	}), "");
});
