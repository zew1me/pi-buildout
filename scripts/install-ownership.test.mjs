import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const extensions = ["clear", "effort", "markdown-backlinks", "subagents"];

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "pi-installer-ownership-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const agent = join(directory, "agent");
  const target = join(agent, "extensions");
  for (const extension of extensions) {
    await mkdir(join(target, extension), { recursive: true });
    await writeFile(join(target, extension, "index.ts"), `old ${extension}\n`);
    await writeFile(join(target, extension, "local.ts"), "keep before replacement\n");
  }
  async function run(env = {}, args = ["--skip-skill-loading-patch"]) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn("bash", [join(root, "scripts/install-extensions.sh"), ...args], {
        env: { ...process.env, PI_AGENT_DIR: agent, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolvePromise({ code, stderr }));
    });
  }
  async function untouched() {
    for (const extension of extensions) {
      assert.equal(await readFile(join(target, extension, "index.ts"), "utf8"), `old ${extension}\n`);
      assert.equal(await readFile(join(target, extension, "local.ts"), "utf8"), "keep before replacement\n");
    }
  }
  return { directory, target, run, untouched };
}

for (const extension of extensions) {
  for (const suffix of [".ts", ".test.mjs"]) {
    for (const kind of ["unknown", "symlink", "dangling symlink", "directory"]) {
      test(`preflight protects ${kind} ${extension}${suffix} before any replacements`, async (context) => {
        const f = await fixture(context);
        const path = join(f.target, extension + suffix);
        const source = join(root, "extensions", extension, suffix === ".ts" ? "index.ts" : "index.test.mjs");
        switch (kind) {
          case "unknown":
            await writeFile(path, "unrecognized older or unrelated content\n");
            break;
          case "symlink":
            await symlink(source, path);
            break;
          case "dangling symlink":
            await symlink(join(f.directory, "missing"), path);
            break;
          case "directory":
            await mkdir(path);
            await writeFile(join(path, "keep"), "keep\n");
            break;
          default:
            assert.fail(kind);
        }
        const before = await lstat(path);
        const result = await f.run();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /not a recognized managed legacy extension file/u);
        assert.ok(result.stderr.includes(path), result.stderr);
        assert.equal((await lstat(path)).ino, before.ino);
        if (kind === "unknown") assert.equal(await readFile(path, "utf8"), "unrecognized older or unrelated content\n");
        if (kind === "directory") assert.equal(await readFile(join(path, "keep"), "utf8"), "keep\n");
        await f.untouched();
      });
    }
  }
}

for (const kind of ["changed content", "new file", "symlink", "directory"]) {
  test(`deletion rechecks legacy ownership after replacements: ${kind}`, async (context) => {
    const f = await fixture(context);
    const legacy = join(f.target, "clear.ts");
    if (kind !== "new file") await copyFile(join(root, "extensions/clear/index.ts"), legacy);
    const bin = join(f.directory, "bin");
    await mkdir(bin);
    let change = `printf 'changed during install\\n' > '${legacy}'`;
    if (kind === "symlink")
      change = `rm -f '${legacy}'; ln -s '${join(root, "extensions/clear/index.ts")}' '${legacy}'`;
    if (kind === "directory") change = `rm -f '${legacy}'; mkdir '${legacy}'`;
    // Deterministically simulate another writer after the last directory swap.
    await writeFile(
      join(bin, "mv"),
      `#!/bin/sh\n/bin/mv "$@" || exit $?\nif [ "$2" = '${join(f.target, "subagents")}' ]; then\n${change}\nfi\n`,
      { mode: 0o755 },
    );
    const result = await f.run({ PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not a recognized managed legacy extension file/u);
    const stat = await lstat(legacy);
    if (kind === "symlink") assert.equal(stat.isSymbolicLink(), true);
    else if (kind === "directory") assert.equal(stat.isDirectory(), true);
    else assert.equal(await readFile(legacy, "utf8"), "changed during install\n");
    assert.equal(
      await readFile(join(f.target, "subagents/index.ts"), "utf8"),
      await readFile(join(root, "extensions/subagents/index.ts"), "utf8"),
    );
  });
}

test("legacy conflict is detected before attempting the skills patch", async (context) => {
  const f = await fixture(context);
  await writeFile(join(f.target, "subagents.test.mjs"), "unknown test\n");
  const result = await f.run({ PI_PACKAGE_DIR: "/missing-pi" }, []);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not a recognized managed legacy extension file/u);
  assert.doesNotMatch(result.stderr, /Could not locate pi package/u);
  await f.untouched();
});
