import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const installerPath = join(repositoryRoot, "scripts", "install-extensions.sh");
const managedExtensions = ["clear", "effort", "markdown-backlinks", "subagents"];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, args, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
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

async function runInstaller(agentDirectory, args = ["--skip-skill-loading-patch"]) {
  return runCommand("bash", [installerPath, ...args], { PI_AGENT_DIR: agentDirectory });
}

test("installer retires legacy top-level extensions after installing directory replacements", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-extension-installer-"));
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const agentDirectory = join(temporaryRoot, "agent");
  const extensionDirectory = join(agentDirectory, "extensions");
  await mkdir(extensionDirectory, { recursive: true });

  await Promise.all([
    ...managedExtensions.flatMap((extension) => [
      copyFile(join(repositoryRoot, "extensions", extension, "index.ts"), join(extensionDirectory, `${extension}.ts`)),
      copyFile(
        join(repositoryRoot, "extensions", extension, "index.test.mjs"),
        join(extensionDirectory, `${extension}.test.mjs`),
      ),
    ]),
    writeFile(join(extensionDirectory, "unrelated.ts"), "unrelated extension\n"),
  ]);

  const result = await runInstaller(agentDirectory);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Installed pi extensions/u);
  for (const extension of managedExtensions) {
    assert.equal(await exists(join(extensionDirectory, `${extension}.ts`)), false);
    assert.equal(await exists(join(extensionDirectory, `${extension}.test.mjs`)), false);
    assert.equal(await exists(join(extensionDirectory, extension, "index.ts")), true);
    assert.equal(await exists(join(extensionDirectory, extension, "helpers.ts")), true);
    assert.equal(
      await readFile(join(extensionDirectory, extension, "index.ts"), "utf8"),
      await readFile(join(repositoryRoot, "extensions", extension, "index.ts"), "utf8"),
    );
  }
  assert.equal(await readFile(join(extensionDirectory, "unrelated.ts"), "utf8"), "unrelated extension\n");
});

test("installer rejects requests that skip both extensions and the /skills patch", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-extension-installer-no-work-"));
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const result = await runInstaller(join(temporaryRoot, "agent"), ["--skip-extensions", "--skip-skill-loading-patch"]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /nothing to install/u);
});

test("pi-skills-patch symlink defaults the installer to patch-only mode", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-extension-installer-symlink-"));
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));

  const binary = join(temporaryRoot, "pi-skills-patch");
  await symlink(installerPath, binary);

  const help = await runCommand(binary, ["--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /Apply only the version-checked \/skills runtime patch/u);

  const noWork = await runCommand(binary, ["--skip-skill-loading-patch"]);
  assert.equal(noWork.code, 2);
  assert.match(noWork.stderr, /nothing to install/u);
});

test("installer resolves ROOT_DIR through the real script path", async () => {
  const source = await readFile(installerPath, "utf8");
  assert.match(source, /realpath "\$\{BASH_SOURCE\[0\]\}"/u);
});
