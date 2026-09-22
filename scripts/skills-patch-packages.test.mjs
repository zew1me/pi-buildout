/**
 * Guards how {@link findCleanPackage} separates two kinds of failure.
 *
 * A candidate package that cannot be inspected is that candidate's problem: the search must continue so a
 * later candidate can still satisfy the test. A missing or unreadable baseline manifest is a repository
 * artifact problem, and must surface as a failure rather than a skipped test that looks like a pass.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { findCleanPackage, patchVersions, readBaselineManifest } from "./skills-patch-packages.mjs";

/** A directory that looks like a package but whose `package.json` cannot be parsed. */
async function malformedCandidate() {
  const root = await mkdtemp(join(tmpdir(), "pi-skills-bad-package-"));
  await writeFile(join(root, "package.json"), "{ not json");
  return root;
}

async function withTestPackages(value, run) {
  const previous = process.env.PI_SKILLS_TEST_PACKAGES;
  process.env.PI_SKILLS_TEST_PACKAGES = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.PI_SKILLS_TEST_PACKAGES;
    else process.env.PI_SKILLS_TEST_PACKAGES = previous;
  }
}

describe("findCleanPackage", () => {
  it("keeps searching past a candidate it cannot inspect", async () => {
    const candidate = await malformedCandidate();
    const version = patchVersions()[0];
    assert.ok(version, "the repository must ship at least one patch version");

    const { packageRoot, problem } = await withTestPackages(candidate, () =>
      findCleanPackage(version, { requireDependencies: false }),
    );

    // Either outcome proves the search continued: a later candidate was reached, or its problem was collected.
    if (packageRoot === undefined) {
      assert.match(problem, /could not be inspected/u);
      assert.ok(problem.includes("node_modules"), `the repository candidate should still be reported, got: ${problem}`);
    } else {
      assert.ok(!packageRoot.startsWith(candidate), "the malformed candidate must not be selected");
    }
  });

  it("fails instead of skipping when a baseline manifest is unreadable", async () => {
    // No `patches/pi-0.0.0-missing/` exists, standing in for a manifest that is absent or unreadable.
    await assert.rejects(() => readBaselineManifest("0.0.0-missing"), { code: "ENOENT" });
    await assert.rejects(() => findCleanPackage("0.0.0-missing"), { code: "ENOENT" });
  });
});
