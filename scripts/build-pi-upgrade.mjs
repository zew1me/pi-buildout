#!/usr/bin/env node
/**
 * Emits one `/skills` upgrade state: the manifest, absent list, and migration patch that let the installer
 * move an already-patched package onto the currently generated patch.
 *
 * The installer recognises an upgrade state only when the installed package matches it exactly, so each
 * state is described by the bytes of a real tree rather than by a version number.
 *
 * Usage:
 *   node scripts/build-pi-upgrade.mjs --version <semver> --label <name> --from <dir> --patched <dir>
 *
 * `--from` is the previously patched package tree being migrated away from, and `--patched` is the tree the
 * current generation run produced. Both are package roots, so `dist/...` resolves directly beneath them.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildUnifiedDiff, formatChecksumManifest, sha256File } from "./build-pi-patch.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) throw new Error(`Missing required --${name}`);
  const value = process.argv[index + 1];
  if (!value) throw new Error(`--${name} needs a value`);
  return value;
}

function main() {
  const version = flag("version");
  const label = flag("label");
  const from = flag("from");
  const patched = flag("patched");

  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, "pi-overlay", "versions", version, "upstream.json"), "utf-8"),
  );
  const outputDir = join(repositoryRoot, "patches", `pi-${version}`);

  const present = [];
  const absent = [];
  for (const entry of manifest.trackedFiles) {
    const path = join(from, entry.path);
    if (existsSync(path)) present.push({ path: entry.path, sha256: sha256File(path) });
    else absent.push(entry.path);
  }
  if (present.length === 0) throw new Error(`${from} contains none of the tracked files.`);

  const workDir = mkdtempSync(join(tmpdir(), `pi-upgrade-${label}-`));
  try {
    // Diff only the files the old state actually has, plus everything the new patch ships, so the migration
    // both updates existing files and creates the ones the old state predates.
    const patchText = buildUnifiedDiff(workDir, from, patched, manifest);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, `${label}-patched.sha256`), formatChecksumManifest(present));
    writeFileSync(join(outputDir, `${label}-upgrade.patch`), patchText);
    if (absent.length > 0) writeFileSync(join(outputDir, `${label}-absent`), absent.join("\n") + "\n");
    else rmSync(join(outputDir, `${label}-absent`), { force: true });

    console.log(`${label}: ${present.length} tracked files present, ${absent.length} absent`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main();
