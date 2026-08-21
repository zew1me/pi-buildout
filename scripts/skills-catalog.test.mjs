import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const patchDirectory = join(repositoryRoot, "patches", "pi-0.84.2");
const patchPath = join(patchDirectory, "skills.patch");
const packageRoot = join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent");

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

async function baselineProblem() {
  const packageJsonPath = join(packageRoot, "package.json");
  if (!(await exists(packageJsonPath))) {
    return "the installed @earendil-works/pi-coding-agent package is unavailable";
  }
  if (!(await exists(join(packageRoot, "node_modules")))) {
    return "the installed pi package dependencies are unavailable";
  }
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.version !== "0.84.2") {
    return `the installed pi package is ${String(packageJson.version)}, not 0.84.2`;
  }
  const manifest = await readFile(join(patchDirectory, "baseline.sha256"), "utf8");
  for (const line of manifest.trim().split("\n")) {
    const [expected, relativePath] = line.trim().split(/\s+/, 2);
    const baselinePath = relativePath ? join(packageRoot, relativePath) : undefined;
    if (
      !expected ||
      !relativePath ||
      !baselinePath ||
      !(await exists(baselinePath)) ||
      (await sha256(baselinePath)) !== expected
    ) {
      return `the installed pi package does not match the 0.84.2 baseline at ${relativePath ?? "an unknown path"}`;
    }
  }
  const absentManifest = await readFile(join(patchDirectory, "baseline.absent"), "utf8");
  for (const relativePath of absentManifest
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    if (await exists(join(packageRoot, relativePath))) {
      return `the installed pi package does not match the 0.84.2 baseline at ${relativePath}`;
    }
  }
  return undefined;
}

async function verifyPatchedManifest(target) {
  const manifest = await readFile(join(patchDirectory, "patched.sha256"), "utf8");
  for (const line of manifest.trim().split("\n")) {
    const [expected, relativePath] = line.trim().split(/\s+/, 2);
    assert.ok(expected && relativePath, "patched checksum manifest contains a malformed entry");
    assert.equal(await sha256(join(target, relativePath)), expected, relativePath);
  }
}

async function applyPatch(target) {
  const patchContents = await readFile(patchPath);
  await new Promise((resolvePromise, reject) => {
    const child = spawn("patch", ["--batch", "--forward", "--strip=1"], {
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

async function createPatchedPackage(target) {
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
  await applyPatch(target);
  await verifyPatchedManifest(target);
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

test("the patched catalog resolves fixed, package, and settings skills with trust and precedence", async (t) => {
  const problem = await baselineProblem();
  if (problem) {
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
      await createPatchedPackage(patchedPackage);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        t.skip("the patch utility is unavailable");
        return;
      }
      throw error;
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
      writeSkill(join(agentDir, "packages", "cross-group", "skills", "choice"), "package-vs-setting", "package group"),
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
    const [{ SettingsManager }, { getSkillCatalog, runSkillsCommand }, { DefaultResourceLoader }] = await Promise.all([
      import(moduleUrl("dist/core/settings-manager.js")),
      import(moduleUrl("dist/core/skill-management.js")),
      import(moduleUrl("dist/core/resource-loader.js")),
    ]);
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
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

    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
    assert.equal(await loader.resolveSkillEntry("package-manifest"), catalogByName.get("package-manifest")?.filePath);
    assert.equal(await loader.resolveSkillEntry("setting-project"), catalogByName.get("setting-project")?.filePath);
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
