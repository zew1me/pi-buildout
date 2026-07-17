import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveBifrostEvalEnvironment } from "./environment.ts";

describe("resolveBifrostEvalEnvironment", () => {
  it("prefers each exported BIFROST setting and fills only missing fields from dotenv", () => {
    assert.deepEqual(
      resolveBifrostEvalEnvironment(
        { BIFROST_BASE_URL: "https://exported.example" },
        {
          BIFROST_BASE_URL: "https://dotenv.example",
          BIFROST_VIRTUAL_KEY: "dotenv-key",
        },
      ),
      {
        baseUrl: "https://exported.example",
        virtualKey: "dotenv-key",
      },
    );

    assert.deepEqual(
      resolveBifrostEvalEnvironment(
        { BIFROST_VIRTUAL_KEY: "exported-key" },
        {
          BIFROST_BASE_URL: "https://dotenv.example",
          BIFROST_VIRTUAL_KEY: "dotenv-key",
        },
      ),
      {
        baseUrl: "https://dotenv.example",
        virtualKey: "exported-key",
      },
    );
  });

  it("treats empty exported values as absent", () => {
    assert.deepEqual(
      resolveBifrostEvalEnvironment(
        { BIFROST_BASE_URL: "", BIFROST_VIRTUAL_KEY: "   " },
        {
          BIFROST_BASE_URL: "https://dotenv.example",
          BIFROST_VIRTUAL_KEY: "dotenv-key",
        },
      ),
      {
        baseUrl: "https://dotenv.example",
        virtualKey: "dotenv-key",
      },
    );
  });
});
