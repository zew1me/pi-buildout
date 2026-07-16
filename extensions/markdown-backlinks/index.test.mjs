import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findMarkdownPointers, formatBacklinkTable } from "./helpers.ts";

describe("findMarkdownPointers", () => {
  it("finds file pointers and de-duplicates them", () => {
    assert.deepEqual(findMarkdownPointers("Read @README.md and @src/app.ts; then read @README.md."), [
      "@README.md",
      "@src/app.ts",
    ]);
  });

  it("does not treat email addresses as file pointers", () => {
    assert.deepEqual(findMarkdownPointers("Contact me@example.com; see @notes.txt."), ["@notes.txt"]);
  });
});

describe("formatBacklinkTable", () => {
  it("describes the read-until-resolved behavior", () => {
    const text = formatBacklinkTable([
      { sourcePath: "/repo/AGENTS.md", pointer: "@README.md", targetPath: "/repo/README.md" },
    ]);
    assert.match(text, /@README\.md/);
    assert.match(text, /reasonable candidate for a `read` tool call/);
    assert.match(text, /until the target is read successfully/);
  });
});
