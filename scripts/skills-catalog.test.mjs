import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const patchDirectory = join(repositoryRoot, "patches", "pi-0.85.1");
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

function addedFileSource(patch, path) {
  const marker = `diff --git a/${path} b/${path}`;
  const start = patch.indexOf(marker);
  assert.notEqual(start, -1, `patch does not modify ${path}`);
  const next = patch.indexOf("\ndiff --git ", start + marker.length);
  const section = patch.slice(start, next === -1 ? undefined : next);
  return section
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
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
  if (packageJson.version !== "0.85.1") {
    return `the installed pi package is ${String(packageJson.version)}, not 0.85.1`;
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
      return `the installed pi package does not match the 0.85.1 baseline at ${relativePath ?? "an unknown path"}`;
    }
  }
  const absentManifest = await readFile(join(patchDirectory, "baseline.absent"), "utf8");
  for (const relativePath of absentManifest
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    if (await exists(join(packageRoot, relativePath))) {
      return `the installed pi package does not match the 0.85.1 baseline at ${relativePath}`;
    }
  }
  return undefined;
}

async function verifyManifest(target, manifestName) {
  const manifest = await readFile(join(patchDirectory, manifestName), "utf8");
  for (const line of manifest.trim().split("\n")) {
    const [expected, relativePath] = line.trim().split(/\s+/, 2);
    assert.ok(expected && relativePath, `${manifestName} contains a malformed entry`);
    assert.equal(await sha256(join(target, relativePath)), expected, relativePath);
  }
}

async function applyPatch(target, source = patchPath, reverse = false) {
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

function testEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete env[key];
  }
  return env;
}

async function runPatchedCli(target, args, { agentDir, cwd, home = process.env.HOME }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(target, "dist", "bundle", "cli.js"), ...args], {
      cwd,
      env: testEnvironment({
        ...(home === undefined ? {} : { HOME: home }),
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      }),
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
  await verifyManifest(target, "patched.sha256");
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

async function runGit(cwd, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, env: testEnvironment(), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`git exited with code ${String(code)}: ${stderr.trim()}`));
    });
  });
}

async function addSkillsConcurrently(patchedPackage, sources, scope, options) {
  const results = await Promise.all(
    sources.map((source) => runPatchedCli(patchedPackage, ["skills", "add", source, `--${scope}`], options)),
  );
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
  }
}

// The 0.85.1 runtime is generated from pi-overlay/, whose unit tests cover the same behavior at the source level,
// and the end-to-end test below exercises it through the packaged CLI.
test("hand-written pi 0.84.x patches normalize persisted paths and lock configuration updates", async () => {
  for (const version of ["0.84.2", "0.84.4"]) {
    const patch = await readFile(join(repositoryRoot, "patches", `pi-${version}`, "skills.patch"), "utf8");
    const source = addedFileSource(patch, "dist/core/skill-management.js");
    assert.match(source, /import lockfile from "proper-lockfile";/);
    assert.match(source, /Atomics\.wait\(skillConfigLockWait, 0, 0, delayMs\);/);
    assert.match(
      source,
      /return withSkillConfigLock\(location\.path, \(\) => \{[\s\S]*const config = readJson\(location\.path\);[\s\S]*writeJson\(location\.path, config\);[\s\S]*\}\);/,
    );
    assert.match(source, /looksLikePath\(source\) \|\| existsSync\(resolved\) \? resolved : source/);
    assert.match(
      source,
      /finally \{\n {8}try \{\n {12}release\(\);\n {8}\}\n {8}catch \(error\) \{\n {12}console\.error\(/,
    );
    assert.match(source, /const target = normalizeSkillSource\(source, options\);/);
    assert.match(source, /updatePersistedSkill\(command, target, scope, options\);/);
  }
});

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

    const preValidationPackage = join(temporaryRoot, "pre-validation-package");
    await createPatchedPackage(preValidationPackage);
    await applyPatch(preValidationPackage, join(patchDirectory, "pre-validation-upgrade.patch"), true);
    await verifyManifest(preValidationPackage, "pre-validation-patched.sha256");
    const preValidationResult = await runInstaller(preValidationPackage, join(temporaryRoot, "pre-validation-agent"));
    assert.equal(preValidationResult.code, 0, preValidationResult.stderr);
    assert.match(preValidationResult.stdout, /Upgrading a previously applied \/skills patch/u);
    await verifyManifest(preValidationPackage, "patched.sha256");

    const preLockPackage = join(temporaryRoot, "pre-lock-package");
    await createPatchedPackage(preLockPackage);
    await applyPatch(preLockPackage, join(patchDirectory, "pre-lock-upgrade.patch"), true);
    await verifyManifest(preLockPackage, "pre-lock-patched.sha256");
    const preLockResult = await runInstaller(preLockPackage, join(temporaryRoot, "pre-lock-agent"));
    assert.equal(preLockResult.code, 0, preLockResult.stderr);
    assert.match(preLockResult.stdout, /Upgrading a previously applied \/skills patch/u);
    await verifyManifest(preLockPackage, "patched.sha256");

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

    const normalizedPathAgentDir = join(fixtureRoot, "normalized-path-agent");
    const temporaryHome = join(fixtureRoot, "home");
    const homeSkill = join(temporaryHome, "skills", "home-skill");
    const relativeSkill = join(cwd, "relative-skill");
    const bareRelativeSkill = join(cwd, "bare-relative-skill");
    await Promise.all([
      writeSkill(homeSkill, "home-skill", "tilde path fixture"),
      writeSkill(relativeSkill, "relative-skill", "relative path fixture"),
      writeSkill(bareRelativeSkill, "bare-relative-skill", "bare relative path fixture"),
    ]);
    for (const source of ["~/skills/home-skill", "./relative-skill", "bare-relative-skill"]) {
      const result = await runPatchedCli(patchedPackage, ["skills", "add", source, "--global"], {
        cwd,
        agentDir: normalizedPathAgentDir,
        home: temporaryHome,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
    }
    const normalizedConfig = JSON.parse(await readFile(join(normalizedPathAgentDir, "skills.json"), "utf8"));
    const canonicalCwd = await realpath(cwd);
    assert.deepEqual(normalizedConfig.enabled, [
      homeSkill,
      join(canonicalCwd, "relative-skill"),
      join(canonicalCwd, "bare-relative-skill"),
    ]);

    // A bare name persisted as a path must stay removable by that name once the path is gone.
    await rm(bareRelativeSkill, { recursive: true, force: true });
    const removedBare = await runPatchedCli(patchedPackage, ["skills", "remove", "bare-relative-skill", "--global"], {
      cwd,
      agentDir: normalizedPathAgentDir,
      home: temporaryHome,
    });
    assert.equal(removedBare.code, 0, removedBare.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(normalizedPathAgentDir, "skills.json"), "utf8")).enabled, [
      homeSkill,
      join(canonicalCwd, "relative-skill"),
    ]);

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

    const concurrentRoot = join(fixtureRoot, "concurrent-updates");
    const concurrentSources = Array.from({ length: 12 }, (_, index) =>
      join(concurrentRoot, "skills", `skill-${String(index)}`),
    );
    await Promise.all(
      concurrentSources.map((source, index) => writeSkill(source, `concurrent-${String(index)}`, "lock fixture")),
    );
    const seededEntries = Array.from({ length: 3_000 }, (_, index) => `existing-${String(index)}`);

    const concurrentGlobalAgentDir = join(concurrentRoot, "global-agent");
    const globalConfigPath = join(concurrentGlobalAgentDir, "skills.json");
    await writeJson(globalConfigPath, { enabled: seededEntries });
    await addSkillsConcurrently(patchedPackage, concurrentSources, "global", {
      agentDir: concurrentGlobalAgentDir,
      cwd,
    });
    const globalConfig = JSON.parse(await readFile(globalConfigPath, "utf8"));
    assert.equal(globalConfig.enabled.length, seededEntries.length + concurrentSources.length);
    assert.deepEqual(new Set(globalConfig.enabled), new Set([...seededEntries, ...concurrentSources]));
    assert.equal(await exists(`${globalConfigPath}.lock`), false);

    const concurrentRepoAgentDir = join(concurrentRoot, "repo-agent");
    const concurrentRepo = join(concurrentRoot, "repo");
    await mkdir(concurrentRepo, { recursive: true });
    await runGit(concurrentRepo, ["init", "--quiet"]);
    await runGit(concurrentRepo, ["remote", "add", "origin", "https://example.com/org/repo.git"]);
    const repoConfigPath = join(concurrentRepoAgentDir, "repo-skills.json");
    const repoKey = "example.com:org/repo";
    await writeJson(repoConfigPath, { [repoKey]: { enabled: seededEntries } });
    await addSkillsConcurrently(patchedPackage, concurrentSources, "repo", {
      agentDir: concurrentRepoAgentDir,
      cwd: concurrentRepo,
    });
    const repoConfig = JSON.parse(await readFile(repoConfigPath, "utf8"));
    assert.equal(repoConfig[repoKey].enabled.length, seededEntries.length + concurrentSources.length);
    assert.deepEqual(new Set(repoConfig[repoKey].enabled), new Set([...seededEntries, ...concurrentSources]));
    assert.equal(await exists(`${repoConfigPath}.lock`), false);

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
