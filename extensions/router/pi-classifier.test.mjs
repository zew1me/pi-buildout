import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectClassifierModels } from "./pi-classifier.ts";

function model(provider, id) {
  return { provider, id };
}

describe("selectClassifierModels", () => {
  it("selects exact configured IDs from different model vendors", () => {
    const selected = selectClassifierModels([
      model("openai-codex", "gpt-5.6-luna"),
      model("anthropic", "claude-sonnet-5"),
    ]);
    assert.equal(selected.primary.model.id, "gpt-5.6-luna");
    assert.equal(selected.primary.vendor, "openai");
    assert.equal(selected.secondary.model.id, "claude-sonnet-5");
    assert.equal(selected.secondary.vendor, "anthropic");
  });

  it("does not downgrade the independent secondary from validated Sonnet to Haiku", () => {
    const selected = selectClassifierModels([
      model("openai-codex", "gpt-5.6-luna"),
      model("anthropic", "claude-haiku-4-5"),
    ]);
    assert.equal(selected.primary.model.id, "gpt-5.6-luna");
    assert.equal(selected.secondary, undefined);
  });

  it("does not invent an unconfigured classifier model", () => {
    const selected = selectClassifierModels([model("openai", "gpt-4o")]);
    assert.equal(selected.primary, undefined);
    assert.equal(selected.secondary, undefined);
  });
});
