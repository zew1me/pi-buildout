import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { findCleanPackage, patchDirectoryFor, patchVersions, repositoryRoot } from "./skills-patch-packages.mjs";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  const contents = await readFile(path);
  return createHash("sha256").update(contents).digest("hex");
}

async function verifyManifest(patchDirectory, target, manifestName) {
  const manifest = await readFile(join(patchDirectory, manifestName), "utf8");
  for (const line of manifest.trim().split("\n")) {
    const [expected, relativePath] = line.trim().split(/\s+/, 2);
    assert.ok(expected && relativePath, `${manifestName} contains a malformed entry`);
    assert.equal(await sha256(join(target, relativePath)), expected, relativePath);
  }
}

async function applyPatch(target, source, reverse = false) {
  const patchContents = await readFile(source);
  await new Promise((resolvePromise, reject) => {
    const child = spawn("patch", ["--batch", reverse ? "--reverse" : "--forward", "--strip=1"], {
      cwd: target,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`patch exited with code ${String(code)}: ${stderr.trim()}`));
      }
    });
    child.stdin.end(patchContents);
  });
}

async function runPatchedCli(target, args, { agentDir, cwd }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(target, "dist", "bundle", "cli.js"), ...args], {
      cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/** Copies a clean package, optionally applies `patchDirectory`'s patch, and verifies the expected state. */
async function copyPackage(packageRoot, target, patchDirectory, { patched = true } = {}) {
  await mkdir(target, { recursive: true });
  await Promise.all([
    cp(join(packageRoot, "dist"), join(target, "dist"), { recursive: true }),
    cp(join(packageRoot, "docs"), join(target, "docs"), { recursive: true }),
    copyFile(join(packageRoot, "package.json"), join(target, "package.json")),
  ]);
  await symlink(
    join(packageRoot, "node_modules"),
    join(target, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  if (patched) {
    await applyPatch(target, join(patchDirectory, "skills.patch"));
    await verifyManifest(patchDirectory, target, "patched.sha256");
  }
}

async function runInstaller(packageDirectory, agentDirectory) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bash", [join(repositoryRoot, "scripts", "install-extensions.sh")], {
      env: { ...process.env, PI_AGENT_DIR: agentDirectory, PI_PACKAGE_DIR: packageDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function writeSkill(skillDirectory, name, description) {
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

for (const version of patchVersions()) {
  const patchDirectory = patchDirectoryFor(version);

  test(`pi ${version}: the patched catalog resolves fixed, package, and settings skills with trust and precedence`, async (t) => {
    const { packageRoot, problem } = await findCleanPackage(version);
    if (packageRoot === undefined) {
      t.skip(problem);
      return;
    }

    const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-skills-catalog-"));
    const patchedPackage = join(temporaryRoot, "package");
    const fixtureRoot = join(temporaryRoot, "fixtures");
    const cwd = join(fixtureRoot, "project");
    const projectConfig = join(cwd, ".pi");
    const agentDir = join(fixtureRoot, "agent");
    const previousHome = process.env.HOME;

    try {
      process.env.HOME = join(fixtureRoot, "home");
      try {
        await copyPackage(packageRoot, patchedPackage, patchDirectory);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          t.skip("the patch utility is unavailable");
          return;
        }
        throw error;
      }

      // The installer applies the patch to a clean package of this version.
      const cleanPackage = join(temporaryRoot, "clean-package");
      await copyPackage(packageRoot, cleanPackage, patchDirectory, { patched: false });
      const cleanInstall = await runInstaller(cleanPackage, join(temporaryRoot, "clean-installer-agent"));
      assert.equal(cleanInstall.code, 0, cleanInstall.stderr);
      assert.match(
        cleanInstall.stdout,
        new RegExp(`Applied /skills patch for pi ${version.replaceAll(".", "\\.")}`, "u"),
      );
      await verifyManifest(patchDirectory, cleanPackage, "patched.sha256");

      // Where this version has a recorded pre-validation state, the installer upgrades it in place.
      if (await exists(join(patchDirectory, "pre-validation-upgrade.patch"))) {
        const preValidationPackage = join(temporaryRoot, "pre-validation-package");
        await copyPackage(packageRoot, preValidationPackage, patchDirectory);
        await applyPatch(preValidationPackage, join(patchDirectory, "pre-validation-upgrade.patch"), true);
        await verifyManifest(patchDirectory, preValidationPackage, "pre-validation-patched.sha256");
        const installerResult = await runInstaller(preValidationPackage, join(temporaryRoot, "installer-agent"));
        assert.equal(installerResult.code, 0, installerResult.stderr);
        assert.match(installerResult.stdout, /Upgrading a previously applied \/skills patch/u);
        await verifyManifest(patchDirectory, preValidationPackage, "patched.sha256");
      }

      await Promise.all([
        writeSkill(join(agentDir, "skills", "fixed"), "fixed-choice", "global fixed directory"),
        writeSkill(join(projectConfig, "skills", "fixed"), "fixed-choice", "project fixed directory"),
        writeSkill(
          join(agentDir, "packages", "convention", "skills", "directory"),
          "package-directory",
          "package convention directory",
        ),
        writeSkill(
          join(projectConfig, "packages", "manifest", "declared"),
          "package-manifest",
          "package pi.skills declaration",
        ),
        writeSkill(join(agentDir, "packages", "global-choice", "skills", "choice"), "package-choice", "global package"),
        writeSkill(
          join(projectConfig, "packages", "project-choice", "skills", "choice"),
          "package-choice",
          "project package",
        ),
        writeSkill(
          join(agentDir, "packages", "cross-group", "skills", "choice"),
          "package-vs-setting",
          "package group",
        ),
        writeSkill(join(agentDir, "settings", "global"), "setting-global", "global settings.skills"),
        writeSkill(join(projectConfig, "settings", "project"), "setting-project", "project settings.skills"),
        writeSkill(join(agentDir, "settings", "global-choice"), "settings-choice", "global setting"),
        writeSkill(join(projectConfig, "settings", "project-choice"), "settings-choice", "project setting"),
        writeSkill(join(agentDir, "settings", "cross-group"), "package-vs-setting", "settings group"),
      ]);
      await Promise.all([
        writeJson(join(projectConfig, "packages", "manifest", "package.json"), {
          pi: { skills: ["./declared"] },
        }),
        writeJson(join(agentDir, "settings.json"), {
          defaultProjectTrust: "always",
          packages: ["./packages/convention", "./packages/global-choice", "./packages/cross-group"],
          skills: ["./settings/global", "./settings/global-choice", "./settings/cross-group"],
        }),
        writeJson(join(projectConfig, "settings.json"), {
          packages: ["./packages/manifest", "./packages/project-choice"],
          skills: ["./settings/project", "./settings/project-choice"],
        }),
        writeJson(join(agentDir, "skills.json"), {
          enabled: ["package-directory", "setting-global"],
        }),
      ]);

      const moduleUrl = (relativePath) => pathToFileURL(join(patchedPackage, relativePath)).href;
      const [
        { SettingsManager },
        { getSkillCatalog, normalizeGitRemoteUrl, resolveSkillEntryPath, runSkillsCommand },
        { DefaultResourceLoader },
      ] = await Promise.all([
        import(moduleUrl("dist/core/settings-manager.js")),
        import(moduleUrl("dist/core/skill-management.js")),
        import(moduleUrl("dist/core/resource-loader.js")),
      ]);
      const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });

      assert.equal(normalizeGitRemoteUrl("https://git.example.com:8443/org/repo.git"), "git.example.com:8443:org/repo");
      assert.equal(normalizeGitRemoteUrl("https://git.example.com:9443/org/repo.git"), "git.example.com:9443:org/repo");
      assert.equal(normalizeGitRemoteUrl("git@github.com:org/repo.git"), "github.com:org/repo");
      assert.equal(normalizeGitRemoteUrl("ssh://git@github.com/org/repo.git"), "github.com:org/repo");
      assert.equal(normalizeGitRemoteUrl("ssh://git@github.com:22/org/repo.git"), "github.com:org/repo");
      assert.equal(normalizeGitRemoteUrl("ssh://git@github.com:2222/org/repo.git"), "github.com:2222:org/repo");

      for (const invalidConfig of [[], null, "fixed-choice", 1]) {
        await writeJson(join(agentDir, "skills.json"), invalidConfig);
        const result = await runSkillsCommand(["active"], { cwd, agentDir, settingsManager });
        assert.equal(result.exitCode, 1);
        assert.deepEqual(result.lines, [`Could not parse ${join(agentDir, "skills.json")}: Expected a JSON object`]);
      }
      await writeJson(join(agentDir, "skills.json"), {
        enabled: ["package-directory", "setting-global"],
      });

      const invalidCommand = await runPatchedCli(patchedPackage, ["skills", "unknown"], { agentDir, cwd });
      assert.equal(invalidCommand.code, 1);
      assert.equal(invalidCommand.stdout, "");
      assert.match(invalidCommand.stderr, /Usage: pi skills/);

      const catalog = await getSkillCatalog({ cwd, agentDir, settingsManager });
      const catalogByName = new Map(catalog.map((skill) => [skill.name, skill]));

      assert.deepEqual(
        catalog.map((skill) => skill.name),
        [
          "fixed-choice",
          "package-choice",
          "package-directory",
          "package-manifest",
          "package-vs-setting",
          "setting-global",
          "setting-project",
          "settings-choice",
        ],
      );
      assert.equal(catalogByName.get("fixed-choice")?.description, "global fixed directory");
      assert.equal(catalogByName.get("package-choice")?.description, "project package");
      assert.equal(catalogByName.get("package-vs-setting")?.description, "package group");
      assert.equal(catalogByName.get("settings-choice")?.description, "project setting");

      const listResult = await runSkillsCommand(["list"], { cwd, agentDir, settingsManager });
      assert.equal(listResult.exitCode, 0);
      assert.deepEqual(
        listResult.lines,
        catalog.map((skill) => `${skill.name}\t${skill.description}`),
        "CLI and interactive command callers share the same catalog output",
      );
      const cliList = await runPatchedCli(patchedPackage, ["skills", "list"], { agentDir, cwd });
      assert.equal(cliList.code, 0);
      assert.equal(cliList.stderr, "");
      assert.deepEqual(cliList.stdout.trim().split("\n"), listResult.lines);

      // Entry resolution lives in the skill-management module, so DefaultResourceLoader keeps no skill API.
      const entryContext = { cwd, agentDir, settingsManager, resolveResourcePath: (path) => path };
      for (const name of ["package-manifest", "setting-project"]) {
        const { resolved } = await resolveSkillEntryPath(entryContext, name);
        assert.equal(resolved, catalogByName.get(name)?.filePath, name);
      }

      const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
      await loader.reload();
      assert.deepEqual(
        loader.getSkills().skills.map((skill) => skill.name),
        ["package-directory", "setting-global"],
        "catalog discovery does not activate skills that were not explicitly enabled",
      );

      const untrustedSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
      const untrustedCatalog = await getSkillCatalog({ cwd, agentDir, settingsManager: untrustedSettings });
      const untrustedByName = new Map(untrustedCatalog.map((skill) => [skill.name, skill]));
      assert.equal(untrustedByName.has("package-manifest"), false);
      assert.equal(untrustedByName.has("setting-project"), false);
      assert.equal(untrustedByName.get("package-choice")?.description, "global package");
      assert.equal(untrustedByName.get("settings-choice")?.description, "global setting");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
