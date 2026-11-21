import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { affectedPackages, prepare } from "./prepare-auto-release.mjs";
import { PACKAGE_KINDS, planReleases } from "./release-packages.mjs";

test("maps runtime and common release inputs to affected packages", () => {
  assert.deepEqual(affectedPackages(["extensions/clear/index.ts"]), ["clear"]);
  assert.deepEqual(affectedPackages(["extensions/clear/index.test.ts"]), []);
  assert.deepEqual(affectedPackages(["patches/pi-1/file.patch"]), ["skills-patch"]);
  assert.deepEqual(affectedPackages(["scripts/install-extensions.sh"]), ["skills-patch"]);
  assert.deepEqual(affectedPackages(["packages/pi-effort/README.md"]), ["effort"]);
  assert.deepEqual(affectedPackages(["ATTRIBUTION.md"]), PACKAGE_KINDS);
  assert.deepEqual(affectedPackages(["README.md"]), []);
});

test("prepares only changed packages for the existing release plan", (t) => {
  const root = mkdtempSync(join(tmpdir(), "auto-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  git("init");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgSign", "false");
  for (const kind of PACKAGE_KINDS) {
    const dir = join(root, "packages", `pi-${kind}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: `@zew1me/pi-${kind}`,
        version: "0.1.0",
        publishConfig: { registry: "https://registry.npmjs.org/", access: "public" },
      }),
    );
  }
  mkdirSync(join(root, "extensions", "clear"), { recursive: true });
  writeFileSync(join(root, "extensions", "clear", "index.ts"), "before");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "extensions", "clear", "index.ts"), "after");
  git("add", ".");
  git("commit", "-m", "change clear");
  assert.deepEqual(prepare(base, "123", root), ["clear"]);
  assert.equal(JSON.parse(readFileSync(join(root, "packages/pi-clear/package.json"))).version, "0.1.1-alpha.123");
  assert.equal(JSON.parse(readFileSync(join(root, "packages/pi-effort/package.json"))).version, "0.1.0");
  assert.deepEqual(
    planReleases(base, root).map(({ name, version, tag }) => ({ name, version, tag })),
    [{ name: "@zew1me/pi-clear", version: "0.1.1-alpha.123", tag: "alpha" }],
  );
  // The pack and publish jobs start from separate clean checkouts.
  git("checkout", "--", "packages/pi-clear/package.json");
  assert.deepEqual(prepare(base, "123", root), ["clear"]);
  assert.equal(JSON.parse(readFileSync(join(root, "packages/pi-clear/package.json"))).version, "0.1.1-alpha.123");
  assert.throws(() => prepare(base, "0", root), /positive numeric/);

  git("checkout", "--", "packages/pi-clear/package.json");
  const secondBase = git("rev-parse", "HEAD");
  writeFileSync(join(root, "extensions", "clear", "quoted\nname.ts"), "after");
  git("add", ".");
  git("commit", "-m", "quoted filename");
  assert.deepEqual(prepare(secondBase, "124", root), ["clear"]);
});

test("validates all alpha templates before writing any manifest", (t) => {
  const root = mkdtempSync(join(tmpdir(), "auto-release-templates-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgSign", "false");
  for (const kind of ["clear", "effort"]) {
    const dir = join(root, "packages", `pi-${kind}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: kind, version: "0.1.0-alpha.0" }));
  }
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const clear = join(root, "packages/pi-clear/package.json");
  const effort = join(root, "packages/pi-effort/package.json");
  writeFileSync(effort, JSON.stringify({ name: "effort", version: "0.1.0-alpha.123" }));
  git("add", ".");
  git("commit", "-m", "change");
  // Select both packages, with an invalid template after the valid one.
  writeFileSync(clear, JSON.stringify({ name: "clear", version: "0.1.0-alpha.0", description: "changed" }));
  git("add", ".");
  git("commit", "-m", "change clear");
  const before = readFileSync(clear, "utf8");
  assert.throws(() => prepare(base, "1", root), /alpha\.0 template/);
  assert.equal(readFileSync(clear, "utf8"), before);
  writeFileSync(effort, JSON.stringify({ name: "effort", version: "0.1.0-alpha.0" }));
  assert.deepEqual(prepare(base, "1", root), ["clear", "effort"]);
  assert.equal(JSON.parse(readFileSync(clear)).version, "0.1.0-alpha.1");
});
