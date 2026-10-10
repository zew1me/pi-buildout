import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { countUpstreamEditedLines, patchedFileList } from "./build-pi-patch.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
for (const version of ["1.0.3", "1.0.4", "1.1.0"]) {
  const manifest = JSON.parse(await readFile(join(root, `pi-overlay/versions/${version}/upstream.json`), "utf8"));
  const patchDir = join(root, `patches/pi-${version}`);

  test(`pi ${version} patch tracks only declared paths and pins the unchanged bundled loader`, async () => {
    const [patch, baseline, patched] = await Promise.all(
      ["skills.patch", "baseline.sha256", "patched.sha256"].map((name) => readFile(join(patchDir, name), "utf8")),
    );
    const paths = patchedFileList(patch);
    const declared = manifest.trackedFiles;
    const changed = declared.filter((entry) => entry.source !== "unchanged");
    assert.deepEqual(new Set(paths.map((entry) => entry.path)), new Set(changed.map((entry) => entry.path)));
    assert.deepEqual(
      new Set(paths.filter((entry) => entry.added).map((entry) => entry.path)),
      new Set(declared.filter((entry) => entry.added).map((entry) => entry.path)),
    );
    assert.equal(
      countUpstreamEditedLines(
        patch,
        new Set(declared.filter((entry) => entry.source === "built" && !entry.added).map((entry) => entry.path)),
      ),
      manifest.maxUpstreamEditedLines,
    );
    const loaderPath = "dist/bundle/cli.js";
    assert.equal(checksum(baseline, loaderPath), checksum(patched, loaderPath));
    const loader =
      '#!/usr/bin/env node\nimport { createRequire, enableCompileCache } from "node:module";\n\nenableCompileCache();\ncreateRequire(import.meta.url)("./cli-runtime.js");\n';
    assert.equal(checksum(baseline, loaderPath), createHash("sha256").update(loader).digest("hex"));
    for (const name of ["cli-runtime.js", "rpc-entry.js"]) {
      const path = `dist/bundle/${name}`;
      const source = await readFile(join(root, `pi-overlay/versions/${version}/replacements`, path));
      assert.equal(createHash("sha256").update(source).digest("hex"), checksum(patched, path));
    }
  });
}

function checksum(text, path) {
  const line = text.split("\n").find((entry) => entry.endsWith(`  ${path}`));
  assert.ok(line, `${path} missing from checksum manifest`);
  return line.split(/\s+/u)[0];
}
