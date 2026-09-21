import assert from "node:assert/strict";
import { test } from "node:test";

import {
  configLocation,
  enabledEntries,
  getActiveSkillEntries,
  getSkillCatalogDirs,
  looksLikePath,
  normalizeGitRemoteUrl,
  resolveRepoKey,
  runSkillsCommand,
  scopeFromArgs,
  sourceOf,
  updatePersistedSkill,
  usage,
} from "./skill-management-core.ts";

/**
 * Builds a fake {@link SkillEnvironment}. Nothing here touches the real filesystem or runs git, so the tests
 * stay deterministic and side-effect free.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.files] Seed file contents keyed by path.
 * @param {Record<string, string>} [options.git] Responses keyed by the joined git argument list.
 * @param {string[]} [options.catalog] Skill names to expose through the catalog.
 */
function createEnvironment({ files = {}, git = {}, catalog = [] } = {}) {
  /** @type {Map<string, string>} */
  const store = new Map(Object.entries(files));
  /** @type {{ path: string; contents: string | undefined }[]} */
  const writes = [];
  /** @type {import("./skill-management-core.ts").SkillEnvironment} */
  const env = {
    fs: {
      existsSync: (path) => store.has(path),
      mkdirSync: () => undefined,
      readFileSync: (path) => {
        const value = store.get(path);
        if (value === undefined) throw new Error(`ENOENT: ${path}`);
        return value;
      },
      realpathSync: (path) => path,
      renameSync: (from, to) => {
        const value = store.get(from);
        store.delete(from);
        if (value !== undefined) store.set(to, value);
        writes.push({ path: to, contents: value });
      },
      writeFileSync: (path, data) => store.set(path, data),
    },
    path: {
      dirname: (p) => p.split("/").slice(0, -1).join("/") || "/",
      isAbsolute: (p) => p.startsWith("/"),
      join: (...parts) => parts.join("/").replace(/\/+/g, "/"),
      relative: (from, to) => {
        const fromParts = from.split("/").filter(Boolean);
        const toParts = to.split("/").filter(Boolean);
        let shared = 0;
        while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) {
          shared += 1;
        }
        return [...Array.from({ length: fromParts.length - shared }, () => ".."), ...toParts.slice(shared)].join("/");
      },
      resolve: (...parts) => parts.join("/").replace(/\/+/g, "/"),
      sep: "/",
    },
    homedir: () => "/home/dev",
    execFileSync: (_file, args) => {
      const key = args.slice(2).join(" ");
      const response = git[key];
      if (response === undefined) throw new Error(`no stubbed git response for: ${key}`);
      return response;
    },
    processId: () => 4242,
    configDirName: ".pi",
    resolvePath: (input, baseDir) => (input.startsWith("/") ? input : `${baseDir}/${input.replace(/^\.\//, "")}`),
    loadSkillsFromDir: () => ({ skills: [] }),
    loadSkills: () => ({ skills: [] }),
    createSettingsManager: () => ({ isProjectTrusted: () => false }),
    resolvePackageResources: () =>
      Promise.resolve({
        skills: catalog.map((name) => ({
          enabled: true,
          path: `/pkg/${name}`,
          metadata: { origin: "package", source: "local" },
        })),
      }),
  };
  return { env, store, writes };
}

/**
 * Catalog entries come back through `loadSkills`, so route the stub through it.
 *
 * @param {import("./skill-management-core.ts").CatalogSkill[]} skills
 */
function withCatalog(skills) {
  const { env, store, writes } = createEnvironment({ catalog: skills.map((skill) => skill.name) });
  env.loadSkills = () => ({ skills });
  return { env, store, writes };
}

/**
 * Parses a file the test just wrote, failing loudly when it is missing.
 *
 * @param {Map<string, string>} store
 * @param {string} path
 */
function readStored(store, path) {
  const contents = store.get(path);
  assert.ok(contents !== undefined, `expected ${path} to have been written`);
  return JSON.parse(contents);
}

/**
 * Returns a command result's first output line, failing loudly when there is none.
 *
 * @param {import("./skill-management-core.ts").SkillCommandResult} result
 */
function firstLine(result) {
  const [line] = result.lines;
  assert.ok(line !== undefined, "expected at least one output line");
  return line;
}

test("normalizeGitRemoteUrl normalizes SCP-like, URL, and prefixed forms to one key", () => {
  const expected = "github.com:earendil-works/pi";
  for (const url of [
    "git@github.com:earendil-works/pi.git",
    "git@github.com:earendil-works/pi",
    "https://github.com/earendil-works/pi",
    "https://github.com/earendil-works/pi.git",
    "ssh://git@github.com/earendil-works/pi.git",
    "git+https://github.com/earendil-works/pi.git",
    "  https://github.com/earendil-works/pi.git  ",
  ]) {
    assert.equal(normalizeGitRemoteUrl(url), expected, url);
  }
});

test("normalizeGitRemoteUrl lowercases the host but preserves repository path case", () => {
  assert.equal(normalizeGitRemoteUrl("git@GitHub.com:Earendil-Works/Pi.git"), "github.com:Earendil-Works/Pi");
});

test("normalizeGitRemoteUrl normalizes default ports but keeps non-default ones distinct", () => {
  const canonical = "example.com:team/repo";
  assert.equal(normalizeGitRemoteUrl("ssh://git@example.com:22/team/repo.git"), canonical);
  assert.equal(normalizeGitRemoteUrl("git://example.com:9418/team/repo.git"), canonical);
  assert.equal(normalizeGitRemoteUrl("ssh://git@example.com/team/repo.git"), canonical);
  assert.equal(normalizeGitRemoteUrl("ssh://git@example.com:2222/team/repo.git"), "example.com:2222:team/repo");
});

test("normalizeGitRemoteUrl rejects empty and unparseable input", () => {
  for (const value of [undefined, "", "   ", "git+", "not a url"]) {
    assert.equal(normalizeGitRemoteUrl(value), undefined, String(value));
  }
});

test("resolveRepoKey prefers upstream, then origin, then the first remote", () => {
  const both = createEnvironment({
    git: {
      "remote get-url upstream": "git@github.com:upstream/repo.git",
      "remote get-url origin": "git@github.com:origin/repo.git",
    },
  });
  assert.equal(resolveRepoKey(both.env, "/work"), "github.com:upstream/repo");

  const originOnly = createEnvironment({
    git: { "remote get-url origin": "git@github.com:origin/repo.git" },
  });
  assert.equal(resolveRepoKey(originOnly.env, "/work"), "github.com:origin/repo");

  const namedOnly = createEnvironment({
    git: { remote: "fork\nbackup", "remote get-url fork": "git@github.com:fork/repo.git" },
  });
  assert.equal(resolveRepoKey(namedOnly.env, "/work"), "github.com:fork/repo");
});

test("resolveRepoKey falls back to a home-relative local key, then an absolute one", () => {
  const inHome = createEnvironment({ git: { "rev-parse --show-toplevel": "/home/dev/projects/app" } });
  assert.equal(resolveRepoKey(inHome.env, "/work"), "local:~/projects/app");

  const outsideHome = createEnvironment({ git: { "rev-parse --show-toplevel": "/srv/app" } });
  assert.equal(resolveRepoKey(outsideHome.env, "/work"), "local:/srv/app");
});

test("resolveRepoKey returns undefined outside a git repository", () => {
  const { env } = createEnvironment();
  assert.equal(resolveRepoKey(env, "/work"), undefined);
});

test("sourceOf reads strings and the source/path/name fields in precedence order", () => {
  assert.equal(sourceOf("plain"), "plain");
  assert.equal(sourceOf({ source: "a", path: "b", name: "c" }), "a");
  assert.equal(sourceOf({ path: "b", name: "c" }), "b");
  assert.equal(sourceOf({ name: "c" }), "c");
  for (const value of [undefined, null, 42, {}, { source: 7 }]) {
    assert.equal(sourceOf(value), undefined, JSON.stringify(value));
  }
});

test("enabledEntries tolerates malformed configuration shapes", () => {
  assert.deepEqual(enabledEntries({ enabled: ["a"] }), ["a"]);
  for (const value of [undefined, null, "string", [], { enabled: "no" }, {}]) {
    assert.deepEqual(enabledEntries(value), [], JSON.stringify(value));
  }
});

test("scopeFromArgs requires exactly one scope and honours session support", () => {
  assert.equal(scopeFromArgs(["skill", "--global"]), "global");
  assert.equal(scopeFromArgs(["skill", "--repo"]), "repo");
  assert.equal(scopeFromArgs(["skill", "--session"], true), "session");

  assert.throws(() => scopeFromArgs(["skill"]), /exactly one scope/);
  assert.throws(() => scopeFromArgs(["skill", "--global", "--repo"]), /exactly one scope/);
  assert.throws(() => scopeFromArgs(["skill", "--session"]), /exactly one scope/);
});

test("configLocation maps each scope to its configuration file", () => {
  const { env } = createEnvironment({ git: { "remote get-url upstream": "git@github.com:team/repo.git" } });
  assert.deepEqual(configLocation(env, "global", "/work", "/agent"), { path: "/agent/skills.json" });
  assert.deepEqual(configLocation(env, "repo", "/work", "/agent"), {
    path: "/agent/repo-skills.json",
    key: "github.com:team/repo",
  });
  assert.deepEqual(configLocation(env, "session", "/work", "/agent"), {});
});

test("configLocation rejects repository scope outside a git repository", () => {
  const { env } = createEnvironment();
  assert.throws(() => configLocation(env, "repo", "/work", "/agent"), /requires a git repository/);
});

test("updatePersistedSkill adds, deduplicates, and removes global entries", () => {
  const { env, store } = createEnvironment();
  const options = { cwd: "/work", agentDir: "/agent" };

  assert.equal(updatePersistedSkill(env, "add", "alpha", "global", options), true);
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["alpha"]);

  assert.equal(updatePersistedSkill(env, "add", "alpha", "global", options), true);
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["alpha"], "add is idempotent");

  assert.equal(updatePersistedSkill(env, "add", "beta", "global", options), true);
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["alpha", "beta"]);

  assert.equal(updatePersistedSkill(env, "remove", "alpha", "global", options), true);
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["beta"]);

  assert.equal(updatePersistedSkill(env, "remove", "absent", "global", options), false);
});

test("updatePersistedSkill scopes repository entries under the normalized repo key", () => {
  const { env, store } = createEnvironment({
    git: { "remote get-url upstream": "git@github.com:team/repo.git" },
  });
  assert.equal(updatePersistedSkill(env, "add", "alpha", "repo", { cwd: "/work", agentDir: "/agent" }), true);
  assert.deepEqual(readStored(store, "/agent/repo-skills.json"), {
    "github.com:team/repo": { enabled: ["alpha"] },
  });
});

test("updatePersistedSkill writes atomically through a pid-scoped temp file", () => {
  const { env, writes } = createEnvironment();
  updatePersistedSkill(env, "add", "alpha", "global", { cwd: "/work", agentDir: "/agent" });
  assert.deepEqual(
    writes.map((entry) => entry.path),
    ["/agent/skills.json"],
    "the temp file is renamed onto the target",
  );
});

test("getActiveSkillEntries reports global and repository scopes", () => {
  const { env } = createEnvironment({
    files: {
      "/agent/skills.json": JSON.stringify({ enabled: ["global-skill"] }),
      "/agent/repo-skills.json": JSON.stringify({
        "github.com:team/repo": { enabled: [{ source: "repo-skill" }] },
      }),
    },
    git: { "remote get-url upstream": "git@github.com:team/repo.git" },
  });

  assert.deepEqual(getActiveSkillEntries(env, { cwd: "/work", agentDir: "/agent" }), [
    { scope: "global", source: "global-skill" },
    { scope: "repo", source: "repo-skill" },
  ]);
});

test("getActiveSkillEntries warns on invalid configuration but throws when strict", () => {
  const files = { "/agent/skills.json": JSON.stringify(["not", "an", "object"]) };
  /** @type {string[]} */
  const warned = [];
  const lenient = createEnvironment({ files });
  assert.deepEqual(
    getActiveSkillEntries(lenient.env, {
      cwd: "/work",
      agentDir: "/agent",
      onWarn: (message) => warned.push(message),
    }),
    [],
  );
  assert.equal(warned.length, 1);
  assert.match(warned[0] ?? "", /Ignoring skill configuration/);

  const strict = createEnvironment({ files });
  assert.throws(
    () => getActiveSkillEntries(strict.env, { cwd: "/work", agentDir: "/agent", strict: true }),
    /Could not parse/,
  );
});

test("getSkillCatalogDirs adds project directories only when the project is trusted", () => {
  const { env } = createEnvironment();
  assert.deepEqual(getSkillCatalogDirs(env, { cwd: "/work", agentDir: "/agent" }), [
    "/agent/skills",
    "/home/dev/.agents/skills",
  ]);

  const trusted = createEnvironment({ git: { "rev-parse --show-toplevel": "/work" } });
  trusted.store.set("/work", "");
  const dirs = getSkillCatalogDirs(trusted.env, { cwd: "/work", agentDir: "/agent", projectTrusted: true });
  assert.ok(dirs.includes("/work/.pi/skills"), "includes the project config directory");
  assert.ok(dirs.includes("/work/.agents/skills"), "includes the project agent skills directory");
});

test("runSkillsCommand reports active skills and an empty state", async () => {
  const { env } = createEnvironment({
    files: { "/agent/skills.json": JSON.stringify({ enabled: ["alpha"] }) },
  });
  const active = await runSkillsCommand(env, ["active"], { cwd: "/work", agentDir: "/agent" });
  assert.equal(active.exitCode, 0);
  assert.deepEqual(active.lines, ["Active skills:", "  global: alpha"]);
  assert.deepEqual(active.activeEntries, [{ scope: "global", source: "alpha" }]);

  const empty = createEnvironment();
  const none = await runSkillsCommand(empty.env, ["active"], { cwd: "/work", agentDir: "/agent" });
  assert.deepEqual(none.lines, ["Skills: none"]);
});

test("runSkillsCommand lists and searches the catalog", async () => {
  const { env } = withCatalog([
    { name: "alpha", description: "First skill", filePath: "/pkg/alpha/SKILL.md" },
    { name: "beta", description: "Second skill", filePath: "/pkg/beta/SKILL.md" },
  ]);
  const options = { cwd: "/work", agentDir: "/agent" };

  const listed = await runSkillsCommand(env, ["list"], options);
  assert.deepEqual(listed.lines, ["alpha\tFirst skill", "beta\tSecond skill"]);

  const found = await runSkillsCommand(env, ["search", "second"], options);
  assert.deepEqual(found.lines, ["beta\tSecond skill"]);

  const missing = await runSkillsCommand(env, ["search", "nothing"], options);
  assert.deepEqual(missing.lines, ["No matching skills."]);
});

test("runSkillsCommand maps usage errors to exit code 1", async () => {
  const { env } = createEnvironment();
  const options = { cwd: "/work", agentDir: "/agent" };

  for (const args of [["active", "extra"], ["list", "extra"], ["search"]]) {
    const result = await runSkillsCommand(env, args, options);
    assert.equal(result.exitCode, 1, args.join(" "));
    assert.match(firstLine(result), /^Usage: pi skills/);
  }
});

test("runSkillsCommand returns usage for an unknown or missing subcommand", async () => {
  const { env } = createEnvironment();
  const options = { cwd: "/work", agentDir: "/agent" };

  for (const args of [[], ["bogus"]]) {
    const result = await runSkillsCommand(env, args, options);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.lines, usage(false));
  }
  const interactive = await runSkillsCommand(env, ["bogus"], { ...options, allowSession: true });
  assert.deepEqual(interactive.lines, usage(true));
  assert.ok(
    interactive.lines.some((line) => line.includes("reload")),
    "interactive usage documents reload",
  );
});

test("runSkillsCommand rejects add for a skill that is not in the catalog", async () => {
  const { env } = withCatalog([]);
  const result = await runSkillsCommand(env, ["add", "ghost", "--global"], { cwd: "/work", agentDir: "/agent" });
  assert.equal(result.exitCode, 1);
  assert.match(firstLine(result), /not found in the catalog/);
});

test("runSkillsCommand enables a catalog skill and reports removal of a disabled one", async () => {
  const { env, store } = withCatalog([{ name: "alpha", description: "First", filePath: "/pkg/alpha/SKILL.md" }]);
  const options = { cwd: "/work", agentDir: "/agent" };

  const added = await runSkillsCommand(env, ["add", "alpha", "--global"], options);
  assert.equal(added.exitCode, 0);
  assert.deepEqual(added.lines, ["Enabled alpha for global scope."]);
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["alpha"]);

  const removed = await runSkillsCommand(env, ["remove", "alpha", "--global"], options);
  assert.deepEqual(removed.lines, ["Disabled alpha for global scope."]);

  const again = await runSkillsCommand(env, ["remove", "alpha", "--global"], options);
  assert.equal(again.exitCode, 1);
  assert.match(firstLine(again), /not enabled for global scope/);
});

test("runSkillsCommand defers session scope to the caller instead of persisting it", async () => {
  const { env, store } = withCatalog([{ name: "alpha", description: "First", filePath: "/pkg/alpha/SKILL.md" }]);
  const result = await runSkillsCommand(env, ["add", "alpha", "--session"], {
    cwd: "/work",
    agentDir: "/agent",
    allowSession: true,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.session, { action: "add", source: "alpha" });
  assert.equal(store.has("/agent/skills.json"), false, "session scope writes nothing to disk");
});

test("runSkillsCommand rejects session scope on the non-interactive surface", async () => {
  const { env } = withCatalog([{ name: "alpha", description: "First", filePath: "/pkg/alpha/SKILL.md" }]);
  const result = await runSkillsCommand(env, ["add", "alpha", "--session"], { cwd: "/work", agentDir: "/agent" });
  assert.equal(result.exitCode, 1);
  // `--session` is not an allowed scope here, so scope parsing rejects it before any usage text is produced.
  assert.deepEqual(result.lines, ["Specify exactly one scope: --global or --repo."]);
});

test("runSkillsCommand rejects extra arguments alongside a scope", async () => {
  const { env } = withCatalog([{ name: "alpha", description: "First", filePath: "/pkg/alpha/SKILL.md" }]);
  const result = await runSkillsCommand(env, ["add", "alpha", "--global", "extra"], {
    cwd: "/work",
    agentDir: "/agent",
  });
  assert.equal(result.exitCode, 1);
  assert.match(firstLine(result), /Usage: pi skills add/);
});

test("looksLikePath distinguishes paths from catalog names", () => {
  for (const value of ["./skill", "../skill", "~/skill", "dir/skill", "dir\\skill", ".hidden"]) {
    assert.equal(looksLikePath(value), true, value);
  }
  for (const value of ["alpha", "alpha-beta", "alpha123"]) {
    assert.equal(looksLikePath(value), false, value);
  }
});

test("path sources resolve against the working directory before being persisted", async () => {
  const { env, store } = createEnvironment();
  env.fs.existsSync = (path) => path === "/work/skills/alpha";

  const result = await runSkillsCommand(env, ["add", "./skills/alpha", "--global"], {
    cwd: "/work",
    agentDir: "/agent",
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["/work/skills/alpha"]);
});
