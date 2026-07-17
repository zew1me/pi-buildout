import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cycleApplyMode, updateDefaultThinkingLevelJson } from "./helpers.ts";

describe("cycleApplyMode", () => {
  it("toggles from default mode to session-only mode", () => {
    assert.equal(cycleApplyMode("default"), "session");
  });

  it("toggles from session-only mode to default mode", () => {
    assert.equal(cycleApplyMode("session"), "default");
  });
});

describe("updateDefaultThinkingLevelJson", () => {
  it("sets defaultThinkingLevel while preserving existing settings", () => {
    const result = updateDefaultThinkingLevelJson('{"theme":"dark","defaultThinkingLevel":"low"}', "high");
    assert.deepEqual(JSON.parse(result.json), {
      theme: "dark",
      defaultThinkingLevel: "high",
    });
    assert.equal(result.hadParseError, false);
  });

  it("creates settings from an empty file", () => {
    const result = updateDefaultThinkingLevelJson("", "medium");
    assert.deepEqual(JSON.parse(result.json), {
      defaultThinkingLevel: "medium",
    });
    assert.equal(result.hadParseError, false);
  });

  it("recovers from invalid JSON and reports parse error", () => {
    const result = updateDefaultThinkingLevelJson("{not valid json", "minimal");
    assert.deepEqual(JSON.parse(result.json), {
      defaultThinkingLevel: "minimal",
    });
    assert.equal(result.hadParseError, true);
  });
});
