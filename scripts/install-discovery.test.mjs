import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const installer = join(root, "scripts/install-extensions.sh");
const packageName = "@earendil-works/pi-coding-agent";

async function manifest(directory, value = { name: packageName, version: "9.9.9" }) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify(value));
}

async function executable(path, source = "#!/bin/sh\nexit 0\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, { mode: 0o755 });
}

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "pi-installer-discovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  const agent = join(directory, "agent");
  const globalRoot = join(directory, "global");
  const npmLog = join(directory, "npm-called");
  await manifest(join(globalRoot, packageName), { name: packageName, version: "9.9.8" });
  await executable(join(bin, "npm"), `#!/bin/sh\necho called >> '${npmLog}'\nprintf '%s\\n' '${globalRoot}'\n`);
  async function run(args = ["--skip-extensions"], extraEnv = {}) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn("bash", [installer, ...args], {
        env: {
          ...process.env,
          PI_PACKAGE_DIR: "",
          PI_AGENT_DIR: agent,
          PI_CODING_AGENT_DIR: agent,
          PATH: `${bin}:${process.env.PATH}`,
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
    });
  }
  async function noNpm() {
    await assert.rejects(readFile(npmLog), { code: "ENOENT" });
  }
  return { directory, bin, agent, globalRoot, npmLog, run, noNpm };
}

function located(result, version = "9.9.9") {
  assert.equal(result.code, 1, result.stderr);
  assert.ok(result.stderr.includes(`No complete /skills patch exists for pi ${version}.`), result.stderr);
}

async function managedFixture(context) {
  const result = await fixture(context);
  const managed = join(result.agent, "install");
  const pointer = join(managed, "current-version");
  const active = join(managed, "releases/1.0.3/node_modules", packageName);
  await mkdir(managed, { recursive: true });
  const launcher = join(result.agent, "bin/pi");
  // Official signature only, not a copy of the launcher. Execution must never occur.
  await executable(launcher, "#!/bin/sh\n# PI_MANAGED_INSTALL_ROOT=\n# /install/current-version\nexit 99\n");
  await symlink(launcher, join(result.bin, "pi"));
  await writeFile(
    join(managed, "managed-install.json"),
    JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }),
  );
  // The install project is not the active Pi package.
  await manifest(managed, { name: "pi-managed-install", version: "0.0.0" });
  await writeFile(pointer, "1.0.3\n");
  await manifest(active, { name: packageName, version: "1.0.3" });
  return { ...result, managed, pointer, active };
}

test("managed launcher patches the active 1.0.3 release without invoking npm", async (context) => {
  const f = await managedFixture(context);
  const sums = await readFile(join(root, "patches/pi-1.0.3/baseline.sha256"), "utf8");
  for (const line of sums.trim().split("\n")) {
    const [, path] = line.split(/\s+/u);
    await mkdir(dirname(join(f.active, path)), { recursive: true });
    await copyFile(join(root, "node_modules", packageName, path), join(f.active, path));
  }
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Applied \/skills patch for pi 1\.0\.3/u);
  const again = await f.run();
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already applied/u);
  await f.noNpm();
});

for (const problem of [
  "missing root",
  "missing pointer",
  "dangling pointer",
  "directory pointer",
  "empty",
  "path traversal",
  "invalid version",
  "missing package",
  "malformed manifest",
  "wrong identity",
  "version mismatch",
]) {
  test(`managed ${problem} fails without falling back to unrelated global Pi`, async (context) => {
    const f = await managedFixture(context);
    switch (problem) {
      case "missing root":
        await rm(f.managed, { recursive: true });
        break;
      case "missing pointer":
        await rm(f.pointer);
        break;
      case "dangling pointer":
        await rm(f.pointer);
        await symlink("missing", f.pointer);
        break;
      case "directory pointer":
        await rm(f.pointer);
        await mkdir(f.pointer);
        break;
      case "empty":
        await writeFile(f.pointer, "\n");
        break;
      case "path traversal":
        await writeFile(f.pointer, "../../global\n");
        break;
      case "invalid version":
        await writeFile(f.pointer, "not-a-version\n");
        break;
      case "missing package":
        await rm(f.active, { recursive: true });
        break;
      case "malformed manifest":
        await writeFile(join(f.active, "package.json"), "{broken");
        break;
      case "version mismatch":
        await manifest(f.active, { name: packageName, version: "1.0.4" });
        break;
      case "wrong identity":
        await manifest(f.active, { name: "unrelated", version: "1.0.3" });
        break;
      default:
        assert.fail(problem);
    }
    const result = await f.run();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Could not locate the active managed Pi package/u);
    assert.doesNotMatch(result.stderr, /No complete \/skills patch/u);
    await f.noNpm();
  });
}

for (const recognition of ["signature only", "marker only", "BOM marker"]) {
  test(`direct managed launcher recognized by ${recognition} without execution`, async (context) => {
    const f = await managedFixture(context);
    await rm(join(f.bin, "pi"));
    if (recognition === "signature only") {
      await rm(join(f.managed, "managed-install.json"));
    } else {
      await executable(join(f.agent, "bin/pi"), "#!/bin/sh\nexit 99\n");
      if (recognition === "BOM marker") {
        const marker = join(f.managed, "managed-install.json");
        await writeFile(marker, `\uFEFF${await readFile(marker, "utf8")}`);
      }
    }
    // An unsupported release makes successful discovery observable without patching.
    await writeFile(f.pointer, "9.9.9\n");
    await manifest(join(f.managed, "releases/9.9.9/node_modules", packageName));
    const env = { PATH: `${join(f.agent, "bin")}:${f.bin}:${process.env.PATH}` };
    located(await f.run(undefined, env));
    await rm(f.pointer);
    const missingPointer = await f.run(undefined, env);
    assert.equal(missingPointer.code, 1);
    assert.match(missingPointer.stderr, /Could not locate the active managed Pi package/u);
    await f.noNpm();
    await rm(f.managed, { recursive: true });
    const broken = await f.run(undefined, env);
    assert.equal(broken.code, 1);
    if (recognition === "signature only") {
      assert.match(broken.stderr, /Could not locate the active managed Pi package/u);
      await f.noNpm();
    } else {
      // With both identifiers gone, this is now just an ordinary shim.
      located(broken, "9.9.8");
    }
  });
}

for (const layout of ["libexec/lib", "lib", "shim"]) {
  for (const unrelated of [
    "file",
    "directory",
    "symlink",
    "dangling symlink",
    "release",
    "partial signature",
    "invalid marker",
  ]) {
    test(`${layout} lookup ignores unrelated install ${unrelated}`, async (context) => {
      const f = await fixture(context);
      const prefix = join(f.directory, "ordinary");
      const install = join(prefix, "install");
      const launcher = join(prefix, "bin/pi");
      await executable(launcher);
      await symlink(launcher, join(f.bin, "pi"));
      if (layout !== "shim") await manifest(join(prefix, layout, "node_modules", packageName));
      switch (unrelated) {
        case "file":
          await writeFile(install, "unrelated");
          break;
        case "symlink":
          await symlink(f.globalRoot, install);
          break;
        case "dangling symlink":
          await symlink("missing", install);
          break;
        default:
          await mkdir(install);
          if (unrelated === "release") {
            await writeFile(join(install, "current-version"), "9.9.7\n");
            await manifest(join(install, "releases/9.9.7/node_modules", packageName), {
              name: packageName,
              version: "9.9.7",
            });
          } else if (unrelated === "partial signature") {
            await executable(launcher, "#!/bin/sh\n# /install/current-version\nexit 99\n");
          } else if (unrelated === "invalid marker") {
            await writeFile(
              join(install, "managed-install.json"),
              JSON.stringify({ kind: "pi-managed-install", schemaVersion: "1", layout: "releases-v1" }),
            );
          }
      }
      located(await f.run(), layout === "shim" ? "9.9.8" : "9.9.9");
      if (layout === "shim") assert.match(await readFile(f.npmLog, "utf8"), /called/u);
      else await f.noNpm();
    });
  }
}

test("direct CLI lookup skips unrelated and malformed ancestor manifests", async (context) => {
  const f = await fixture(context);
  const pkg = join(f.directory, "direct");
  await manifest(pkg);
  await manifest(join(pkg, "dist"), { name: "unrelated", version: "9.9.7" });
  await mkdir(join(pkg, "dist/nested"));
  await writeFile(join(pkg, "dist/nested/package.json"), "{broken");
  const cli = join(pkg, "dist/nested/cli.js");
  await executable(cli);
  await symlink(cli, join(f.bin, "pi"));
  located(await f.run());
  await f.noNpm();
});

for (const layout of ["libexec/lib", "lib"]) {
  test(`Homebrew/direct wrapper preserves ${layout} lookup`, async (context) => {
    const f = await fixture(context);
    const prefix = join(f.directory, "formula");
    await executable(join(prefix, "bin/pi"));
    await manifest(join(prefix, layout, "node_modules", packageName));
    await symlink(join(prefix, "bin/pi"), join(f.bin, "pi"));
    located(await f.run());
    await f.noNpm();
  });
}

test("ordinary shim ignores unrelated ancestor identity and uses npm global Pi", async (context) => {
  const f = await fixture(context);
  await manifest(f.directory, { name: "unrelated", version: "9.9.7" });
  await executable(join(f.bin, "pi"));
  located(await f.run(), "9.9.8");
  assert.match(await readFile(f.npmLog, "utf8"), /called/u);
});

test("npm global discovery also requires exact Pi identity", async (context) => {
  const f = await fixture(context);
  await executable(join(f.bin, "pi"));
  await manifest(join(f.globalRoot, packageName), { name: "pi-coding-agent", version: "9.9.8" });
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Could not locate @earendil-works\/pi-coding-agent/u);
});

for (const value of [
  { name: "unrelated", version: "9.9.9" },
  { name: "@earendil-works/pi-coding-agent-extra", version: "9.9.9" },
  { version: "9.9.9" },
  null,
  "malformed",
]) {
  test(`explicit package directory refuses ${JSON.stringify(value)} without fallback`, async (context) => {
    const f = await fixture(context);
    const pkg = join(f.directory, "explicit");
    await manifest(pkg, value);
    if (value === "malformed") await writeFile(join(pkg, "package.json"), "{broken");
    const result = await f.run(undefined, { PI_PACKAGE_DIR: pkg });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Could not locate @earendil-works\/pi-coding-agent/u);
    await f.noNpm();
  });
}

test("explicit Pi identity works and pre-1.0.3 remains unsupported", async (context) => {
  const f = await fixture(context);
  const pkg = join(f.directory, "explicit");
  await manifest(pkg);
  located(await f.run(undefined, { PI_PACKAGE_DIR: pkg }));
  await manifest(pkg, { name: packageName, version: "1.0.2" });
  located(await f.run(undefined, { PI_PACKAGE_DIR: pkg }), "1.0.2");
  await f.noNpm();
});

test("extension-only install does not inspect even a broken managed Pi", async (context) => {
  const f = await managedFixture(context);
  await rm(f.pointer);
  const result = await f.run(["--skip-skill-loading-patch"], { PI_PACKAGE_DIR: "/nonexistent" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Installed pi extensions/u);
  await f.noNpm();
});
