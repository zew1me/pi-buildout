import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  applyPatchFile,
  applyPatchText,
  assertPatchApplies,
  assertUpgradeStatesRoundTrip,
  buildUnifiedDiff,
  countUpstreamEditedLines,
  diffChecksumManifests,
  formatChecksumManifest,
  parseChecksumManifest,
  patchedFileList,
  sha256File,
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

function patchFixture(t, name = "ordinary") {
  const root = mkdtempSync(join(tmpdir(), "pi-shell-safe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, "shell-executed");
  const workDir = join(root, name.replaceAll("MARKER", marker));
  const baseline = join(workDir, "baseline");
  const patched = join(workDir, "patched");
  const output = join(workDir, "output");
  for (const directory of [baseline, patched, output]) mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(join(baseline, "dist/example.js"), "before\n");
  writeFileSync(join(patched, "dist/example.js"), "after\n");
  // Patch contents must also remain literal, including quotes, variables and shell substitution.
  const addedText = "'$HOME' \"${PATH}\" $(printf shell-substitution)\n";
  writeFileSync(join(patched, "dist/added.js"), addedText);
  const trackedFiles = [{ path: "dist/example.js" }, { path: "dist/added.js", added: true }];
  const patchText = buildUnifiedDiff(workDir, baseline, patched, { trackedFiles });
  const patchFile = join(output, "migration ' \" $HOME.patch");
  writeFileSync(patchFile, patchText);
  const patchedManifest = formatChecksumManifest(
    trackedFiles.map(({ path }) => ({ path, sha256: sha256File(join(patched, path)) })),
  );
  writeFileSync(join(output, "patched.sha256"), patchedManifest);
  writeFileSync(join(output, "previous-upgrade.patch"), patchText);
  writeFileSync(
    join(output, "previous-patched.sha256"),
    formatChecksumManifest([{ path: "dist/example.js", sha256: sha256File(join(baseline, "dist/example.js")) }]),
  );
  writeFileSync(join(output, "previous-absent"), "dist/added.js\n");
  return { marker, workDir, baseline, patched, output, patchText, patchFile, patchedManifest, addedText };
}

test("patch generation and forward/reverse verification treat hostile paths literally", async (t) => {
  const normal = patchFixture(t);
  for (const name of [
    "path with spaces",
    "single ' and double \" quotes",
    "$HOME ${PATH} dollars",
    "$(touch${IFS}MARKER)",
    "`touch${IFS}MARKER`",
    '"; touch MARKER; #',
  ]) {
    await t.test(name, (t) => {
      const fixture = patchFixture(t, name);
      const { marker, workDir, baseline, patched, output, patchText, patchFile, patchedManifest, addedText } = fixture;
      assert.equal(patchText, normal.patchText);
      const stage = join(workDir, "direct ' \" $HOME target");
      cpSync(baseline, stage, { recursive: true });
      assert.equal(applyPatchFile(patchFile, stage), 0);
      assert.equal(readFileSync(join(stage, "dist/example.js"), "utf-8"), "after\n");
      assert.equal(readFileSync(join(stage, "dist/added.js"), "utf-8"), addedText);
      assert.equal(applyPatchText(patchText, stage, { reverse: true }), 0);
      assert.equal(readFileSync(join(stage, "dist/example.js"), "utf-8"), "before\n");
      assert.equal(existsSync(join(stage, "dist/added.js")), false);
      assertPatchApplies(workDir, baseline, patchText, patchedManifest);
      assertUpgradeStatesRoundTrip(workDir, patched, output);
      assert.equal(existsSync(marker), false, "path or patch contents executed a shell command");
    });
  }
});

test("patch helpers pipe stdin while inheriting output for overlay integration", (t) => {
  const { patchText, patchFile, baseline } = patchFixture(t);
  assert.equal(applyPatchText(patchText, baseline, { stdio: "inherit" }), 0);
  assert.equal(applyPatchFile(patchFile, baseline, { reverse: true, stdio: "inherit" }), 0);
  assert.equal(readFileSync(join(baseline, "dist/example.js"), "utf-8"), "before\n");
});

test("forward patch failures propagate from helpers and abort baseline verification", (t) => {
  const { workDir, baseline, patchText, patchFile, patchedManifest } = patchFixture(t);
  writeFileSync(join(baseline, "dist/example.js"), "incompatible baseline\n");
  assert.notEqual(applyPatchText(patchText, baseline), 0);
  assert.notEqual(applyPatchFile(patchFile, baseline), 0);
  assert.throws(
    () => assertPatchApplies(workDir, baseline, patchText, patchedManifest),
    /patch failed with status [1-9]/,
  );
  assert.notEqual(applyPatchText("not a patch\n", baseline), 0);
});

test("reverse patch failures propagate and abort upgrade verification with regeneration guidance", (t) => {
  const { workDir, patched, output, patchText, patchFile } = patchFixture(t);
  writeFileSync(join(patched, "dist/example.js"), "incompatible patched tree\n");
  assert.notEqual(applyPatchText(patchText, patched, { reverse: true }), 0);
  assert.notEqual(applyPatchFile(patchFile, patched, { reverse: true }), 0);
  assert.throws(
    () => assertUpgradeStatesRoundTrip(workDir, patched, output),
    /Upgrade state previous no longer applies.*regenerate it:/s,
  );
  assert.notEqual(applyPatchText("not a patch\n", patched, { reverse: true }), 0);
});

test("patch helpers fail closed for missing input files or target directories", (t) => {
  const { workDir, patchText, baseline } = patchFixture(t);
  assert.throws(() => applyPatchFile(join(workDir, "missing.patch"), baseline), { code: "ENOENT" });
  assert.notEqual(applyPatchText(patchText, join(workDir, "missing directory")), 0);
});
