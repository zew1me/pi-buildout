#!/usr/bin/env node
/**
 * Regenerates a versioned `/skills` runtime patch from the TypeScript overlay in `pi-overlay/`.
 *
 * The pipeline fetches checksum-verified upstream inputs, proves that building the pinned source reproduces
 * the published npm runtime, applies the overlay, and emits `skills.patch` plus its three checksum manifests
 * in the format `scripts/install-extensions.sh` already consumes.
 *
 * Usage:
 *   node scripts/build-pi-patch.mjs [--version <semver>] [--check] [--work-dir <dir>] [--keep]
 *
 * `--check` regenerates into a scratch directory and fails if the committed artifacts differ, which is how
 * CI detects drift. Without it, the committed artifacts are rewritten in place.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------
// Pure helpers. Exported for scripts/build-pi-patch.test.mjs; no I/O, no network.
// ---------------------------------------------------------------------------

/**
 * Formats checksum entries as `sha256sum` output: 64 lowercase hex, two spaces, POSIX path.
 *
 * Entries are emitted in the caller's order so a manifest can mirror a declared file order, which keeps
 * regeneration byte-stable across runs and platforms.
 *
 * @param {{ path: string; sha256: string }[]} entries
 */
export function formatChecksumManifest(entries) {
  return entries.map(({ sha256, path }) => `${sha256}  ${path}`).join("\n") + "\n";
}

/**
 * Parses a `sha256sum`-style manifest into entries, rejecting malformed lines.
 *
 * @param {string} text
 */
export function parseChecksumManifest(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^([0-9a-f]{64})\s+(\S+)$/.exec(line);
      if (!match) throw new Error(`Malformed checksum manifest entry: ${line}`);
      return { sha256: /** @type {string} */ (match[1]), path: /** @type {string} */ (match[2]) };
    });
}

/**
 * Lists the files a unified diff touches, and whether the diff creates them.
 *
 * Reads the `+++ b/<path>` headers and treats a `--- /dev/null` predecessor as a creation, which is how the
 * installer distinguishes `baseline.absent` paths from files it must checksum beforehand.
 *
 * @param {string} patchText
 */
export function patchedFileList(patchText) {
  const lines = patchText.split("\n");
  /** @type {{ path: string; added: boolean }[]} */
  const files = [];
  for (let index = 0; index < lines.length; index += 1) {
    const target = /^\+\+\+ b\/(.+)$/.exec(lines[index] ?? "");
    if (!target) continue;
    const previous = lines[index - 1] ?? "";
    files.push({ path: /** @type {string} */ (target[1]), added: previous === "--- /dev/null" });
  }
  return files;
}

/**
 * Counts added and removed diff lines, restricted to the paths given.
 *
 * This is the minimal-patch-surface budget, and it deliberately covers only files where upstream code is
 * edited in place. Files the patch creates are ours; documentation and the bundled entrypoints are replaced
 * wholesale rather than surgically edited, so neither belongs in a budget meant to track how much upstream
 * code we reach into.
 *
 * @param {string} patchText
 * @param {Set<string>} countedPaths
 */
export function countUpstreamEditedLines(patchText, countedPaths) {
  let current;
  let total = 0;
  for (const line of patchText.split("\n")) {
    const target = /^\+\+\+ b\/(.+)$/.exec(line);
    if (target) {
      current = target[1];
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@")) continue;
    if (current === undefined || !countedPaths.has(current)) continue;
    if (/^[+-]/.test(line)) total += 1;
  }
  return total;
}

/**
 * Compares two checksum manifests and describes the differences.
 *
 * @param {{ path: string; sha256: string }[]} expected
 * @param {{ path: string; sha256: string }[]} actual
 */
export function diffChecksumManifests(expected, actual) {
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry.sha256]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry.sha256]));
  /** @type {string[]} */
  const problems = [];
  for (const [path, sha256] of expectedByPath) {
    const found = actualByPath.get(path);
    if (found === undefined) problems.push(`missing: ${path}`);
    else if (found !== sha256) problems.push(`changed: ${path}`);
  }
  for (const path of actualByPath.keys()) {
    if (!expectedByPath.has(path)) problems.push(`unexpected: ${path}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Runs a command, streaming output, and returns its exit status instead of throwing.
 *
 * Upstream's root build fails partway through on a generated module that its source archive omits, so the
 * pipeline must inspect artifacts rather than trust an exit code. Callers decide what a failure means.
 */
function run(command, args, options = {}) {
  try {
    execFileSync(command, args, { stdio: "inherit", ...options });
    return 0;
  } catch (error) {
    return typeof error?.status === "number" ? error.status : 1;
  }
}

function runOrThrow(command, args, options = {}) {
  const status = run(command, args, options);
  if (status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${status}`);
}

async function download(url, destination, expectedSha256) {
  if (existsSync(destination) && sha256File(destination) === expectedSha256) {
    console.log(`  cached  ${basename(destination)}`);
    return;
  }
  console.log(`  fetch   ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  const actual = sha256File(destination);
  if (actual !== expectedSha256) {
    throw new Error(`Checksum mismatch for ${url}\n  expected ${expectedSha256}\n  actual   ${actual}`);
  }
}

function extract(archive, destination) {
  mkdirSync(destination, { recursive: true });
  runOrThrow("tar", ["xzf", archive, "-C", destination]);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Cross-checks the source archive against upstream's own published SHA256SUMS. */
async function crossCheckPublishedChecksums(manifest, archivePath) {
  const { checksumsUrl } = manifest.sourceArchive;
  if (!checksumsUrl) return;
  const response = await fetch(checksumsUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Could not fetch upstream SHA256SUMS: HTTP ${response.status}`);
  }
  const name = basename(new URL(manifest.sourceArchive.url).pathname);
  const line = (await response.text()).split("\n").find((entry) => entry.trim().endsWith(name));
  if (!line) throw new Error(`Upstream SHA256SUMS does not list ${name}`);
  const published = line.trim().split(/\s+/)[0];
  const actual = sha256File(archivePath);
  if (published !== actual) {
    throw new Error(`Upstream SHA256SUMS disagrees for ${name}: published ${published}, actual ${actual}`);
  }
  console.log(`  verified against upstream SHA256SUMS: ${name}`);
}

/** Builds the workspace packages `coding-agent` needs, then `coding-agent` itself, unbundled. */
function buildCodingAgent(sourceRoot, manifest) {
  const codingAgent = join(sourceRoot, manifest.packageSubpath);
  for (const workspace of manifest.workspaceBuildOrder) {
    const directory = join(sourceRoot, workspace);
    // Upstream's `packages/ai` build does not emit one generated module that the source archive omits.
    // tsgo still emits usable output, so a non-zero status here is not fatal; the artifact comparison is.
    const status = run("npm", ["run", "build"], { cwd: directory });
    if (status !== 0) console.log(`  note: ${workspace} build exited ${status}; continuing`);
  }
  runOrThrow("npm", ["run", "build:unbundled"], { cwd: codingAgent });
  return codingAgent;
}

/**
 * Proves the pinned source rebuilds the published runtime for every file the patch touches.
 *
 * If this fails the generated patch would carry toolchain noise, so generation stops rather than emitting it.
 */
function assertBuildReproducesBaseline(builtRoot, baselineRoot, manifest) {
  const problems = [];
  for (const entry of manifest.trackedFiles) {
    if (entry.source !== "built" || entry.added) continue;
    const built = join(builtRoot, entry.path);
    const baseline = join(baselineRoot, entry.path);
    if (!existsSync(built)) problems.push(`not built: ${entry.path}`);
    else if (sha256File(built) !== sha256File(baseline)) problems.push(`differs from npm: ${entry.path}`);
  }
  if (problems.length > 0) {
    throw new Error(
      "Building the pinned source did not reproduce the published runtime:\n" +
        problems.map((problem) => `  ${problem}`).join("\n") +
        "\nRefusing to emit a patch derived from a build that disagrees with the published package.",
    );
  }
  const checked = manifest.trackedFiles.filter((entry) => entry.source === "built" && !entry.added).length;
  console.log(`  clean build reproduces npm for all ${checked} pre-existing built files`);
}

/** Assembles the patched package tree: baseline, overwritten by built, documented and replacement files. */
async function assemblePatchedTree(target, baselineRoot, builtRoot, patchedSourceRoot, overlayDir, manifest) {
  await cp(baselineRoot, target, { recursive: true });
  for (const entry of manifest.trackedFiles) {
    const destination = join(target, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    if (entry.source === "built") await cp(join(builtRoot, entry.path), destination);
    else if (entry.source === "patched-source") await cp(join(patchedSourceRoot, entry.path), destination);
    else if (entry.source === "replacement") await cp(join(overlayDir, "replacements", entry.path), destination);
    else throw new Error(`Unknown tracked file source: ${String(entry.source)}`);
  }
}

/**
 * Produces the unified diff in the shape the installer expects.
 *
 * `git diff --no-index` would prefix paths with the compared directory names and break `patch --strip=1`, so
 * the baseline is committed in a throwaway repository at package-relative paths and the patched tree is
 * diffed against it.
 */
export function buildUnifiedDiff(workDir, baselineRoot, patchedRoot, manifest) {
  const repo = join(workDir, "diff-repo");
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  const git = (...args) => runOrThrow("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.email", "patch-build@example.invalid");
  git("config", "user.name", "patch build");

  const tracked = manifest.trackedFiles.map((entry) => entry.path);
  for (const path of tracked) {
    const from = join(baselineRoot, path);
    if (!existsSync(from)) continue;
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    execFileSync("cp", [from, join(repo, path)]);
  }
  git("add", "--all");
  git("commit", "--quiet", "--message", "baseline");

  for (const path of tracked) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    execFileSync("cp", [join(patchedRoot, path), join(repo, path)]);
  }
  git("add", "--all");

  return execFileSync("git", ["diff", "--cached", "--no-color", "--binary"], {
    cwd: repo,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Applies the generated patch to a fresh baseline copy and confirms it reproduces `patched.sha256`. */
function assertPatchApplies(workDir, baselineRoot, patchText, patchedManifest) {
  const stage = join(workDir, "apply-check");
  rmSync(stage, { recursive: true, force: true });
  execFileSync("cp", ["-R", baselineRoot, stage]);
  const patchFile = join(workDir, "apply-check.patch");
  writeFileSync(patchFile, patchText);
  runOrThrow("sh", ["-c", `patch --batch --forward --strip=1 --directory="${stage}" < "${patchFile}"`], {
    stdio: "ignore",
  });
  const problems = parseChecksumManifest(patchedManifest)
    .filter((entry) => sha256File(join(stage, entry.path)) !== entry.sha256)
    .map((entry) => entry.path);
  if (problems.length > 0) {
    throw new Error(`Applying the generated patch did not reproduce: ${problems.join(", ")}`);
  }
  console.log("  generated patch applies to a clean baseline and matches patched.sha256");
}

/**
 * Round-trips every recognized upgrade state against the freshly generated patched tree.
 *
 * Reverse-applying a migration must reconstruct exactly the state it claims to come from, so this catches an
 * upgrade patch left behind by a regeneration without needing the original package anywhere.
 *
 * Each state must also describe every path the installer will ask it about. The installer iterates
 * `patched.sha256` and hard-exits when a state manifest has neither a checksum nor an absent entry for a
 * path, so an incomplete state artifact breaks installation for everyone, not only for upgraders.
 */
function assertUpgradeStatesRoundTrip(workDir, patchedRoot, outputDir) {
  const installerPaths = parseChecksumManifest(readFileSync(join(outputDir, "patched.sha256"), "utf-8")).map(
    (entry) => entry.path,
  );
  const states = readdirSync(outputDir)
    .filter((name) => name.endsWith("-patched.sha256"))
    .map((name) => name.slice(0, -"-patched.sha256".length));
  if (states.length === 0) return;

  for (const state of states) {
    const upgradePatch = join(outputDir, `${state}-upgrade.patch`);
    if (!existsSync(upgradePatch)) throw new Error(`Upgrade state ${state} has no upgrade patch.`);

    const stage = join(workDir, `upgrade-check-${state}`);
    rmSync(stage, { recursive: true, force: true });
    execFileSync("cp", ["-R", patchedRoot, stage]);
    const reverted = run("sh", ["-c", `patch --batch --reverse --strip=1 --directory="${stage}" < "${upgradePatch}"`], {
      stdio: "ignore",
    });
    if (reverted !== 0) {
      throw new Error(
        `Upgrade state ${state} no longer applies to the generated patch; regenerate it:\n` +
          `  node scripts/build-pi-upgrade.mjs --version <version> --label ${state} --from <old tree> --patched ${patchedRoot}`,
      );
    }

    const problems = parseChecksumManifest(readFileSync(join(outputDir, `${state}-patched.sha256`), "utf-8"))
      .filter((entry) => !existsSync(join(stage, entry.path)) || sha256File(join(stage, entry.path)) !== entry.sha256)
      .map((entry) => entry.path);

    const absentFile = join(outputDir, `${state}-absent`);
    const absentPaths = existsSync(absentFile)
      ? readFileSync(absentFile, "utf-8")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
    for (const path of absentPaths) {
      if (existsSync(join(stage, path))) problems.push(`${path} should be absent`);
    }

    const described = new Set([
      ...parseChecksumManifest(readFileSync(join(outputDir, `${state}-patched.sha256`), "utf-8")).map(
        (entry) => entry.path,
      ),
      ...absentPaths,
    ]);
    for (const path of installerPaths) {
      if (!described.has(path)) problems.push(`${path} is in neither ${state}-patched.sha256 nor ${state}-absent`);
    }
    if (problems.length > 0) {
      throw new Error(
        `Upgrade state ${state} does not round-trip: ${problems.join(", ")}\n` +
          `Regenerate it against the tree this run produced:\n` +
          `  node scripts/build-pi-upgrade.mjs --version <version> --label ${state} --from <old tree> --patched ${patchedRoot}`,
      );
    }
    console.log(`  upgrade state ${state} round-trips`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const keep = argv.includes("--keep");
  const versionFlag = argv.indexOf("--version");
  const workDirFlag = argv.indexOf("--work-dir");

  const version =
    versionFlag === -1
      ? JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf-8")).devDependencies[
          "@earendil-works/pi-coding-agent"
        ]
      : argv[versionFlag + 1];
  if (!version) throw new Error("Could not determine which pi version to build.");

  const overlayDir = join(repositoryRoot, "pi-overlay", "versions", version);
  const manifestPath = join(overlayDir, "upstream.json");
  if (!existsSync(manifestPath)) throw new Error(`No overlay for pi ${version} at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

  const workDir =
    workDirFlag === -1
      ? mkdtempSync(join(tmpdir(), `pi-patch-${version}-`))
      : resolve(process.cwd(), argv[workDirFlag + 1]);
  mkdirSync(workDir, { recursive: true });
  console.log(`pi ${version}\nwork directory: ${workDir}\n`);

  try {
    console.log("1/7 fetching pinned inputs");
    const cache = join(workDir, "cache");
    const sourceArchive = join(cache, basename(new URL(manifest.sourceArchive.url).pathname));
    const npmArchive = join(cache, `pi-coding-agent-${version}.tgz`);
    await download(manifest.sourceArchive.url, sourceArchive, manifest.sourceArchive.sha256);
    await download(manifest.npmTarball.url, npmArchive, manifest.npmTarball.sha256);
    await crossCheckPublishedChecksums(manifest, sourceArchive);

    console.log("\n2/7 extracting");
    const sourceDir = join(workDir, "source");
    const baselineDir = join(workDir, "baseline");
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(baselineDir, { recursive: true, force: true });
    extract(sourceArchive, sourceDir);
    extract(npmArchive, baselineDir);
    const sourceRoot = join(sourceDir, manifest.sourceArchive.rootDirectory);
    const baselineRoot = join(baselineDir, manifest.npmTarball.rootDirectory);

    console.log("\n3/7 installing upstream dependencies");
    runOrThrow("npm", ["ci", "--ignore-scripts"], { cwd: sourceRoot });

    console.log("\n4/7 building the unmodified pinned source");
    const codingAgent = buildCodingAgent(sourceRoot, manifest);
    assertBuildReproducesBaseline(join(codingAgent, "dist"), join(baselineRoot, "dist"), {
      ...manifest,
      trackedFiles: manifest.trackedFiles.map((entry) => ({
        ...entry,
        path: entry.path.replace(/^dist\//, ""),
      })),
    });

    console.log("\n5/7 applying the overlay and rebuilding");
    const overlayRoot = join(repositoryRoot, "pi-overlay");
    for (const file of ["skill-management-core.ts", "skill-management.ts"]) {
      await cp(join(overlayRoot, file), join(codingAgent, "src", "core", file));
    }
    runOrThrow("sh", [
      "-c",
      `patch --batch --forward --strip=1 --directory="${codingAgent}" < "${join(overlayDir, "integration.patch")}"`,
    ]);
    runOrThrow("npm", ["run", "build:unbundled"], { cwd: codingAgent });

    console.log("\n6/7 assembling and diffing");
    const patchedRoot = join(workDir, "patched");
    rmSync(patchedRoot, { recursive: true, force: true });
    await assemblePatchedTree(patchedRoot, baselineRoot, codingAgent, codingAgent, overlayDir, manifest);
    const patchText = buildUnifiedDiff(workDir, baselineRoot, patchedRoot, manifest);

    const addedPaths = new Set(manifest.trackedFiles.filter((e) => e.added).map((e) => e.path));
    const files = patchedFileList(patchText);
    const expectedPaths = new Set(manifest.trackedFiles.map((entry) => entry.path));
    const unexpected = files.filter((file) => !expectedPaths.has(file.path)).map((file) => file.path);
    if (unexpected.length > 0) throw new Error(`Patch touches untracked paths: ${unexpected.join(", ")}`);
    for (const file of files) {
      if (file.added !== addedPaths.has(file.path)) {
        throw new Error(`Patch creates/modifies ${file.path} against its declared tracked-file source.`);
      }
    }

    const budgetedPaths = new Set(
      manifest.trackedFiles.filter((e) => e.source === "built" && !e.added).map((e) => e.path),
    );
    const edited = countUpstreamEditedLines(patchText, budgetedPaths);
    console.log(`  upstream-edited lines: ${edited} (budget ${manifest.maxUpstreamEditedLines})`);
    if (edited > manifest.maxUpstreamEditedLines) {
      throw new Error(
        `Patch edits ${edited} lines of pre-existing upstream files, over the ${manifest.maxUpstreamEditedLines}-line budget.`,
      );
    }

    const baselineEntries = manifest.trackedFiles
      .filter((entry) => !entry.added)
      .map((entry) => ({ path: entry.path, sha256: sha256File(join(baselineRoot, entry.path)) }));
    const patchedEntries = manifest.trackedFiles.map((entry) => ({
      path: entry.path,
      sha256: sha256File(join(patchedRoot, entry.path)),
    }));
    const artifacts = {
      "skills.patch": patchText,
      "baseline.sha256": formatChecksumManifest(baselineEntries),
      "baseline.absent": [...addedPaths].map((path) => posix.normalize(path)).join("\n") + "\n",
      "patched.sha256": formatChecksumManifest(patchedEntries),
    };

    console.log("\n7/7 verifying");
    assertPatchApplies(workDir, baselineRoot, patchText, artifacts["patched.sha256"]);

    const outputDir = join(repositoryRoot, "patches", `pi-${version}`);
    if (check) {
      const drift = Object.entries(artifacts).filter(
        ([name, contents]) => readFileSync(join(outputDir, name), "utf-8") !== contents,
      );
      if (drift.length > 0) {
        throw new Error(`Committed artifacts are stale: ${drift.map(([name]) => name).join(", ")}`);
      }
      console.log("\nNo drift: committed artifacts match regeneration.");
    } else {
      mkdirSync(outputDir, { recursive: true });
      for (const [name, contents] of Object.entries(artifacts)) {
        writeFileSync(join(outputDir, name), contents);
      }
      console.log(`\nWrote ${Object.keys(artifacts).length} artifacts to ${relative(repositoryRoot, outputDir)}`);
    }

    // Last, because a rebuild invalidates every migration and they are regenerated from the tree this run
    // just produced. Checking earlier would block the write that regenerating them depends on.
    assertUpgradeStatesRoundTrip(workDir, patchedRoot, outputDir);
  } finally {
    if (!keep && workDirFlag === -1) rmSync(workDir, { recursive: true, force: true });
    else console.log(`\nKept work directory: ${workDir}`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
