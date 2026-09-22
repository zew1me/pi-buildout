import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countUpstreamEditedLines,
  diffChecksumManifests,
  formatChecksumManifest,
  parseChecksumManifest,
  patchedFileList,
} from "./build-pi-patch.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("formatChecksumManifest emits sha256sum format with two spaces and a trailing newline", () => {
  const text = formatChecksumManifest([
    { path: "dist/main.js", sha256: HASH_A },
    { path: "docs/skills.md", sha256: HASH_B },
  ]);
  assert.equal(text, `${HASH_A}  dist/main.js\n${HASH_B}  docs/skills.md\n`);
});

test("formatChecksumManifest preserves caller order so regeneration stays byte-stable", () => {
  const entries = [
    { path: "z.js", sha256: HASH_A },
    { path: "a.js", sha256: HASH_B },
  ];
  assert.equal(formatChecksumManifest(entries), formatChecksumManifest(entries));
  assert.match(formatChecksumManifest(entries), /^.*z\.js\n.*a\.js\n$/s);
});

test("formatChecksumManifest round-trips through parseChecksumManifest", () => {
  const entries = [
    { path: "dist/main.js", sha256: HASH_A },
    { path: "dist/core/skill-management.js", sha256: HASH_B },
  ];
  assert.deepEqual(parseChecksumManifest(formatChecksumManifest(entries)), entries);
});

test("parseChecksumManifest ignores blank lines and rejects malformed entries", () => {
  assert.deepEqual(parseChecksumManifest(`\n${HASH_A}  dist/main.js\n\n`), [{ path: "dist/main.js", sha256: HASH_A }]);
  assert.throws(() => parseChecksumManifest("not-a-hash  dist/main.js\n"), /Malformed/);
  assert.throws(() => parseChecksumManifest(`${HASH_A}\n`), /Malformed/);
  assert.throws(() => parseChecksumManifest(`${HASH_A.toUpperCase()}  dist/main.js\n`), /Malformed/);
});

const SAMPLE_PATCH = `diff --git a/dist/core/resource-loader.js b/dist/core/resource-loader.js
--- a/dist/core/resource-loader.js
+++ b/dist/core/resource-loader.js
@@ -11,6 +11,7 @@
 import { loadSkills } from "./skills.js";
+import { resolveActiveSkillPaths } from "./skill-management.js";
 import { createSourceInfo } from "./source-info.js";
-const removed = true;
diff --git a/dist/core/skill-management.js b/dist/core/skill-management.js
new file mode 100644
--- /dev/null
+++ b/dist/core/skill-management.js
@@ -0,0 +1,3 @@
+export function one() {}
+export function two() {}
+export function three() {}
`;

test("patchedFileList reports every touched file and which ones the patch creates", () => {
  assert.deepEqual(patchedFileList(SAMPLE_PATCH), [
    { path: "dist/core/resource-loader.js", added: false },
    { path: "dist/core/skill-management.js", added: true },
  ]);
});

test("patchedFileList returns nothing for an empty diff", () => {
  assert.deepEqual(patchedFileList(""), []);
});

test("countUpstreamEditedLines counts only the paths it is given", () => {
  // One added import and one removed line in resource-loader; the new file is ours and is not budgeted.
  assert.equal(countUpstreamEditedLines(SAMPLE_PATCH, new Set(["dist/core/resource-loader.js"])), 2);
});

test("countUpstreamEditedLines ignores files outside the budget entirely", () => {
  assert.equal(countUpstreamEditedLines(SAMPLE_PATCH, new Set()), 0);
  assert.equal(countUpstreamEditedLines(SAMPLE_PATCH, new Set(["dist/core/skill-management.js"])), 3);
});

test("countUpstreamEditedLines ignores context, headers, and hunk markers", () => {
  const contextOnly = `--- a/dist/main.js
+++ b/dist/main.js
@@ -1,3 +1,3 @@
 unchanged one
 unchanged two
`;
  assert.equal(countUpstreamEditedLines(contextOnly, new Set()), 0);
});

test("diffChecksumManifests reports missing, changed, and unexpected paths", () => {
  const expected = [
    { path: "dist/main.js", sha256: HASH_A },
    { path: "docs/skills.md", sha256: HASH_A },
  ];
  const actual = [
    { path: "dist/main.js", sha256: HASH_B },
    { path: "dist/extra.js", sha256: HASH_A },
  ];
  assert.deepEqual(diffChecksumManifests(expected, actual), [
    "changed: dist/main.js",
    "missing: docs/skills.md",
    "unexpected: dist/extra.js",
  ]);
});

test("diffChecksumManifests reports nothing for identical manifests", () => {
  const entries = [{ path: "dist/main.js", sha256: HASH_A }];
  assert.deepEqual(diffChecksumManifests(entries, [...entries]), []);
});
