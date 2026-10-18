#!/usr/bin/env node
// Build without credentials; publish only the same verified archives after the quality gate.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const REGISTRY = "https://registry.npmjs.org/";
export const PACKAGE_KINDS = ["clear", "effort", "markdown-backlinks", "subagents", "skills-patch"];
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Deliberately support stable versions and the three documented numeric prerelease channels.
export function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.exec(version);
  if (!match) throw new Error(`Unsupported release version: ${version}. Use X.Y.Z or X.Y.Z-{alpha,beta,rc}.N`);
  return { core: match.slice(1, 4).map(BigInt), channel: match[4] ?? "latest", number: BigInt(match[5] ?? 0) };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (a.channel !== b.channel) {
    const channels = ["alpha", "beta", "rc", "latest"];
    return channels.indexOf(a.channel) > channels.indexOf(b.channel) ? 1 : -1;
  }
  return a.number === b.number ? 0 : a.number > b.number ? 1 : -1;
}

function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function readPackages(root = ROOT) {
  return PACKAGE_KINDS.map((kind) => {
    const directory = `packages/pi-${kind}`;
    const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
    if (
      manifest.name !== `@zew1me/pi-${kind}` ||
      manifest.private === true ||
      manifest.publishConfig?.registry !== REGISTRY ||
      manifest.publishConfig?.access !== "public"
    ) {
      throw new Error(`Invalid public release manifest: ${directory}`);
    }
    const { channel: tag } = parseVersion(manifest.version);
    return { name: manifest.name, version: manifest.version, directory, tag };
  });
}

export function planReleases(base, root = ROOT) {
  if (!base || /^0+$/.test(base))
    throw new Error("A nonzero pre-push base commit is required; refusing an ambiguous release");
  const commit = git(root, ["rev-parse", "--verify", `${base}^{commit}`]);
  git(root, ["merge-base", "--is-ancestor", commit, "HEAD"]);
  return readPackages(root).filter((entry) => {
    const path = `${entry.directory}/package.json`;
    if (!git(root, ["ls-tree", "--name-only", commit, "--", path])) return true;
    const previous = JSON.parse(git(root, ["show", `${commit}:${path}`]));
    if (previous.name !== entry.name) throw new Error(`Package renames require a separate migration: ${path}`);
    const comparison = compareVersions(entry.version, previous.version);
    if (comparison < 0) throw new Error(`Version decreased for ${entry.name}: ${previous.version} -> ${entry.version}`);
    return comparison > 0;
  });
}

function integrity(path) {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

function filename(entry) {
  return `${entry.name.slice(1).replace("/", "-")}-${entry.version}.tgz`;
}

export function packPackages(output, root = ROOT, run = execFileSync) {
  mkdirSync(output, { recursive: true });
  const archives = readPackages(root).map((entry) => {
    const result = JSON.parse(
      run("npm", ["pack", "--json", "--pack-destination", resolve(output)], {
        cwd: join(root, entry.directory),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }),
    );
    const archive = result[0];
    if (
      result.length !== 1 ||
      archive.name !== entry.name ||
      archive.version !== entry.version ||
      archive.filename !== filename(entry) ||
      archive.integrity !== integrity(join(output, archive.filename))
    ) {
      throw new Error(`Unexpected npm pack result for ${entry.name}`);
    }
    console.log(`Packed ${entry.name}@${entry.version}: ${archive.filename}`);
    return { ...entry, filename: archive.filename, integrity: archive.integrity };
  });
  writeFileSync(join(output, "release-assets.json"), `${JSON.stringify({ archives }, null, 2)}\n`);
  return archives;
}

async function registryVersion(entry, specifier) {
  const response = await fetch(`${REGISTRY}${encodeURIComponent(entry.name)}/${encodeURIComponent(specifier)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry lookup failed for ${entry.name}: HTTP ${response.status}`);
  const result = await response.json();
  if (
    result.name !== entry.name ||
    typeof result.version !== "string" ||
    (specifier === entry.version && result.version !== entry.version) ||
    typeof result.dist?.integrity !== "string" ||
    result.dist.integrity.length === 0
  ) {
    throw new Error(`Invalid registry metadata for ${entry.name}@${specifier}`);
  }
  parseVersion(result.version);
  return result;
}

export async function publishedVersion(entry) {
  return registryVersion(entry, entry.version);
}

export async function taggedVersion(entry) {
  return registryVersion(entry, entry.tag);
}

export async function publishPackages(
  entries,
  output,
  { lookup = publishedVersion, lookupTag = taggedVersion, run = execFileSync, report = console.log } = {},
) {
  if (!entries.length) {
    report("No package version increases; nothing to publish.");
    return;
  }
  const { archives } = JSON.parse(readFileSync(join(output, "release-assets.json"), "utf8"));
  const pending = [];
  // Complete all validation and registry lookups before the first write.
  for (const entry of entries) {
    const archive = archives.find((item) => item.name === entry.name && item.version === entry.version);
    if (
      !archive ||
      archive.filename !== filename(entry) ||
      archive.integrity !== integrity(join(output, archive.filename))
    ) {
      throw new Error(`Missing or modified archive for ${entry.name}@${entry.version}`);
    }
    const published = await lookup(entry);
    if (published && published.dist.integrity !== archive.integrity) {
      throw new Error(`Already published with different contents: ${entry.name}@${entry.version}; bump the version`);
    }
    if (!published) {
      const tagged = await lookupTag(entry);
      if (tagged && compareVersions(entry.version, tagged.version) < 0) {
        throw new Error(
          `Refusing to move ${entry.name}'s ${entry.tag} tag backward: ${tagged.version} -> ${entry.version}`,
        );
      }
    }
    pending.push({ entry, archive, published });
  }
  for (const { entry, archive, published } of pending) {
    if (published) {
      report(`Already published (identical): ${entry.name}@${entry.version}`);
      continue;
    }
    run(
      "npm",
      [
        "publish",
        resolve(output, archive.filename),
        "--registry",
        REGISTRY,
        "--access",
        "public",
        "--tag",
        entry.tag,
        "--provenance",
        "--ignore-scripts",
      ],
      {
        stdio: "inherit",
      },
    );
    report(`Published ${entry.name}@${entry.version} (tag: ${entry.tag})`);
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { base: { type: "string" }, artifacts: { type: "string", default: "release-artifacts" } },
  });
  const [command, ...extra] = positionals;
  if (extra.length || !["pack", "plan", "publish"].includes(command)) {
    throw new Error("Usage: npm run release:packages -- pack|plan|publish [--base REF] [--artifacts DIR]");
  }
  if (command === "pack") {
    packPackages(resolve(values.artifacts));
    return;
  }
  const entries = planReleases(values.base);
  if (command === "plan") {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  await publishPackages(entries, resolve(values.artifacts), {
    report: (message) => {
      console.log(message);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${message}\n`);
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`release:packages: ${error.message}`);
    process.exitCode = 1;
  });
}
