#!/usr/bin/env node
// Assign ephemeral, monotonically numbered alpha versions to packages whose inputs changed.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PACKAGE_KINDS, parseVersion } from "./release-packages.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function affectedPackages(paths) {
  const shared = new Set(["LICENSE", "ATTRIBUTION.md", "scripts/stage-release-package.mjs"]);
  if (paths.some((path) => shared.has(path))) return [...PACKAGE_KINDS];
  return PACKAGE_KINDS.filter((kind) =>
    paths.some(
      (path) =>
        path.startsWith(`packages/pi-${kind}/`) ||
        (kind === "skills-patch"
          ? path.startsWith("patches/") || path === "scripts/install-extensions.sh"
          : path.startsWith(`extensions/${kind}/`) && path.endsWith(".ts") && !path.includes(".test.")),
    ),
  );
}

export function prepare(base, runNumber, root = ROOT) {
  if (!base || /^0+$/.test(base)) throw new Error("A nonzero base commit is required");
  if (!/^[1-9]\d*$/.test(runNumber ?? "")) throw new Error("A positive numeric workflow run number is required");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const git = (args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const commit = git(["rev-parse", "--verify", `${base}^{commit}`]);
  git(["merge-base", "--is-ancestor", commit, "HEAD"]);
  const paths = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", commit, "HEAD"], {
    cwd: root,
    env,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const kinds = affectedPackages(paths);
  const updates = kinds.map((kind) => {
    const path = join(root, "packages", `pi-${kind}`, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const { core, channel, number } = parseVersion(manifest.version);
    // A stable template advances to the next patch; an alpha template retains its core.
    if (channel === "latest") core[2] += 1n;
    else if (channel !== "alpha" || number !== 0n)
      throw new Error(`Automatic releases require a stable or alpha.0 template: ${path}`);
    manifest.version = `${core.join(".")}-alpha.${runNumber}`;
    return { path, manifest };
  });
  for (const { path, manifest } of updates) {
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Prepared ${manifest.name}@${manifest.version}`);
  }
  return kinds;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    prepare(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(`prepare-auto-release: ${error.message}`);
    process.exitCode = 1;
  }
}
