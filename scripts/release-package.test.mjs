import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { parseVersion } from "./release-packages.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const registry = "https://registry.npmjs.org/";
const extensionPackages = {
  clear: "clear",
  effort: "effort",
  "markdown-backlinks": "markdown-backlinks",
  subagents: "subagents",
};
const packageKinds = [...Object.keys(extensionPackages), "skills-patch"];
const packageDirectories = Object.fromEntries(packageKinds.map((kind) => [kind, join(root, "packages", `pi-${kind}`)]));

function manifestFor(kind) {
  return JSON.parse(readFileSync(join(packageDirectories[kind], "package.json"), "utf8"));
}

function listFiles(base, relative = "") {
  const files = [];
  for (const entry of readdirSync(join(base, relative), { withFileTypes: true })) {
    const child = join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(base, child));
      continue;
    }
    if (entry.isFile()) files.push(child);
  }
  return files;
}

function sourceRuntimeFiles(extension) {
  return listFiles(join(root, "extensions", extension)).filter(
    (path) => path.endsWith(".ts") && !path.includes(".test."),
  );
}

function removeDist(kind) {
  rmSync(join(packageDirectories[kind], "dist"), { force: true, recursive: true });
}

function packPackage(kind) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), `pi-package-pack-${kind}-`));
  const packageDirectory = packageDirectories[kind];
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", temporaryRoot, "--ignore-scripts=false", "--loglevel=error"],
      { cwd: packageDirectory, encoding: "utf8" },
    ),
  )[0];
  const tarballPath = join(temporaryRoot, packed.filename);
  const extractRoot = join(temporaryRoot, "extract");
  mkdirSync(extractRoot, { recursive: true });
  execFileSync("tar", ["-xzf", tarballPath, "-C", extractRoot]);
  const packageRoot = join(extractRoot, "package");
  const files = listFiles(packageRoot).toSorted();
  return { temporaryRoot, packageRoot, files };
}

function externalPackageId(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function importedSpecifiers(source) {
  const specs = new Set();
  for (const regex of [
    /(?:import|export)\s+(?:[^"']*?\sfrom\s*)?["']([^"']+)["']/gu,
    /import\(\s*["']([^"']+)["']\s*\)/gu,
  ]) {
    for (const match of source.matchAll(regex)) {
      if (match[1]) specs.add(match[1]);
    }
  }
  return [...specs];
}

function assertNoUnexpectedTopLevelFiles(paths, kind) {
  for (const path of paths) {
    const isExpectedTopLevel = path.startsWith("dist/") || path === "package.json" || /^readme(?:\..+)?$/iu.test(path);
    assert.equal(isExpectedTopLevel, true, `${kind} tarball includes unexpected top-level file: ${path}`);
  }
}

function assertNoSensitiveOrDevFiles(paths, kind) {
  const blockedPatterns = [
    /(^|\/)\.github\//u,
    /\.test\./u,
    /^eslint\.config\.mjs$/u,
    /^tsconfig\.json$/u,
    /^lefthook\.yml$/u,
    /^\.markdownlint-cli2\.jsonc$/u,
    /^\.prettierrc\.json$/u,
    /^\.secretlintrc\.json$/u,
    /^\.secretlintignore$/u,
    /^package-lock\.json$/u,
    /^scripts\//u,
  ];
  for (const path of paths) {
    for (const pattern of blockedPatterns) {
      assert.equal(pattern.test(path), false, `${kind} tarball must not include ${path}`);
    }
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function assertRuntimeImportClosure(packageRoot, extension, manifest) {
  const extensionRoot = join(packageRoot, "dist", "extensions", extension);
  const runtimeFiles = listFiles(extensionRoot).filter((path) => path.endsWith(".ts"));
  const allowedExternal = new Set([
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.dependencies ?? {}),
  ]);

  for (const runtimePath of runtimeFiles) {
    const source = readFileSync(join(extensionRoot, runtimePath), "utf8");
    for (const specifier of importedSpecifiers(source)) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const base = resolve(join(extensionRoot, runtimePath, ".."), specifier);
        const hasTarget =
          isFile(base) ||
          isFile(`${base}.ts`) ||
          isFile(`${base}.js`) ||
          isFile(join(base, "index.ts")) ||
          isFile(join(base, "index.js"));
        assert.equal(hasTarget, true, `${manifest.name} import does not resolve: ${runtimePath} -> ${specifier}`);
        continue;
      }
      const packageName = externalPackageId(specifier);
      assert.equal(
        allowedExternal.has(packageName),
        true,
        `${manifest.name} imports ${specifier} but does not declare ${packageName} as a peer/runtime dependency`,
      );
    }
  }
}

test("release package manifests target supported public npm releases", () => {
  const expectedPeers = {
    clear: { "@earendil-works/pi-coding-agent": "*" },
    effort: { "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-tui": "*" },
    "markdown-backlinks": { "@earendil-works/pi-coding-agent": "*" },
    subagents: {
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-tui": "*",
      typebox: "*",
    },
  };
  const hostPackages = [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ];

  for (const kind of packageKinds) {
    const manifest = manifestFor(kind);
    assert.doesNotThrow(() => parseVersion(manifest.version));
    assert.equal(manifest.publishConfig.access, "public");
    assert.equal(manifest.publishConfig.registry, registry);
    assert.equal(manifest.license, "SEE LICENSE IN dist/LICENSE");
    assert.equal(manifest.repository.type, "git");
    assert.equal(manifest.repository.url, "git+https://github.com/zew1me/pi-buildout.git");
    assert.equal(manifest.repository.directory, `packages/pi-${kind}`);
    assert.equal(manifest.scripts.prepack, `node ../../scripts/stage-release-package.mjs ${kind}`);
    assert.deepEqual(manifest.files, ["dist"]);

    for (const dependency of hostPackages) {
      assert.equal(manifest.dependencies?.[dependency], undefined, `${manifest.name} must not bundle ${dependency}`);
    }

    if (kind === "skills-patch") {
      assert.equal(manifest.keywords.includes("pi-package"), false);
      assert.equal(manifest.peerDependencies, undefined);
      assert.deepEqual(manifest.bin, { "pi-skills-patch": "dist/scripts/install-extensions.sh" });
      assert.equal(manifest.pi, undefined);
    } else {
      assert.ok(manifest.keywords.includes("pi-package"));
      assert.deepEqual(manifest.peerDependencies, expectedPeers[kind]);
      const extension = extensionPackages[kind];
      assert.deepEqual(manifest.pi.extensions, [`./dist/extensions/${extension}/index.ts`]);
    }
  }
});

test("extension package tarballs contain minimal runtime payload and load through Pi's extension loader", async () => {
  for (const kind of Object.keys(extensionPackages)) {
    const extension = extensionPackages[kind];
    const manifest = manifestFor(kind);
    const packed = packPackage(kind);
    try {
      assertNoUnexpectedTopLevelFiles(packed.files, kind);
      assertNoSensitiveOrDevFiles(packed.files, kind);

      assert.ok(packed.files.includes("dist/LICENSE"));
      assert.ok(packed.files.includes("dist/ATTRIBUTION.md"));
      assert.equal(
        packed.files.some((path) => path.includes(".test.")),
        false,
      );

      const stagedRuntime = packed.files
        .filter((path) => path.startsWith(`dist/extensions/${extension}/`) && path.endsWith(".ts"))
        .map((path) => path.slice(`dist/extensions/${extension}/`.length))
        .toSorted();
      assert.deepEqual(stagedRuntime, sourceRuntimeFiles(extension).toSorted());

      for (const entry of manifest.pi.extensions) {
        const relative = entry.replace(/^\.\//u, "");
        assert.ok(packed.files.includes(relative), `${kind} tarball missing ${relative}`);
      }

      assertRuntimeImportClosure(packed.packageRoot, extension, manifest);

      const cwd = mkdtempSync(join(tmpdir(), `pi-loader-cwd-${kind}-`));
      const agentDir = mkdtempSync(join(tmpdir(), `pi-loader-agent-${kind}-`));
      try {
        const loaded = await discoverAndLoadExtensions([packed.packageRoot], cwd, agentDir);
        assert.deepEqual(loaded.errors, [], `${kind} failed to load through discoverAndLoadExtensions`);
        assert.equal(loaded.extensions.length, 1);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(packed.temporaryRoot, { recursive: true, force: true });
      removeDist(kind);
    }
  }
});

test("skills patch tarball contains only patch artifacts and patch-only installer mode", () => {
  const kind = "skills-patch";
  const packed = packPackage(kind);
  try {
    assertNoUnexpectedTopLevelFiles(packed.files, kind);
    assertNoSensitiveOrDevFiles(packed.files, kind);

    assert.ok(packed.files.includes("dist/LICENSE"));
    assert.ok(packed.files.includes("dist/ATTRIBUTION.md"));
    assert.ok(packed.files.includes("dist/scripts/install-extensions.sh"));
    assert.equal(
      packed.files.some((path) => path.startsWith("dist/extensions/")),
      false,
    );

    const patchVersions = readdirSync(join(root, "patches"))
      .filter((name) => /^pi-\d/u.test(name))
      .toSorted();
    assert.deepEqual(readdirSync(join(packed.packageRoot, "dist", "patches")).toSorted(), patchVersions);
    for (const version of patchVersions) {
      const expected = readdirSync(join(root, "patches", version))
        .filter((name) => /(?:\.(?:patch|sha256|absent)|-absent)$/u.test(name))
        .toSorted();
      assert.deepEqual(readdirSync(join(packed.packageRoot, "dist", "patches", version)).toSorted(), expected);
    }

    const installer = readFileSync(join(packed.packageRoot, "dist", "scripts", "install-extensions.sh"), "utf8");
    assert.match(installer, /realpath "\$\{BASH_SOURCE\[0\]\}"/u);
    assert.match(installer, /--skip-extensions/u);

    const binDir = mkdtempSync(join(tmpdir(), "pi-skills-package-"));
    try {
      const binary = join(binDir, "pi-skills-patch");
      symlinkSync(join(packed.packageRoot, "dist", "scripts", "install-extensions.sh"), binary);

      const help = spawnSync(binary, ["--help"], { encoding: "utf8" });
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /Apply only the version-checked \/skills runtime patch/u);

      const noWork = spawnSync(binary, ["--skip-skill-loading-patch"], { encoding: "utf8" });
      assert.equal(noWork.status, 2);
      assert.match(noWork.stderr, /nothing to install/i);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(packed.temporaryRoot, { recursive: true, force: true });
    removeDist(kind);
  }
});
