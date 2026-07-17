import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("extension installer", () => {
  it("transactionally replaces the complete router tree without shipping tests", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "pi-router-install-"));
    temporaryDirectories.push(agentDirectory);
    const stale = join(agentDirectory, "extensions", "router", "stale.ts");
    await mkdir(dirname(stale), { recursive: true });
    await writeFile(stale, "stale", "utf8");
    await execute(join(root, "scripts", "install-extensions.sh"), ["--skip-skill-loading-patch"], {
      cwd: root,
      env: { ...process.env, PI_AGENT_DIR: agentDirectory },
    });
    const router = join(agentDirectory, "extensions", "router");
    assert.equal(await exists(stale), false);
    assert.equal(await exists(join(router, "index.ts")), true);
    assert.equal(await exists(join(router, "core", "planning.ts")), true);
    assert.equal(await exists(join(router, "core", "planning.test.mjs")), false);
    assert.match(await readFile(join(router, "index.ts"), "utf8"), /submit_implementation_plan/);
  });
});
