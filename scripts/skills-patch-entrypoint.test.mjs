import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const patchDirectory = fileURLToPath(new URL("../patches/pi-0.85.1/", import.meta.url));

function patchedFileSource(patch, path) {
  const marker = `diff --git a/${path} b/${path}`;
  const start = patch.indexOf(marker);
  assert.notEqual(start, -1, `patch does not modify ${path}`);
  const next = patch.indexOf("\ndiff --git ", start + marker.length);
  const section = patch.slice(start, next === -1 ? undefined : next);

  return section
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith(" ") && !line.startsWith(" diff --git")),
    )
    .map((line) => line.slice(1))
    .join("\n")
    .concat("\n");
}

function manifestChecksum(manifest, path) {
  const line = manifest.split("\n").find((entry) => entry.endsWith(`  ${path}`));
  assert.ok(line, `manifest does not include ${path}`);
  return line.split(/\s+/u)[0];
}

test("pi 0.85.1 bundled CLI delegates to the patched unbundled runtime", async (context) => {
  const entrypoint = "dist/bundle/cli.js";
  const [patch, baselineManifest, patchedManifest, legacyManifest, legacyUpgradePatch] = await Promise.all([
    readFile(join(patchDirectory, "skills.patch"), "utf8"),
    readFile(join(patchDirectory, "baseline.sha256"), "utf8"),
    readFile(join(patchDirectory, "patched.sha256"), "utf8"),
    readFile(join(patchDirectory, "legacy-patched.sha256"), "utf8"),
    readFile(join(patchDirectory, "legacy-upgrade.patch"), "utf8"),
  ]);
  const source = patchedFileSource(patch, entrypoint);

  assert.match(source, /from "\.\.\/cli\/setup\.js"/u);
  assert.match(source, /from "\.\.\/main\.js"/u);
  assert.match(manifestChecksum(baselineManifest, entrypoint), /^[0-9a-f]{64}$/u);
  assert.equal(
    manifestChecksum(legacyManifest, entrypoint),
    manifestChecksum(baselineManifest, entrypoint),
    "the legacy state must recognize the original bundled entrypoint",
  );
  assert.equal(patchedFileSource(legacyUpgradePatch, entrypoint), source);
  assert.equal(createHash("sha256").update(source).digest("hex"), manifestChecksum(patchedManifest, entrypoint));

  const packageDirectory = await mkdtemp(join(tmpdir(), "pi-patched-entrypoint-"));
  context.after(() => rm(packageDirectory, { force: true, recursive: true }));
  await mkdir(join(packageDirectory, "dist", "bundle"), { recursive: true });
  await mkdir(join(packageDirectory, "dist", "cli"), { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), '{"type":"module"}\n');
  await writeFile(
    join(packageDirectory, "dist", "cli", "setup.js"),
    "export function setupCli() { globalThis.__piPatchedEntrypoint.push('setup'); }\n",
  );
  await writeFile(
    join(packageDirectory, "dist", "main.js"),
    "export function main() { globalThis.__piPatchedEntrypoint.push('main'); }\n",
  );
  await writeFile(join(packageDirectory, entrypoint), source);

  globalThis.__piPatchedEntrypoint = [];
  await import(`${pathToFileURL(join(packageDirectory, entrypoint)).href}?test=${Date.now()}`);
  assert.deepEqual(globalThis.__piPatchedEntrypoint, ["setup", "main"]);
  delete globalThis.__piPatchedEntrypoint;
});
