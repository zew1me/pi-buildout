/**
 * Locates clean pi packages for the version-specific `/skills` patch tests.
 *
 * The repository's development dependency pins one pi version (see `package.json`), but the patch tests run
 * for every version with an overlay. A test for another version needs an unpatched package of exactly that
 * version, supplied through `PI_SKILLS_TEST_PACKAGES`: a list of package directories separated by the
 * platform path delimiter (`:` on POSIX). Each directory must contain pi's `package.json`, `dist/`, `docs/`,
 * and a resolvable `node_modules/` (a symlink is fine). Tests only read these directories; they copy what
 * they patch into temporary trees.
 *
 * A version with no matching clean package is skipped with the reason, never silently passed.
 */

import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sortVersions } from "./build-pi-patch.mjs";

export const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/** Every version that has both an authored overlay and committed patch artifacts. */
export function patchVersions() {
  const versionsRoot = join(repositoryRoot, "pi-overlay", "versions");
  return sortVersions(
    readdirSync(versionsRoot).filter(
      (version) =>
        existsSync(join(versionsRoot, version, "upstream.json")) &&
        existsSync(join(repositoryRoot, "patches", `pi-${version}`, "skills.patch")),
    ),
  );
}

export function patchDirectoryFor(version) {
  return join(repositoryRoot, "patches", `pi-${version}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function candidatePackageRoots() {
  const configured = (process.env.PI_SKILLS_TEST_PACKAGES ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
  return [...configured, join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent")];
}

/**
 * Reads the committed baseline manifests that describe a clean `version` package.
 *
 * These are repository artifacts, not candidate state, so a missing or unreadable manifest is a broken
 * checkout rather than a rejected candidate. Reading them here, outside the per-candidate error handling in
 * {@link findCleanPackage}, keeps that failure loud instead of turning it into a skipped test.
 */
export async function readBaselineManifest(version) {
  const patchDirectory = patchDirectoryFor(version);
  const baseline = await readFile(join(patchDirectory, "baseline.sha256"), "utf8");
  const absent = await readFile(join(patchDirectory, "baseline.absent"), "utf8");
  return {
    present: baseline
      .trim()
      .split("\n")
      .map((line) => {
        const [expected, relativePath] = line.trim().split(/\s+/u, 2);
        return { expected, relativePath };
      }),
    absent: absent
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

/** Explains why `packageRoot` is not a clean package for `version`, or returns undefined when it is. */
async function cleanPackageProblem(packageRoot, version, requireDependencies, manifest) {
  const packageJsonPath = join(packageRoot, "package.json");
  if (!(await exists(packageJsonPath))) return `${packageRoot} has no package.json`;
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.version !== version) return `${packageRoot} is pi ${String(packageJson.version)}`;
  if (requireDependencies && !(await exists(join(packageRoot, "node_modules"))))
    return `${packageRoot} has no node_modules`;

  for (const { expected, relativePath } of manifest.present) {
    const path = relativePath ? join(packageRoot, relativePath) : undefined;
    if (!expected || !path || !(await exists(path)) || (await sha256(path)) !== expected) {
      return `${packageRoot} does not match the ${version} baseline at ${relativePath ?? "an unknown path"}`;
    }
  }
  for (const relativePath of manifest.absent) {
    if (await exists(join(packageRoot, relativePath))) {
      return `${packageRoot} does not match the ${version} baseline at ${relativePath}`;
    }
  }
  return undefined;
}

/**
 * Finds a clean package for `version`, by default one whose dependencies are installed so it can run.
 *
 * @param {string} version
 * @param {{ requireDependencies?: boolean }} [options]
 * @returns {Promise<{ packageRoot: string; problem?: undefined } | { packageRoot?: undefined; problem: string }>}
 */
export async function findCleanPackage(version, { requireDependencies = true } = {}) {
  const problems = [];
  const manifest = await readBaselineManifest(version);
  for (const packageRoot of candidatePackageRoots()) {
    let problem;
    try {
      problem = await cleanPackageProblem(packageRoot, version, requireDependencies, manifest);
    } catch (error) {
      // An unreadable or malformed candidate is a diagnostic for that candidate, not a reason to stop looking.
      problem = `${packageRoot} could not be inspected: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (problem === undefined) return { packageRoot };
    problems.push(problem);
  }
  return {
    problem:
      `no clean pi ${version} package is available (${problems.join("; ")}); ` +
      "set PI_SKILLS_TEST_PACKAGES to provide one",
  };
}
