import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  countUpstreamEditedLines,
  diffChecksumManifests,
  formatChecksumManifest,
  parseChecksumManifest,
  patchedFileList,
  sortVersions,
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

test("sortVersions orders dotted versions numerically rather than lexically", () => {
  assert.deepEqual(sortVersions(["0.87.1", "0.85.1", "0.100.0", "0.9.0"]), ["0.9.0", "0.85.1", "0.87.1", "0.100.0"]);
  assert.deepEqual(sortVersions([]), []);
});

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const versionsRoot = join(repositoryRoot, "pi-overlay", "versions");
const overlayVersions = readdirSync(versionsRoot).filter((name) =>
  existsSync(join(versionsRoot, name, "upstream.json")),
);

/** The post-image of one file in a unified diff: its context and added lines. */
function patchedSection(patchText, path) {
  const marker = `diff --git a/${path} b/${path}`;
  const start = patchText.indexOf(marker);
  assert.notEqual(start, -1, `patch does not touch ${path}`);
  const next = patchText.indexOf("\ndiff --git ", start + marker.length);
  const lines = patchText.slice(start, next === -1 ? undefined : next).split("\n");
  const body = lines.slice(lines.findIndex((line) => line.startsWith("@@")));
  return body
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" "))
    .map((line) => line.slice(1))
    .join("\n")
    .concat("\n");
}

// Offline counterpart to `npm run patches:check`: it cannot prove the build reproduces, but it catches an
// overlay declaration that disagrees with the artifacts committed for it, for every supported version.
for (const version of overlayVersions) {
  test(`pi ${version} committed artifacts agree with the overlay declaration`, () => {
    const manifest = JSON.parse(readFileSync(join(versionsRoot, version, "upstream.json"), "utf8"));
    const patchDirectory = join(repositoryRoot, "patches", `pi-${version}`);
    const patchText = readFileSync(join(patchDirectory, "skills.patch"), "utf8");
    assert.equal(manifest.version, version);

    // `unchanged` entries are pinned by both manifests but never appear in the patch itself.
    const declared = manifest.trackedFiles
      .filter((entry) => entry.source !== "unchanged")
      .map((entry) => ({ path: entry.path, added: entry.added === true }));
    const byPath = (left, right) => left.path.localeCompare(right.path);
    assert.deepEqual(patchedFileList(patchText).sort(byPath), [...declared].sort(byPath));
    assert.deepEqual(
      parseChecksumManifest(readFileSync(join(patchDirectory, "patched.sha256"), "utf8")).map((entry) => entry.path),
      manifest.trackedFiles.map((entry) => entry.path),
    );

    const baselineByPath = new Map(
      parseChecksumManifest(readFileSync(join(patchDirectory, "baseline.sha256"), "utf8")).map((entry) => [
        entry.path,
        entry.sha256,
      ]),
    );
    const patchedByPath = new Map(
      parseChecksumManifest(readFileSync(join(patchDirectory, "patched.sha256"), "utf8")).map((entry) => [
        entry.path,
        entry.sha256,
      ]),
    );
    for (const entry of manifest.trackedFiles.filter((file) => file.source === "unchanged")) {
      assert.match(baselineByPath.get(entry.path) ?? "", /^[0-9a-f]{64}$/u, `${entry.path} is pinned by the baseline`);
      assert.equal(patchedByPath.get(entry.path), baselineByPath.get(entry.path), `${entry.path} stays unchanged`);
    }

    for (const entry of manifest.trackedFiles.filter((file) => file.source === "replacement")) {
      const replacement = readFileSync(join(versionsRoot, version, "replacements", entry.path), "utf8");
      assert.equal(patchedSection(patchText, entry.path), replacement, `${entry.path} is delivered verbatim`);
    }

    const budgeted = new Set(
      manifest.trackedFiles.filter((entry) => entry.source === "built" && !entry.added).map((entry) => entry.path),
    );
    assert.equal(
      countUpstreamEditedLines(patchText, budgeted),
      manifest.maxUpstreamEditedLines,
      "maxUpstreamEditedLines must equal the measured count, so the budget never silently loosens",
    );
  });
}
