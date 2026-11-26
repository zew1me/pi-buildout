import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, posix } from "node:path";
import { test } from "node:test";

import {
  configLocation,
  enabledEntries,
  expandEnvironmentVariables,
  getActiveSkillEntries,
  getSkillCatalogDirs,
  resolveActiveSkillPaths,
  looksLikePath,
  normalizeGitRemoteUrl,
  resolveDirectoryKey,
  resolveRepoKey,
  handleSkillsInteractive,
  runSkillsCommand,
  scopeFromArgs,
  sourceOf,
  withoutRepositoryGitEnvironment,
  updatePersistedSkill,
  usage,
} from "./skill-management-core.ts";

/** @param {string[]} args */
function gitCommand(args) {
  return args.slice(args[2] === "--git-dir=.git" ? 3 : 2).join(" ");
}

/**
 * Builds a fake {@link SkillEnvironment}. Nothing here touches the real filesystem or runs git, so the tests
 * stay deterministic and side-effect free.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.files] Seed file contents keyed by path.
 * @param {Record<string, string>} [options.git] Responses keyed by the joined git argument list.
 * @param {string[]} [options.catalog] Skill names to expose through the catalog.
 * @param {Record<string, string>} [options.variables] Environment variables visible to the module.
 */
function createEnvironment({ files = {}, git = {}, catalog = [], variables = {} } = {}) {
  /** @type {Map<string, string>} */
  const store = new Map(Object.entries(files));
  /** @type {{ path: string; contents: string | undefined }[]} */
  const writes = [];
  /** @type {{ lockfilePath: string; held: boolean }[]} */
  const locks = [];
  /** @type {number[]} */
  const sleeps = [];
  /** @type {string[]} */
  const reported = [];
  /** @type {import("./skill-management-core.ts").SkillEnvironment} */
  const env = {
    fs: {
      existsSync: (path) => store.has(path),
      isDirectory: (path) => env.fs.existsSync(path),
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
    environmentVariable: (name) => (Object.hasOwn(variables, name) ? variables[name] : undefined),
    execFileSync: (_file, args) => {
      const key = gitCommand(args);
      const response = git[key];
      if (response === undefined) throw nonRepositoryError();
      return response;
    },
    processId: () => 4242,
    lockSync: (_directory, { lockfilePath }) => {
      const lock = { lockfilePath, held: true };
      locks.push(lock);
      return () => {
        lock.held = false;
      };
    },
    sleepSync: (milliseconds) => sleeps.push(milliseconds),
    reportError: (message) => reported.push(message),
    configDirName: ".pi",
    // Mirrors Pi's `resolvePath`: `~` expands to the home directory, and only that.
    resolvePath: (input, baseDir) => {
      const expanded = input.replace(/^~(?=\/|$)/, "/home/dev");
      return expanded.startsWith("/") ? expanded : `${baseDir}/${expanded.replace(/^\.\//, "")}`;
    },
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
  return { env, store, writes, locks, sleeps, reported };
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
 * Serves `local` from `loadSkills` only when it is asked about one of those paths, the way Pi's loader reads
 * just the paths it is given. Any other call falls through to `fallback`.
 *
 * @param {import("./skill-management-core.ts").SkillEnvironment} env
 * @param {Record<string, import("./skill-management-core.ts").CatalogSkill[]>} local Skills keyed by path.
 */
function withLocalSkills(env, local) {
  const fallback = env.loadSkills;
  env.loadSkills = (options) => {
    const [path] = options.skillPaths;
    if (options.skillPaths.length === 1 && path !== undefined && path in local) return { skills: local[path] ?? [] };
    return fallback(options);
  };
}

const localSkill = { name: "local-skill", description: "local skill", filePath: "/work/local-skill/SKILL.md" };

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

function nonRepositoryError() {
  return Object.assign(new Error("not a git repository"), {
    status: 128,
    stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
  });
}

test("repository subprocesses clear mixed-case Git overrides only on Windows", () => {
  const inherited = {
    GIT_DIR: "main",
    gIt_Work_Tree: "main",
    git_config_count: "2",
    GIT_TRACE: "1",
    PATH: "/usr/bin",
  };
  assert.deepEqual(withoutRepositoryGitEnvironment(inherited, true), { GIT_TRACE: "1", PATH: "/usr/bin" });
  assert.deepEqual(withoutRepositoryGitEnvironment(inherited, false), {
    gIt_Work_Tree: "main",
    git_config_count: "2",
    GIT_TRACE: "1",
    PATH: "/usr/bin",
  });
  assert.equal(inherited.GIT_DIR, "main", "the caller environment is unchanged");
});

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
  assert.equal(scopeFromArgs(["skill", "--directory"]), "directory");
  assert.equal(scopeFromArgs(["skill", "--session"], true), "session");

  assert.throws(() => scopeFromArgs(["skill"]), /exactly one scope/);
  assert.throws(() => scopeFromArgs(["skill", "--global", "--repo"]), /exactly one scope/);
  assert.throws(() => scopeFromArgs(["skill", "--repo", "--directory"]), /exactly one scope/);
  assert.throws(() => scopeFromArgs(["skill", "--session"]), /exactly one scope/);
  assert.throws(() => scopeFromArgs(["skill"], true), {
    message: "Specify exactly one scope: --global, --repo, --directory, or --session.",
  });
});

test("usage lists the directory scope on both surfaces", () => {
  assert.ok(usage(false).includes("  pi skills add <skill-or-path> --global|--repo|--directory"));
  assert.ok(usage(true).includes("  /skills remove <skill-or-path> --global|--repo|--directory|--session"));
});

test("configLocation maps each scope to its configuration file", () => {
  const { env } = createEnvironment({ git: { "remote get-url upstream": "git@github.com:team/repo.git" } });
  assert.deepEqual(configLocation(env, "global", "/work", "/agent"), { path: "/agent/skills.json" });
  assert.deepEqual(configLocation(env, "repo", "/work", "/agent"), {
    path: "/agent/repo-skills.json",
    key: "github.com:team/repo",
  });
  assert.deepEqual(configLocation(env, "directory", "/work", "/agent"), {
    path: "/agent/directory-skills.json",
    key: "/work",
  });
  assert.deepEqual(configLocation(env, "session", "/work", "/agent"), {});
});

test("resolveDirectoryKey uses the checkout or worktree root, else the working directory", () => {
  const { env } = createEnvironment();
  withCheckouts(env, {
    "/home/dev/app": "/home/dev/app",
    "/home/dev/app/src": "/home/dev/app",
    "/home/dev/worktrees/feature/src": "/home/dev/worktrees/feature",
  });

  assert.equal(resolveDirectoryKey(env, "/home/dev/app/src"), "/home/dev/app", "a subdirectory keys by its root");
  assert.equal(
    resolveDirectoryKey(env, "/home/dev/worktrees/feature/src"),
    "/home/dev/worktrees/feature",
    "a worktree keys by its own root, not by the remote it shares",
  );
  assert.equal(resolveDirectoryKey(env, "/tmp/scratch"), "/tmp/scratch", "outside a repository the cwd is the key");
});

test("Git checkout keys preserve trailing whitespace in the root", () => {
  const plain = createEnvironment({ git: { "rev-parse --show-toplevel": "/home/dev/app\n" } });
  const spaced = createEnvironment({ git: { "rev-parse --show-toplevel": "/home/dev/app \n" } });

  assert.equal(resolveDirectoryKey(plain.env, "/home/dev/app/src"), "/home/dev/app");
  assert.equal(resolveDirectoryKey(spaced.env, "/home/dev/app /src"), "/home/dev/app ");
  // This is the on-disk repo key used by versions that trimmed all rev-parse output.
  assert.equal(resolveRepoKey(spaced.env, "/home/dev/app /src"), "local:~/app");
});

test("resolveDirectoryKey keys a base reached through a symlink by its real path", () => {
  const { env } = createEnvironment({ files: { "/private/tmp/scratch": "" } });
  env.fs.realpathSync = (path) => (path === "/tmp/scratch" ? "/private/tmp/scratch" : path);
  env.fs.existsSync = (path) => path === "/tmp/scratch" || path === "/private/tmp/scratch";

  assert.equal(resolveDirectoryKey(env, "/tmp/scratch"), "/private/tmp/scratch");
  assert.equal(resolveDirectoryKey(env, "/private/tmp/scratch"), "/private/tmp/scratch");
});

test("resolveDirectoryKey falls back to the unresolved base when it disappears before realpath", () => {
  const { env } = createEnvironment({ files: { "/tmp/scratch": "" } });
  env.fs.realpathSync = () => {
    throw new Error("ENOENT: /tmp/scratch");
  };

  assert.equal(resolveDirectoryKey(env, "/tmp/scratch"), "/tmp/scratch");
});

test("directory scope works outside a git repository, where repository scope cannot", () => {
  const { env } = createEnvironment();
  assert.throws(() => configLocation(env, "repo", "/scratch", "/agent"), /requires a git repository/);
  assert.equal(configLocation(env, "directory", "/scratch", "/agent").key, "/scratch");
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

test("worktrees of one repository share repository entries but keep separate directory entries", () => {
  const { env, store } = createEnvironment({ files: { "/home/dev/app": "", "/home/dev/worktrees/feature": "" } });
  withCheckouts(env, {
    "/home/dev/app": "/home/dev/app",
    "/home/dev/worktrees/feature": "/home/dev/worktrees/feature",
  });
  const main = { cwd: "/home/dev/app", agentDir: "/agent" };
  const feature = { cwd: "/home/dev/worktrees/feature", agentDir: "/agent" };

  assert.equal(updatePersistedSkill(env, "add", "shared", "repo", main), true);
  assert.equal(updatePersistedSkill(env, "add", "main-only", "directory", main), true);
  assert.equal(updatePersistedSkill(env, "add", "feature-only", "directory", feature), true);

  assert.deepEqual(readStored(store, "/agent/directory-skills.json"), {
    "/home/dev/app": { enabled: ["main-only"] },
    "/home/dev/worktrees/feature": { enabled: ["feature-only"] },
  });
  assert.deepEqual(getActiveSkillEntries(env, main), [
    { scope: "repo", source: "shared" },
    { scope: "directory", source: "main-only" },
  ]);
  assert.deepEqual(getActiveSkillEntries(env, feature), [
    { scope: "repo", source: "shared" },
    { scope: "directory", source: "feature-only" },
  ]);
});

test("removing the last directory entry drops its key, and other keys are never pruned", () => {
  const { env, store } = createEnvironment({
    files: {
      "/agent/directory-skills.json": JSON.stringify({
        "/gone/elsewhere": { enabled: ["stale"] },
        "/work": { enabled: ["alpha"] },
      }),
    },
  });
  const options = { cwd: "/work", agentDir: "/agent" };

  assert.equal(updatePersistedSkill(env, "remove", "alpha", "directory", options), true);
  assert.deepEqual(
    readStored(store, "/agent/directory-skills.json"),
    { "/gone/elsewhere": { enabled: ["stale"] } },
    "a key for a missing directory is inert and kept",
  );
  assert.equal(updatePersistedSkill(env, "remove", "alpha", "directory", options), false);
});

test("directory removal does not re-evaluate a stored alias after it matches", async () => {
  const config = "/agent/directory-skills.json";
  const { env, store } = createEnvironment({
    files: {
      [config]: JSON.stringify({ "/work": { enabled: ["./alias", "keep"] } }),
      "/work": "",
      "/work/alias": "",
      "/work/skill": "",
    },
  });
  env.path.resolve = posix.resolve;
  let resolutions = 0;
  env.fs.realpathSync = (path) => {
    if (path !== "/work/alias") return path;
    resolutions += 1;
    return resolutions === 1 ? "/work/skill" : "/work/retargeted";
  };

  const result = await runSkillsCommand(env, ["remove", "./skill", "--directory"], {
    cwd: "/work",
    agentDir: "/agent",
  });
  assert.equal(result.exitCode, 0, result.lines.join("\n"));
  assert.deepEqual(readStored(store, config)["/work"].enabled, ["keep"]);
  assert.equal(resolutions, 1);
});

test("updatePersistedSkill locks the directory configuration under its own lock file", () => {
  const { env, locks } = createEnvironment({ files: { "/work": "" } });
  updatePersistedSkill(env, "add", "alpha", "directory", { cwd: "/work", agentDir: "/agent" });
  assert.deepEqual(locks, [{ lockfilePath: "/agent/directory-skills.json.lock", held: false }]);
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

/**
 * An error shaped like the ones `proper-lockfile` throws.
 *
 * @param {string} code
 */
function lockError(code) {
  return Object.assign(new Error(`lock failed: ${code}`), { code });
}

test("updatePersistedSkill holds the configuration lock across the whole read-modify-write", () => {
  const { env, store, locks } = createEnvironment();
  const readFileSync = env.fs.readFileSync;
  const renameSync = env.fs.renameSync;
  /** @type {boolean[]} */
  const heldDuring = [];
  env.fs.readFileSync = (path, encoding) => {
    heldDuring.push(locks.at(-1)?.held === true);
    return readFileSync(path, encoding);
  };
  env.fs.renameSync = (from, to) => {
    heldDuring.push(locks.at(-1)?.held === true);
    renameSync(from, to);
  };
  store.set("/agent/skills.json", JSON.stringify({ enabled: ["alpha"] }));

  assert.equal(updatePersistedSkill(env, "add", "beta", "global", { cwd: "/work", agentDir: "/agent" }), true);
  assert.deepEqual(heldDuring, [true, true], "the read and the rename both happen under the lock");
  assert.deepEqual(locks, [{ lockfilePath: "/agent/skills.json.lock", held: false }], "the lock is released");
});

test("updatePersistedSkill retries while another process holds the lock", () => {
  const { env, store, sleeps } = createEnvironment();
  const lockSync = env.lockSync;
  let attempts = 0;
  env.lockSync = (directory, options) => {
    attempts += 1;
    if (attempts < 3) throw lockError("ELOCKED");
    return lockSync(directory, options);
  };

  assert.equal(updatePersistedSkill(env, "add", "alpha", "global", { cwd: "/work", agentDir: "/agent" }), true);
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [20, 20], "waits between attempts instead of spinning");
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["alpha"]);
});

test("directory add does not write if its base disappears while waiting for the lock", async () => {
  const config = "/agent/directory-skills.json";
  const before = JSON.stringify({ "/work": { enabled: ["old"] }, "/other": { enabled: ["untouched"] } });
  const { env, store, locks, writes } = createEnvironment({
    files: { [config]: before, "/work": "", "/skills/new": "" },
  });
  const lockSync = env.lockSync;
  let attempts = 0;
  env.lockSync = (directory, options) => {
    attempts += 1;
    if (attempts === 1) throw lockError("ELOCKED");
    return lockSync(directory, options);
  };
  env.sleepSync = () => {
    store.delete("/work");
  };
  const options = { cwd: "/work", agentDir: "/agent" };
  const add = await runSkillsCommand(env, ["add", "/skills/new", "--directory"], options);
  assert.equal(add.exitCode, 1);
  assert.match(add.lines[0] ?? "", /Directory scope base is unavailable: \/work/);
  assert.equal(attempts, 2);
  assert.equal(locks[0]?.held, false);
  assert.equal(store.get(config), before);
  assert.deepEqual(writes, []);

  const remove = await runSkillsCommand(env, ["remove", "old", "--directory"], options);
  assert.equal(remove.exitCode, 0, remove.lines.join("\n"));
  assert.deepEqual(readStored(store, config), { "/other": { enabled: ["untouched"] } });
});

test("updatePersistedSkill gives up on a lock that stays held, and never retries other lock errors", () => {
  const options = { cwd: "/work", agentDir: "/agent" };

  const held = createEnvironment();
  let heldAttempts = 0;
  held.env.lockSync = () => {
    heldAttempts += 1;
    throw lockError("ELOCKED");
  };
  assert.throws(() => updatePersistedSkill(held.env, "add", "alpha", "global", options), { code: "ELOCKED" });
  assert.equal(heldAttempts, 100);
  assert.equal(held.store.has("/agent/skills.json"), false, "nothing is written without the lock");

  const denied = createEnvironment();
  let deniedAttempts = 0;
  denied.env.lockSync = () => {
    deniedAttempts += 1;
    throw lockError("EACCES");
  };
  assert.throws(() => updatePersistedSkill(denied.env, "add", "alpha", "global", options), { code: "EACCES" });
  assert.equal(deniedAttempts, 1);
  assert.deepEqual(denied.sleeps, []);
});

test("updatePersistedSkill releases the lock when the update fails", () => {
  const { env, store, locks } = createEnvironment();
  store.set("/agent/skills.json", "not json");

  assert.throws(
    () => updatePersistedSkill(env, "add", "alpha", "global", { cwd: "/work", agentDir: "/agent" }),
    /Could not parse \/agent\/skills\.json/,
  );
  assert.equal(locks.length, 1);
  assert.equal(locks[0]?.held, false);
});

/** Releases nothing and fails, the way a compromised `proper-lockfile` lock does. */
function throwingRelease() {
  throw new Error("lock compromised");
}

/** Takes a lock whose release fails. */
function failingRelease() {
  return throwingRelease;
}

test("a failed lock release is reported without replacing the update's result or error", () => {
  const options = { cwd: "/work", agentDir: "/agent" };

  const succeeded = createEnvironment();
  succeeded.env.lockSync = failingRelease;
  assert.equal(updatePersistedSkill(succeeded.env, "add", "alpha", "global", options), true);
  assert.deepEqual(readStored(succeeded.store, "/agent/skills.json").enabled, ["alpha"]);
  assert.deepEqual(succeeded.reported, [
    "Could not release skill configuration lock /agent/skills.json: lock compromised",
  ]);

  const failed = createEnvironment({ files: { "/agent/skills.json": "not json" } });
  failed.env.lockSync = failingRelease;
  assert.throws(() => updatePersistedSkill(failed.env, "add", "alpha", "global", options), /Could not parse/);
  assert.equal(failed.reported.length, 1);
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

test("active shows distinct removal operands for checkout-relative entries from a subdirectory", async () => {
  const { env, store } = createEnvironment({
    files: {
      "/work": "",
      "/agent/directory-skills.json": JSON.stringify({
        "/work": { enabled: ["skills/review", "sub/skills/review"] },
      }),
    },
  });
  withCheckouts(env, { "/work/sub": "/work" });
  const options = { cwd: "/work/sub", agentDir: "/agent" };
  const result = await runSkillsCommand(env, ["active"], options);
  assert.deepEqual(result.lines, [
    "Active skills:",
    "  directory: /work/skills/review",
    "  directory: /work/sub/skills/review",
  ]);

  const { context, calls } = createInteractiveContext(env);
  context.cwd = options.cwd;
  await handleSkillsInteractive(env, "/skills active", context);
  assert.deepEqual(calls.output, [result.lines.join("\n")]);

  const operand = result.lines[1]?.replace("  directory: ", "") ?? "";
  const removed = await runSkillsCommand(env, ["remove", operand, "--directory"], options);
  assert.equal(removed.exitCode, 0, removed.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/directory-skills.json")["/work"].enabled, ["sub/skills/review"]);
});

test("resolveActiveSkillPaths reuses package resources resolved by the resource loader", async () => {
  const { env, store } = withCatalog([{ name: "alpha", description: "First", filePath: "/pkg/alpha/SKILL.md" }]);
  store.set("/agent/skills.json", JSON.stringify({ enabled: ["alpha"] }));
  let packageResolutions = 0;
  env.resolvePackageResources = async () => {
    packageResolutions += 1;
    throw new Error("should reuse the resource loader's package resolution");
  };

  const result = await resolveActiveSkillPaths(env, {
    cwd: "/work",
    agentDir: "/agent",
    resolvedSkillResources: [{ enabled: true, path: "/pkg/alpha", metadata: { origin: "package", source: "local" } }],
    resolveResourcePath: (path) => path,
  });

  assert.deepEqual(result, { paths: ["/pkg/alpha/SKILL.md"], diagnostics: [] });
  assert.equal(packageResolutions, 0);
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
  assert.deepEqual(result.session, { action: "add", path: "/pkg/alpha/SKILL.md" });
  assert.equal(store.has("/agent/skills.json"), false, "session scope writes nothing to disk");
});

test("runSkillsCommand rejects session scope on the non-interactive surface", async () => {
  const { env } = withCatalog([{ name: "alpha", description: "First", filePath: "/pkg/alpha/SKILL.md" }]);
  const result = await runSkillsCommand(env, ["add", "alpha", "--session"], { cwd: "/work", agentDir: "/agent" });
  assert.equal(result.exitCode, 1);
  // `--session` is not an allowed scope here, so scope parsing rejects it before any usage text is produced.
  assert.deepEqual(result.lines, ["Specify exactly one scope: --global, --repo, or --directory."]);
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
  for (const value of [
    "./skill",
    "../skill",
    "~/skill",
    "dir/skill",
    "dir\\skill",
    ".hidden",
    "$SKILL_DIR",
    "${SKILLS}",
  ]) {
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

test("expandEnvironmentVariables expands bare and braced references and reports unset ones", () => {
  const { env } = createEnvironment({ variables: { HOME: "/home/dev", SKILLS: "/opt/skills", EMPTY: "" } });

  assert.deepEqual(expandEnvironmentVariables(env, "$HOME/skills/alpha"), {
    value: "/home/dev/skills/alpha",
    unset: [],
  });
  assert.deepEqual(expandEnvironmentVariables(env, "${SKILLS}/alpha"), { value: "/opt/skills/alpha", unset: [] });
  assert.deepEqual(expandEnvironmentVariables(env, "${SKILLS}x/$EMPTY/y"), { value: "/opt/skillsx//y", unset: [] });
  assert.deepEqual(expandEnvironmentVariables(env, "$MISSING/a/${MISSING}/$OTHER"), {
    value: "$MISSING/a/${MISSING}/$OTHER",
    unset: ["MISSING", "OTHER"],
  });
  for (const literal of ["/tmp/price$", "/tmp/$1", "/tmp/${not valid}", "/tmp/plain"]) {
    assert.deepEqual(expandEnvironmentVariables(env, literal), { value: literal, unset: [] }, literal);
  }
});

test("~ and variable spellings are persisted as typed and deduplicate by the path they name", async () => {
  const { env, store } = createEnvironment({ variables: { HOME: "/home/dev", REPOS: "/home/dev/repos" } });
  const existing = new Set(["/home/dev/skills/alpha", "/home/dev/repos/app/.agents/skills/beta/SKILL.md"]);
  env.fs.existsSync = (path) => existing.has(path) || store.has(path);
  const options = { cwd: "/work", agentDir: "/agent" };

  for (const source of ["~/skills/alpha", "$HOME/skills/alpha", "${REPOS}/app/.agents/skills/beta/SKILL.md"]) {
    const result = await runSkillsCommand(env, ["add", source, "--global"], options);
    assert.equal(result.exitCode, 0, result.lines.join("\n"));
  }
  assert.deepEqual(
    readStored(store, "/agent/skills.json").enabled,
    ["~/skills/alpha", "${REPOS}/app/.agents/skills/beta/SKILL.md"],
    "spellings are kept for expansion at load time, and an equivalent spelling is not added twice",
  );

  const removed = await runSkillsCommand(env, ["remove", "$HOME/skills/alpha", "--global"], options);
  assert.equal(removed.exitCode, 0, removed.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["${REPOS}/app/.agents/skills/beta/SKILL.md"]);
});

test("a $PWD or $OLDPWD spelling is persisted as the absolute path it named", async () => {
  const { env, store } = createEnvironment({ variables: { PWD: "/srv/project", OLDPWD: "/srv/previous" } });
  env.fs.existsSync = (path) =>
    path === "/srv/project/skills/alpha" || path === "/srv/previous/beta" || store.has(path);

  for (const source of ["$PWD/skills/alpha", "${OLDPWD}/beta"]) {
    const result = await runSkillsCommand(env, ["add", source, "--global"], { cwd: "/work", agentDir: "/agent" });
    assert.equal(result.exitCode, 0, result.lines.join("\n"));
  }
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, [
    "/srv/project/skills/alpha",
    "/srv/previous/beta",
  ]);
});

test("other global paths are persisted absolute, under ~ when they are in the home directory", async () => {
  const { env, store } = createEnvironment({
    git: { "rev-parse --show-toplevel": "/home/dev/repos/app" },
  });
  const existing = new Set(["/home/dev/work/skills/alpha", "/home/dev/repos/app/.agents/skills/beta", "/srv/gamma"]);
  env.fs.existsSync = (path) => existing.has(path) || store.has(path);

  /** @type {[cwd: string, source: string][]} */
  const cases = [
    ["/home/dev/work", "./skills/alpha"],
    ["/home/dev/repos/app", ".agents/skills/beta"],
    ["/srv", "./gamma"],
  ];
  for (const [cwd, source] of cases) {
    const result = await runSkillsCommand(env, ["add", source, "--global"], { cwd, agentDir: "/agent" });
    assert.equal(result.exitCode, 0, result.lines.join("\n"));
  }
  assert.deepEqual(
    readStored(store, "/agent/skills.json").enabled,
    ["~/work/skills/alpha", "~/repos/app/.agents/skills/beta", "/srv/gamma"],
    "a global path inside a repository is not stored repository-relative",
  );
});

/**
 * Stubs git for a repository whose checkouts live at different roots, as clones and worktrees do.
 *
 * @param {import("./skill-management-core.ts").SkillEnvironment} env
 * @param {Record<string, string>} roots Checkout root keyed by every working directory used in the test.
 */
function withCheckouts(env, roots) {
  env.execFileSync = (_file, args) => {
    const cwd = args[1] ?? "";
    const command = gitCommand(args);
    if (command === "remote get-url upstream") return "git@github.com:team/app.git";
    if (command === "rev-parse --show-toplevel" && roots[cwd] !== undefined) return roots[cwd];
    throw nonRepositoryError();
  };
}

test("a repository path inside the checkout is persisted relative to the checkout root", async () => {
  const { env, store } = createEnvironment();
  withCheckouts(env, { "/home/dev/app": "/home/dev/app", "/home/dev/app/docs": "/home/dev/app" });
  const existing = new Set([
    "/home/dev/app/.agents/skills/alpha",
    "/home/dev/app/beta",
    "/home/dev/shared/gamma",
    "/home/dev/app/docs/delta",
  ]);
  env.fs.existsSync = (path) => existing.has(path) || store.has(path);

  /** @type {[cwd: string, source: string][]} */
  const cases = [
    ["/home/dev/app", ".agents/skills/alpha"],
    ["/home/dev/app", "~/app/beta"],
    ["/home/dev/app", "~/shared/gamma"],
    ["/home/dev/app/docs", "./delta"],
  ];
  for (const [cwd, source] of cases) {
    const result = await runSkillsCommand(env, ["add", source, "--repo"], { cwd, agentDir: "/agent" });
    assert.equal(result.exitCode, 0, result.lines.join("\n"));
  }

  assert.deepEqual(readStored(store, "/agent/repo-skills.json")["github.com:team/app"].enabled, [
    ".agents/skills/alpha",
    "./beta",
    "~/shared/gamma",
    "docs/delta",
  ]);
});

test("a repository-relative entry resolves in, and is removable from, any checkout of the repository", async () => {
  const { env, store } = createEnvironment({
    files: {
      "/agent/repo-skills.json": JSON.stringify({ "github.com:team/app": { enabled: [".agents/skills/alpha"] } }),
      "/home/dev/worktrees/feature/.agents/skills/alpha": "",
    },
  });
  withCheckouts(env, {
    "/home/dev/worktrees/feature": "/home/dev/worktrees/feature",
    "/home/dev/worktrees/feature/src": "/home/dev/worktrees/feature",
  });

  const resolved = await resolveActiveSkillPaths(env, {
    cwd: "/home/dev/worktrees/feature/src",
    agentDir: "/agent",
    resolvedSkillResources: [],
    resolveResourcePath: (path) => env.resolvePath(path, "/home/dev/worktrees/feature/src", { trim: true }),
  });
  assert.deepEqual(resolved, { paths: ["/home/dev/worktrees/feature/.agents/skills/alpha"], diagnostics: [] });

  const removed = await runSkillsCommand(
    env,
    ["remove", "/home/dev/worktrees/feature/.agents/skills/alpha", "--repo"],
    {
      cwd: "/home/dev/worktrees/feature/src",
      agentDir: "/agent",
    },
  );
  assert.equal(removed.exitCode, 0, removed.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/repo-skills.json")["github.com:team/app"].enabled, []);
});

test("a directory path is persisted relative to its base and resolves from any subdirectory", async () => {
  const { env, store } = createEnvironment();
  withCheckouts(env, { "/home/dev/app": "/home/dev/app", "/home/dev/app/docs": "/home/dev/app" });
  const existing = new Set(["/home/dev/app", "/home/dev/app/docs/delta", "/home/dev/shared/gamma"]);
  env.fs.existsSync = (path) => existing.has(path) || store.has(path);

  for (const source of ["./delta", "~/shared/gamma"]) {
    const result = await runSkillsCommand(env, ["add", source, "--directory"], {
      cwd: "/home/dev/app/docs",
      agentDir: "/agent",
    });
    assert.equal(result.exitCode, 0, result.lines.join("\n"));
    assert.deepEqual(result.lines, [`Enabled ${source} for directory scope.`]);
  }
  assert.deepEqual(readStored(store, "/agent/directory-skills.json"), {
    "/home/dev/app": { enabled: ["docs/delta", "~/shared/gamma"] },
  });

  const resolved = await resolveActiveSkillPaths(env, {
    cwd: "/home/dev/app",
    agentDir: "/agent",
    resolvedSkillResources: [],
    resolveResourcePath: (path) => env.resolvePath(path, "/home/dev/app", { trim: true }),
  });
  assert.deepEqual(resolved, { paths: ["/home/dev/app/docs/delta", "/home/dev/shared/gamma"], diagnostics: [] });

  const removed = await runSkillsCommand(env, ["remove", "/home/dev/app/docs/delta", "--directory"], {
    cwd: "/home/dev/app",
    agentDir: "/agent",
  });
  assert.equal(removed.exitCode, 0, removed.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/directory-skills.json")["/home/dev/app"].enabled, ["~/shared/gamma"]);
});

test("directory-relative persistence preserves a literal tilde and avoids expanding a variable twice", async () => {
  const { env, store } = createEnvironment({
    files: { "/work": "", "/work/~/skill": "", "/work/$LITERAL/skill": "" },
    variables: { SKILL_PATH: "/work/$LITERAL/skill", LITERAL: "different" },
  });
  env.path.resolve = posix.resolve;
  const options = { cwd: "/work", agentDir: "/agent" };
  for (const source of ["./~/skill", "$SKILL_PATH"]) {
    const result = await runSkillsCommand(env, ["add", source, "--directory"], options);
    assert.equal(result.exitCode, 0, result.lines.join("\n"));
  }
  assert.deepEqual(readStored(store, "/agent/directory-skills.json")["/work"].enabled, ["./~/skill", "$SKILL_PATH"]);
  assert.deepEqual(await resolveActiveSkillPaths(env, { ...options, resolveResourcePath: (path) => path }), {
    paths: ["/work/~/skill", "/work/$LITERAL/skill"],
    diagnostics: [],
  });
  const removed = await runSkillsCommand(env, ["remove", "$SKILL_PATH", "--directory"], options);
  assert.equal(removed.exitCode, 0, removed.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/directory-skills.json")["/work"].enabled, ["./~/skill"]);
});

test("a generated relative spelling with an unset variable keeps the typed variable spelling", async () => {
  const { env, store } = createEnvironment({
    files: { "/work": "", "/work/$LITERAL/skill": "" },
    variables: { SKILL_PATH: "/work/$LITERAL/skill" },
  });
  env.path.resolve = posix.resolve;
  const result = await runSkillsCommand(env, ["add", "$SKILL_PATH", "--directory"], {
    cwd: "/work",
    agentDir: "/agent",
  });
  assert.equal(result.exitCode, 0, result.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/directory-skills.json")["/work"].enabled, ["$SKILL_PATH"]);
});

test("a fallback spelling whose literal variable is set now is rejected rather than stored", async () => {
  const { env, store } = createEnvironment({
    files: { "/work/$LITERAL/skill": "" },
    variables: { PWD: "/work/$LITERAL", LITERAL: "other" },
  });
  env.path.resolve = posix.resolve;
  const result = await runSkillsCommand(env, ["add", "$PWD/skill", "--global"], { cwd: "/work", agentDir: "/agent" });
  assert.equal(result.exitCode, 1);
  assert.match(firstLine(result), /environment variable reference that would expand/);
  assert.equal(store.has("/agent/skills.json"), false);
});

test("a directory-relative spelling that starts with whitespace keeps its ./ prefix", async () => {
  const { env, store } = createEnvironment({ files: { "/work": "", "/work/ notes/SKILL.md": "" } });
  env.path.resolve = posix.resolve;
  const options = { cwd: "/work", agentDir: "/agent" };
  const result = await runSkillsCommand(env, ["add", "./ notes/SKILL.md", "--directory"], options);
  assert.equal(result.exitCode, 0, result.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/directory-skills.json")["/work"].enabled, ["./ notes/SKILL.md"]);
  assert.deepEqual(await resolveActiveSkillPaths(env, { ...options, resolveResourcePath: (path) => path }), {
    paths: ["/work/ notes/SKILL.md"],
    diagnostics: [],
  });
});

test("a generated directory spelling cannot turn a trailing-space alias target into a different skill", async () => {
  const alias = "/home/dev/work/alias";
  const near = "/home/dev/work/skills/review";
  const real = `${near} `;
  const { env, store } = createEnvironment({
    files: { "/home/dev/work": "", [alias]: "", [near]: "", [real]: "" },
  });
  env.path.resolve = posix.resolve;
  env.fs.realpathSync = (path) => (path === alias ? real : path);
  const options = { cwd: "/home/dev/work", agentDir: "/agent" };
  const add = await runSkillsCommand(env, ["add", "./alias", "--directory"], options);
  assert.equal(add.exitCode, 0, add.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/directory-skills.json")[options.cwd].enabled, [alias]);
  const active = await resolveActiveSkillPaths(env, { ...options, resolveResourcePath: (path) => path.trim() });
  assert.deepEqual(active.paths, [alias]);
  assert.equal((await runSkillsCommand(env, ["remove", near, "--directory"], options)).exitCode, 1);
  assert.equal((await runSkillsCommand(env, ["remove", "./alias", "--directory"], options)).exitCode, 0);
});

test("a directory mutation formats, matches, and stores under one base lookup", async () => {
  const { env, store } = createEnvironment({ files: { "/work/sub": "", "/work/sub/skills/review": "" } });
  env.path.resolve = posix.resolve;
  let lookups = 0;
  env.execFileSync = (_file, args) => {
    const key = args.slice(2).join(" ");
    if (key !== "rev-parse --show-toplevel") throw new Error(`no stubbed git response for: ${key}`);
    lookups += 1;
    // A checkout appears at /work after the first lookup.
    if (lookups === 1) throw nonRepositoryError();
    return "/work";
  };
  const result = await runSkillsCommand(env, ["add", "./skills/review", "--directory"], {
    cwd: "/work/sub",
    agentDir: "/agent",
  });
  assert.equal(result.exitCode, 0, result.lines.join("\n"));
  assert.equal(lookups, 1);
  assert.deepEqual(readStored(store, "/agent/directory-skills.json"), {
    "/work/sub": { enabled: ["skills/review"] },
  });
});

test("directory mutations do not fall back to a subdirectory when Git times out", async () => {
  const { env, store, writes } = createEnvironment({ files: { "/work/app": "", "/work/app/docs/skill": "" } });
  env.path.resolve = posix.resolve;
  env.execFileSync = () => {
    throw Object.assign(new Error("git did not finish"), { code: "ETIMEDOUT", signal: "SIGTERM" });
  };
  const options = { cwd: "/work/app/docs", agentDir: "/agent" };
  for (const command of ["add", "remove"]) {
    const result = await runSkillsCommand(env, [command, "./skill", "--directory"], options);
    assert.equal(result.exitCode, 1, result.lines.join("\n"));
    assert.match(result.lines.join("\n"), /Git checkout discovery timed out/);
  }
  assert.deepEqual(writes, []);

  withCheckouts(env, { "/work/app/docs": "/work/app" });
  const retry = await runSkillsCommand(env, ["add", "./skill", "--directory"], options);
  assert.equal(retry.exitCode, 0, retry.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/directory-skills.json"), {
    "/work/app": { enabled: ["docs/skill"] },
  });
});

test("directory discovery failures skip cwd entries but keep the other scopes available", async () => {
  const { env } = createEnvironment({
    files: {
      "/work/app/docs": "",
      "/agent/skills.json": JSON.stringify({ enabled: ["/skills/global"] }),
      "/agent/directory-skills.json": JSON.stringify({ "/work/app/docs": { enabled: ["/skills/directory"] } }),
      "/skills/global": "",
      "/skills/directory": "",
    },
  });
  env.execFileSync = (_file, _args, options) => {
    if (options.env) {
      assert.equal(options.env.LC_ALL, "C");
      assert.equal(options.stdio[2], "pipe");
    }
    throw Object.assign(new Error("bad Git config"), {
      status: 128,
      stderr: "fatal: bad config line 1 in file .git/config\n",
    });
  };
  const result = await resolveActiveSkillPaths(env, {
    cwd: "/work/app/docs",
    agentDir: "/agent",
    resolveResourcePath: (path) => path,
  });
  assert.deepEqual(result.paths, ["/skills/global"]);
  assert.match(result.diagnostics[0]?.message ?? "", /Ignoring directory skills: Git checkout discovery failed/);
});

test("active keeps listing other scopes when directory discovery fails", async () => {
  const { env, writes } = createEnvironment({
    files: {
      "/srv/bare.git": "",
      "/srv/bare.git/skill": "",
      "/agent/skills.json": JSON.stringify({ enabled: ["global-skill"] }),
      "/agent/directory-skills.json": JSON.stringify({ "/work/other": { enabled: ["./skills/review"] } }),
    },
  });
  env.execFileSync = () => {
    throw Object.assign(new Error("bare repository"), {
      status: 128,
      stderr: "fatal: this operation must be run in a work tree\n",
    });
  };
  const result = await runSkillsCommand(env, ["active"], { cwd: "/srv/bare.git", agentDir: "/agent" });
  assert.equal(result.exitCode, 0, result.lines.join("\n"));
  assert.deepEqual(result.lines.slice(0, 2), ["Active skills:", "  global: global-skill"]);
  assert.match(result.lines[2] ?? "", /Ignoring directory skills: Git checkout discovery failed/);
  assert.deepEqual(result.activeEntries, [{ scope: "global", source: "global-skill" }]);
  assert.deepEqual(writes, []);

  const mutation = await runSkillsCommand(env, ["add", "./skill", "--directory"], {
    cwd: "/srv/bare.git",
    agentDir: "/agent",
  });
  assert.equal(mutation.exitCode, 1, mutation.lines.join("\n"));
  assert.match(mutation.lines.join("\n"), /Git checkout discovery failed/);
  assert.deepEqual(writes, []);
});

test("directory discovery recognizes Git's filesystem-boundary diagnostic", () => {
  const { env } = createEnvironment();
  env.execFileSync = () => {
    throw Object.assign(new Error("not a git repository"), {
      status: 128,
      stderr:
        "fatal: not a git repository (or any parent up to mount point /vol)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n",
    });
  };
  assert.equal(resolveDirectoryKey(env, "/vol/docs"), "/vol/docs");
});

test("relative directory entries resolve against the same base used to select them", async () => {
  const { env } = createEnvironment({
    files: {
      "/checkout": "",
      "/agent/directory-skills.json": JSON.stringify({ "/checkout": { enabled: ["skills/local"] } }),
      "/checkout/skills/local": "",
    },
    git: { "remote get-url origin": "https://example.com/team/app" },
  });
  const git = env.execFileSync;
  let lookups = 0;
  env.execFileSync = (file, args, options) => {
    if (args.slice(2).join(" ") === "rev-parse --show-toplevel") {
      lookups += 1;
      return lookups === 1 ? "/checkout" : "/changed";
    }
    return git(file, args, options);
  };
  assert.deepEqual(
    await resolveActiveSkillPaths(env, {
      cwd: "/checkout/subdirectory",
      agentDir: "/agent",
      resolveResourcePath: (path) => path,
    }),
    { paths: ["/checkout/skills/local"], diagnostics: [] },
  );
  assert.equal(lookups, 1);
});

test("a vanished directory base does not activate its absolute paths on reload", async () => {
  const config = JSON.stringify({ "/work": { enabled: ["/skills/directory"] } });
  const { env, store, writes } = createEnvironment({
    files: {
      "/work": "",
      "/agent/skills.json": JSON.stringify({ enabled: ["/skills/global"] }),
      "/agent/directory-skills.json": config,
      "/skills/directory": "",
      "/skills/global": "",
    },
  });
  /** @type {import("./skill-management-core.ts").ActiveSkillPathsContext} */
  const options = { cwd: "/work", agentDir: "/agent", resolveResourcePath: (path) => path };
  assert.deepEqual((await resolveActiveSkillPaths(env, options)).paths, ["/skills/global", "/skills/directory"]);

  store.delete("/work");
  assert.deepEqual(await resolveActiveSkillPaths(env, options), { paths: ["/skills/global"], diagnostics: [] });
  assert.deepEqual(writes, []);
  assert.equal(store.get("/agent/directory-skills.json"), config);

  store.set("/work", "");
  assert.deepEqual((await resolveActiveSkillPaths(env, options)).paths, ["/skills/global", "/skills/directory"]);
});

test("a file replacing the directory base does not activate the saved bucket", async () => {
  const config = JSON.stringify({ "/work": { enabled: ["/skills/directory"] } });
  const { env, store } = createEnvironment({
    files: {
      "/work": "",
      "/agent/skills.json": JSON.stringify({ enabled: ["/skills/global"] }),
      "/agent/directory-skills.json": config,
      "/skills/directory": "",
      "/skills/global": "",
    },
  });
  let isDirectory = false;
  env.fs.isDirectory = () => isDirectory;
  /** @type {import("./skill-management-core.ts").ActiveSkillPathsContext} */
  const options = { cwd: "/work", agentDir: "/agent", resolveResourcePath: (path) => path };
  assert.deepEqual((await resolveActiveSkillPaths(env, options)).paths, ["/skills/global"]);
  assert.equal(store.get("/agent/directory-skills.json"), config);

  isDirectory = true;
  assert.deepEqual((await resolveActiveSkillPaths(env, options)).paths, ["/skills/global", "/skills/directory"]);
});

test("reload skips directory entries if the captured base vanishes during catalog resolution", async () => {
  const config = JSON.stringify({ "/work": { enabled: ["/skills/directory"] } });
  const { env, store, writes } = createEnvironment({
    files: {
      "/work": "",
      "/agent/skills.json": JSON.stringify({ enabled: ["global-skill"] }),
      "/agent/repo-skills.json": JSON.stringify({ "github.com:team/app": { enabled: ["/skills/repo"] } }),
      "/agent/directory-skills.json": config,
      "/skills/directory": "",
      "/skills/repo": "",
    },
  });
  withCheckouts(env, { "/work": "/work" });
  env.resolvePackageResources = async () => {
    await Promise.resolve();
    store.delete("/work");
    return {
      skills: [{ enabled: true, path: "/skills/global", metadata: { origin: "package", source: "local" } }],
    };
  };
  env.loadSkills = () => ({
    skills: [{ name: "global-skill", description: "From catalog", filePath: "/skills/global" }],
  });
  const pending = resolveActiveSkillPaths(env, {
    cwd: "/work",
    agentDir: "/agent",
    resolveResourcePath: (path) => path,
  });
  assert.deepEqual(await pending, { paths: ["/skills/global", "/skills/repo"], diagnostics: [] });
  assert.deepEqual(writes, []);
  assert.equal(store.get("/agent/directory-skills.json"), config);
});

test("repository entries resolve against the checkout observed before the catalog wait", async () => {
  const { env } = createEnvironment({
    files: {
      "/agent/skills.json": JSON.stringify({ enabled: ["global-skill"] }),
      "/agent/repo-skills.json": JSON.stringify({ "github.com:team/app": { enabled: ["skills/review"] } }),
      "/work/app/skills/review": "",
      "/work/app/sub/skills/review": "",
    },
  });
  env.path.resolve = posix.resolve;
  withCheckouts(env, { "/work/app/sub": "/work/app" });
  env.resolvePackageResources = async () => {
    await Promise.resolve();
    // `sub` becomes a nested checkout of the same remote while the catalog builds.
    withCheckouts(env, { "/work/app/sub": "/work/app/sub" });
    return {
      skills: [{ enabled: true, path: "/skills/global", metadata: { origin: "package", source: "local" } }],
    };
  };
  env.loadSkills = () => ({
    skills: [{ name: "global-skill", description: "From catalog", filePath: "/skills/global" }],
  });
  const result = await resolveActiveSkillPaths(env, {
    cwd: "/work/app/sub",
    agentDir: "/agent",
    resolveResourcePath: (path) => path,
  });
  assert.deepEqual(result, { paths: ["/skills/global", "/work/app/skills/review"], diagnostics: [] });
});

test("repository entries resolve against the checkout whose key selected them", async () => {
  const { env } = createEnvironment({
    files: {
      "/agent/repo-skills.json": JSON.stringify({ "github.com:team/app": { enabled: ["skills/review"] } }),
      "/work/app/skills/review": "",
      "/work/app/sub/skills/review": "",
    },
  });
  env.path.resolve = posix.resolve;
  let nested = false;
  let lookups = 0;
  env.execFileSync = (_file, args) => {
    const cwd = args[1] ?? "";
    const command = gitCommand(args);
    if (command === "remote get-url upstream") {
      const remote =
        nested && cwd === "/work/app/sub" ? "git@github.com:team/other.git" : "git@github.com:team/app.git";
      // `sub` becomes a nested checkout of another remote right after the bucket is chosen.
      nested = true;
      return remote;
    }
    if (command === "rev-parse --show-toplevel") {
      lookups += 1;
      return nested && cwd.startsWith("/work/app/sub") ? "/work/app/sub" : "/work/app";
    }
    throw nonRepositoryError();
  };
  const result = await resolveActiveSkillPaths(env, {
    cwd: "/work/app/sub",
    agentDir: "/agent",
    resolveResourcePath: (path) => path,
  });
  assert.deepEqual(result, { paths: ["/work/app/skills/review"], diagnostics: [] });
  assert.equal(lookups, 1);
});

test("a lookup that found no checkout keys directory entries without asking Git again", async () => {
  const { env } = createEnvironment({
    files: {
      "/scratch": "",
      "/agent/skills.json": JSON.stringify({ enabled: ["/skills/global"] }),
      "/agent/directory-skills.json": JSON.stringify({ "/scratch": { enabled: ["/skills/directory"] } }),
      "/skills/global": "",
      "/skills/directory": "",
    },
  });
  let lookups = 0;
  env.execFileSync = (_file, args) => {
    if (args.slice(2).join(" ") === "rev-parse --show-toplevel") {
      lookups += 1;
      // A second probe would time out and abort loading.
      if (lookups > 1) throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    }
    throw nonRepositoryError();
  };
  const result = await resolveActiveSkillPaths(env, {
    cwd: "/scratch",
    agentDir: "/agent",
    resolveResourcePath: (path) => path,
  });
  assert.deepEqual(result, { paths: ["/skills/global", "/skills/directory"], diagnostics: [] });
  assert.equal(lookups, 1);
});

test("relative repository entries stay unresolved when no checkout root was observed", async () => {
  const { env } = createEnvironment({
    files: {
      "/agent/repo-skills.json": JSON.stringify({
        "github.com:team/app": { enabled: ["skills/review", "/skills/absolute"] },
      }),
      "/work/skills/review": "",
      "/skills/absolute": "",
    },
  });
  env.execFileSync = (_file, args) => {
    const command = args.slice(2).join(" ");
    // The root lookup finds no checkout; one appears before the remote lookup.
    if (command === "remote get-url upstream") return "git@github.com:team/app.git";
    throw nonRepositoryError();
  };
  const result = await resolveActiveSkillPaths(env, {
    cwd: "/work",
    agentDir: "/agent",
    resolveResourcePath: (path) => posix.resolve("/work", path),
  });
  assert.deepEqual(result.paths, ["/skills/absolute"]);
  assert.equal(result.diagnostics.length, 1);
});

test("rootless repository mutations never match stored checkout-relative paths", async () => {
  const shared = "github.com:team/app";
  const config = "/agent/repo-skills.json";
  const relative = { source: "./skills/review" };
  const variable = "$REVIEW";
  const absolute = "/bare/skills/review";
  const { env, store } = createEnvironment({
    git: { "remote get-url origin": "https://github.com/team/app.git" },
    variables: { REVIEW: "./skills/review" },
    files: {
      [config]: JSON.stringify({ [shared]: { enabled: [relative, variable, "catalog-skill"] } }),
      [absolute]: "",
    },
  });
  const options = { cwd: "/bare", agentDir: "/agent" };
  const entries = () => readStored(store, config)[shared].enabled;

  const add = await runSkillsCommand(env, ["add", absolute, "--repo"], options);
  assert.equal(add.exitCode, 0, add.lines.join("\n"));
  assert.deepEqual(entries(), [relative, variable, "catalog-skill", absolute]);

  const remove = await runSkillsCommand(env, ["remove", "./skills/review", "--repo"], options);
  assert.equal(remove.exitCode, 0, remove.lines.join("\n"));
  assert.deepEqual(entries(), [relative, variable, "catalog-skill"]);

  const missing = await runSkillsCommand(env, ["remove", absolute, "--repo"], options);
  assert.equal(missing.exitCode, 1);
  assert.deepEqual(entries(), [relative, variable, "catalog-skill"]);

  const catalog = await runSkillsCommand(env, ["remove", "catalog-skill", "--repo"], options);
  assert.equal(catalog.exitCode, 0, catalog.lines.join("\n"));
  assert.deepEqual(entries(), [relative, variable]);
});

test("a repository add selects its bucket and its stored path from one checkout lookup", async () => {
  const { env, store } = createEnvironment({ files: { "/work/outer/sub/skills/review": "" } });
  env.path.resolve = posix.resolve;
  let lookups = 0;
  env.execFileSync = (_file, args) => {
    const command = gitCommand(args);
    if (command === "remote get-url upstream") return "git@github.com:team/outer.git";
    if (command === "rev-parse --show-toplevel") {
      lookups += 1;
      // `sub` becomes a nested checkout after the first lookup.
      return lookups === 1 ? "/work/outer" : "/work/outer/sub";
    }
    throw nonRepositoryError();
  };
  const result = await runSkillsCommand(env, ["add", "skills/review", "--repo"], {
    cwd: "/work/outer/sub",
    agentDir: "/agent",
  });
  assert.equal(result.exitCode, 0, result.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/repo-skills.json")["github.com:team/outer"].enabled, [
    "sub/skills/review",
  ]);
  assert.equal(lookups, 1);
});

test("remote lookups stay in the captured checkout even with a path-list separator in its parent", (t) => {
  const { env } = createEnvironment();
  const area = mkdtempSync(join(tmpdir(), "pi-skills-checkout-"));
  t.after(() => rmSync(area, { recursive: true, force: true }));
  const outer = join(area, `team${delimiter}tools`);
  const nested = join(outer, "nested");
  const linked = join(area, "linked");
  const childEnv = {
    ...withoutRepositoryGitEnvironment(process.env, process.platform === "win32"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(area, "nonexistent-config"),
  };
  /** @param {...string} args */
  const git = (...args) => execFileSync("git", args, { env: childEnv, stdio: "ignore" });
  mkdirSync(nested, { recursive: true });
  git("-C", outer, "init", "--template=");
  git("-C", outer, "remote", "add", "origin", "https://github.com/team/outer.git");
  git(
    "-C",
    outer,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "--no-gpg-sign",
    "-m",
    "fixture",
  );
  git("-C", outer, "worktree", "add", "--detach", linked, "HEAD");
  git("-C", nested, "init", "--template=");
  git("-C", nested, "remote", "add", "origin", "https://github.com/team/nested.git");
  env.execFileSync = (file, args, { env: overrides, ...options }) =>
    execFileSync(file, args, { ...options, env: { ...childEnv, ...overrides } });

  assert.ok(statSync(join(linked, ".git")).isFile(), "exercise a linked worktree's gitfile");
  assert.equal(resolveRepoKey(env, linked), "github.com:team/outer");
  const nestedRoot = execFileSync("git", ["-C", nested, "rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
    env: childEnv,
  }).trimEnd();
  assert.equal(resolveRepoKey(env, nested, { value: nestedRoot }), "github.com:team/nested");
  renameSync(join(nested, ".git"), join(area, "saved-metadata"));
  assert.match(resolveRepoKey(env, nested, { value: nestedRoot }) ?? "", /^local:/);
});

test("active entries list directory scope after global and repository scopes", async () => {
  const { env } = createEnvironment({
    files: {
      "/agent/skills.json": JSON.stringify({ enabled: ["/skills/global/review"] }),
      "/agent/repo-skills.json": JSON.stringify({ "github.com:team/app": { enabled: ["/skills/repo/review"] } }),
      "/home/dev/app": "",
      "/agent/directory-skills.json": JSON.stringify({ "/home/dev/app": { enabled: ["/skills/dir/review"] } }),
      "/skills/global/review": "",
      "/skills/repo/review": "",
      "/skills/dir/review": "",
    },
  });
  withCheckouts(env, { "/home/dev/app": "/home/dev/app" });
  const options = { cwd: "/home/dev/app", agentDir: "/agent" };

  // Pi keeps the first of two different skills with the same name, so this order is the precedence.
  const resolved = await resolveActiveSkillPaths(env, {
    ...options,
    resolvedSkillResources: [],
    resolveResourcePath: (path) => path,
  });
  assert.deepEqual(resolved.paths, ["/skills/global/review", "/skills/repo/review", "/skills/dir/review"]);

  const active = await runSkillsCommand(env, ["active"], options);
  assert.deepEqual(active.lines, [
    "Active skills:",
    "  global: /skills/global/review",
    "  repo: /skills/repo/review",
    "  directory: /skills/dir/review",
  ]);
});

test("an unresolvable directory-relative entry says what it resolves against", async () => {
  const { env } = createEnvironment({
    files: {
      "/scratch": "",
      "/agent/directory-skills.json": JSON.stringify({ "/scratch": { enabled: ["skills/missing"] } }),
    },
  });

  const result = await resolveActiveSkillPaths(env, {
    cwd: "/scratch",
    agentDir: "/agent",
    resolvedSkillResources: [],
    resolveResourcePath: (path) => env.resolvePath(path, "/scratch", { trim: true }),
  });

  assert.deepEqual(result.diagnostics, [
    {
      type: "warning",
      message:
        "Active skill could not be resolved: relative directory paths resolve against the root of the current checkout, or the working directory outside one",
      path: "skills/missing",
    },
  ]);
});

test("an unresolvable repository-relative entry says what it resolves against", async () => {
  const { env } = createEnvironment({
    files: {
      "/agent/repo-skills.json": JSON.stringify({ "github.com:team/app": { enabled: ["skills/missing"] } }),
    },
  });
  withCheckouts(env, { "/home/dev/app": "/home/dev/app" });

  const result = await resolveActiveSkillPaths(env, {
    cwd: "/home/dev/app",
    agentDir: "/agent",
    resolvedSkillResources: [],
    resolveResourcePath: (path) => env.resolvePath(path, "/home/dev/app", { trim: true }),
  });

  assert.deepEqual(result.diagnostics, [
    {
      type: "warning",
      message:
        "Active skill could not be resolved: relative repository paths resolve against the root of the current checkout",
      path: "skills/missing",
    },
  ]);
});

test("adding a missing relative path reports it without blaming relative resolution", async () => {
  const { env } = createEnvironment();
  const result = await runSkillsCommand(env, ["add", "./missing", "--global"], { cwd: "/work", agentDir: "/agent" });
  assert.equal(result.exitCode, 1);
  assert.equal(firstLine(result), "Skill not found in the catalog or at an existing path: ./missing");
});

test("adding a path with an unset variable names the variable and persists nothing", async () => {
  const { env, store } = createEnvironment();

  const result = await runSkillsCommand(env, ["add", "${SKILLS_HOME}/alpha", "--global"], {
    cwd: "/work",
    agentDir: "/agent",
  });

  assert.equal(result.exitCode, 1);
  assert.equal(
    firstLine(result),
    "Skill not found in the catalog or at an existing path: ${SKILLS_HOME}/alpha (environment variable $SKILLS_HOME is not set)",
  );
  assert.equal(store.has("/agent/skills.json"), false);
});

test("a path that expands to an empty string is unresolved rather than the base directory", async () => {
  const { env, store } = createEnvironment({
    files: {
      "/agent/directory-skills.json": JSON.stringify({ "/work": { enabled: ["$SKILL_DIR", "."] } }),
      "/work": "",
    },
    variables: { SKILL_DIR: "" },
  });
  env.path.resolve = posix.resolve;
  const options = { cwd: "/work", agentDir: "/agent" };

  const resolved = await resolveActiveSkillPaths(env, { ...options, resolveResourcePath: (path) => path });
  assert.deepEqual(resolved.paths, ["/work"], "an explicit . still selects the base");
  assert.deepEqual(
    resolved.diagnostics.map((diagnostic) => diagnostic.path),
    ["$SKILL_DIR"],
  );

  const added = await runSkillsCommand(env, ["add", "$SKILL_DIR", "--global"], options);
  assert.equal(added.exitCode, 1);
  assert.equal(store.has("/agent/skills.json"), false);

  const removed = await runSkillsCommand(env, ["remove", "$SKILL_DIR", "--directory"], options);
  assert.equal(removed.exitCode, 0, removed.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/directory-skills.json")["/work"].enabled, ["."]);
});

test("a path that literally contains $ is still addable when the variable is unset", async () => {
  const { env, store } = createEnvironment();
  env.fs.existsSync = (path) => path === "/srv/$skills/alpha" || store.has(path);

  const result = await runSkillsCommand(env, ["add", "/srv/$skills/alpha", "--global"], {
    cwd: "/work",
    agentDir: "/agent",
  });

  assert.equal(result.exitCode, 0, result.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["/srv/$skills/alpha"]);
});

test("persisted ~ and variable entries resolve, and unresolvable path entries explain why", async () => {
  const { env } = createEnvironment({
    variables: { SKILLS: "/opt/skills" },
    files: {
      "/agent/skills.json": JSON.stringify({
        enabled: ["${SKILLS}/alpha", "~/skills/beta", "$UNSET_DIR/gamma", ".agents/skills/delta/SKILL.md", "/gone"],
      }),
      "/opt/skills/alpha": "",
      "/home/dev/skills/beta": "",
    },
  });

  const result = await resolveActiveSkillPaths(env, {
    cwd: "/elsewhere",
    agentDir: "/agent",
    resolvedSkillResources: [],
    resolveResourcePath: (path) => env.resolvePath(path, "/elsewhere", { trim: true }),
  });

  assert.deepEqual(result.paths, ["/opt/skills/alpha", "/home/dev/skills/beta"]);
  assert.deepEqual(result.diagnostics, [
    {
      type: "warning",
      message: "Active skill could not be resolved: environment variable $UNSET_DIR is not set",
      path: "$UNSET_DIR/gamma",
    },
    {
      type: "warning",
      message:
        "Active skill could not be resolved: relative paths resolve against the working directory; remove it, then add it again to store its absolute path",
      path: ".agents/skills/delta/SKILL.md",
    },
    { type: "warning", message: "Active skill could not be resolved", path: "/gone" },
  ]);
});

test("removing an absolute path also removes an entry stored with an equivalent variable spelling", async () => {
  const { env, store } = createEnvironment({
    variables: { HOME: "/home/dev" },
    files: { "/agent/skills.json": JSON.stringify({ enabled: ["$HOME/skills/alpha", "other"] }) },
  });

  const result = await runSkillsCommand(env, ["remove", "/home/dev/skills/alpha", "--global"], {
    cwd: "/work",
    agentDir: "/agent",
  });

  assert.equal(result.exitCode, 0, result.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["other"]);
});

test("a bare source naming an existing path is persisted as that path, and other bare names stay names", async () => {
  const { env, store } = withCatalog([{ name: "alpha", description: "catalog skill", filePath: "/pkg/alpha" }]);
  withLocalSkills(env, { "/work/local-skill": [localSkill] });
  env.fs.existsSync = (path) => path === "/work/local-skill" || store.has(path);
  const options = { cwd: "/work", agentDir: "/agent" };

  assert.equal((await runSkillsCommand(env, ["add", "local-skill", "--global"], options)).exitCode, 0);
  assert.equal((await runSkillsCommand(env, ["add", "alpha", "--global"], options)).exitCode, 0);
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["/work/local-skill", "alpha"]);

  assert.equal((await runSkillsCommand(env, ["remove", "local-skill", "--global"], options)).exitCode, 0);
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["alpha"]);
});

test("a local folder without skills does not shadow a catalog skill of the same name", async () => {
  const { env, store } = withCatalog([{ name: "alpha", description: "catalog skill", filePath: "/pkg/alpha" }]);
  withLocalSkills(env, { "/work/alpha": [], "/work/ghost": [] });
  env.fs.existsSync = (path) => path === "/work/alpha" || path === "/work/ghost" || store.has(path);
  const options = { cwd: "/work", agentDir: "/agent" };

  const added = await runSkillsCommand(env, ["add", "alpha", "--global"], options);
  assert.equal(added.exitCode, 0, added.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["alpha"], "the catalog name is persisted");

  const ghost = await runSkillsCommand(env, ["add", "ghost", "--global"], options);
  assert.equal(ghost.exitCode, 1, "a skill-less folder that is not a catalog skill is not addable");
  assert.match(firstLine(ghost), /Skill not found in the catalog or at an existing path: ghost/);

  const explicit = await runSkillsCommand(env, ["add", "./alpha", "--global"], options);
  assert.equal(explicit.exitCode, 0, "an explicit path keeps direct path handling");
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["alpha", "/work/alpha"]);
});

test("a bare name prefers a catalog skill over a local skill folder of the same name", async () => {
  const catalogAlpha = { name: "alpha", description: "catalog skill", filePath: "/pkg/alpha/SKILL.md" };
  const { env, store } = withCatalog([catalogAlpha]);
  let packageResolutions = 0;
  const resolvePackageResources = env.resolvePackageResources;
  env.resolvePackageResources = (options) => {
    packageResolutions += 1;
    return resolvePackageResources(options);
  };
  withLocalSkills(env, { "/work/alpha": [{ ...catalogAlpha, filePath: "/work/alpha/SKILL.md" }] });
  env.fs.existsSync = (path) => path === "/work/alpha" || store.has(path);
  const options = { cwd: "/work", agentDir: "/agent" };

  const added = await runSkillsCommand(env, ["add", "alpha", "--global"], options);
  assert.equal(added.exitCode, 0, added.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["alpha"], "the catalog name is persisted");
  assert.equal(packageResolutions, 1, "the add command builds its catalog only once");

  const explicit = await runSkillsCommand(env, ["add", "./alpha", "--global"], options);
  assert.equal(explicit.exitCode, 0, "the local folder stays reachable through an explicit path");
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["alpha", "/work/alpha"]);

  assert.equal((await runSkillsCommand(env, ["remove", "alpha", "--global"], options)).exitCode, 0);
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["/work/alpha"], "remove targets the name");
});

test("removing a bare name never resolves packages, and prefers the stored catalog name", async () => {
  const catalogAlpha = { name: "alpha", description: "catalog skill", filePath: "/pkg/alpha/SKILL.md" };
  const { env, store } = withCatalog([catalogAlpha]);
  withLocalSkills(env, { "/work/alpha": [{ ...catalogAlpha, filePath: "/work/alpha/SKILL.md" }] });
  env.fs.existsSync = (path) => path === "/work/alpha" || store.has(path);
  store.set("/agent/skills.json", JSON.stringify({ enabled: ["alpha", "/work/alpha"] }));
  let resolutions = 0;
  env.resolvePackageResources = () => {
    resolutions += 1;
    return Promise.reject(new Error("package resolution must not run during removal"));
  };
  const options = { cwd: "/work", agentDir: "/agent" };

  const removed = await runSkillsCommand(env, ["remove", "alpha", "--global"], options);
  assert.equal(removed.exitCode, 0, removed.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["/work/alpha"]);

  const again = await runSkillsCommand(env, ["remove", "alpha", "--global"], options);
  assert.equal(again.exitCode, 0, again.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, []);
  assert.equal(resolutions, 0);
});

test("a bare source persisted as a path stays removable by its name after the path is deleted", async () => {
  const { env, store } = createEnvironment();
  withLocalSkills(env, { "/work/local-skill": [localSkill] });
  let pathExists = true;
  env.fs.existsSync = (path) => (path === "/work/local-skill" ? pathExists : store.has(path));
  const options = { cwd: "/work", agentDir: "/agent" };

  assert.equal((await runSkillsCommand(env, ["add", "local-skill", "--global"], options)).exitCode, 0);
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["/work/local-skill"]);

  pathExists = false;
  const removed = await runSkillsCommand(env, ["remove", "local-skill", "--global"], options);
  assert.equal(removed.exitCode, 0, removed.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, []);
});

test("removing a bare name prefers a catalog-name entry over a deleted path with the same spelling", async () => {
  const { env, store } = createEnvironment({
    files: { "/agent/skills.json": JSON.stringify({ enabled: ["/work/local-skill", "local-skill"] }) },
  });
  const options = { cwd: "/work", agentDir: "/agent" };

  assert.equal((await runSkillsCommand(env, ["remove", "local-skill", "--global"], options)).exitCode, 0);
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["/work/local-skill"]);

  assert.equal((await runSkillsCommand(env, ["remove", "local-skill", "--global"], options)).exitCode, 0);
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, []);

  const missing = await runSkillsCommand(env, ["remove", "local-skill", "--global"], options);
  assert.equal(missing.exitCode, 1);
  assert.match(firstLine(missing), /Skill is not enabled for global scope: local-skill/);
});

test("a persisted catalog name is compared literally, whatever exists in the current directory", async () => {
  const { env, store } = withCatalog([{ name: "alpha", description: "catalog skill", filePath: "/pkg/alpha" }]);
  store.set("/agent/skills.json", JSON.stringify({ enabled: ["alpha"] }));
  env.fs.existsSync = (path) => path === "/work/alpha" || store.has(path);
  const options = { cwd: "/work", agentDir: "/agent" };

  const added = await runSkillsCommand(env, ["add", "./alpha", "--global"], options);
  assert.equal(added.exitCode, 0, added.lines.join("\n"));
  assert.deepEqual(
    readStored(store, "/agent/skills.json").enabled,
    ["alpha", "/work/alpha"],
    "a local folder named like a catalog skill does not make the path a duplicate of the name",
  );

  assert.equal((await runSkillsCommand(env, ["remove", "./alpha", "--global"], options)).exitCode, 0);
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, ["alpha"], "removing the path keeps the name");

  const removed = await runSkillsCommand(env, ["remove", "alpha", "--global"], options);
  assert.equal(removed.exitCode, 0, removed.lines.join("\n"));
  assert.deepEqual(readStored(store, "/agent/skills.json").enabled, [], "the catalog name is still removable");
});

/**
 * Builds an interactive context that records what the command did.
 *
 * @param {import("./skill-management-core.ts").SkillEnvironment} env
 * @param {{ additionalSkillPaths?: string[] | undefined }} [options]
 */
function createInteractiveContext(env, options = {}) {
  // Read the key rather than defaulting the parameter, so a test can pass `undefined` deliberately to model
  // a resource loader that exposes no session list.
  const additionalSkillPaths = "additionalSkillPaths" in options ? options.additionalSkillPaths : [];
  /** @type {{ reloads: number; warnings: string[]; errors: string[]; output: string[] }} */
  const calls = { reloads: 0, warnings: [], errors: [], output: [] };
  /** @type {import("./skill-management-core.ts").InteractiveSkillsContext} */
  const context = {
    cwd: "/work",
    agentDir: "/agent",
    settingsManager: env.createSettingsManager("/work", "/agent"),
    additionalSkillPaths,
    resolveResourcePath: (path) => (path.startsWith("/") ? path : `/work/${path.replace(/^\.\//, "")}`),
    isBusy: () => false,
    reload: () => {
      calls.reloads += 1;
      return Promise.resolve();
    },
    showWarning: (message) => calls.warnings.push(message),
    showError: (message) => calls.errors.push(message),
    showOutput: (message) => calls.output.push(message),
  };
  return { context, calls };
}

test("/skills reload reloads and produces no other output", async () => {
  const { env } = createEnvironment();
  const { context, calls } = createInteractiveContext(env);
  await handleSkillsInteractive(env, "/skills reload", context);
  assert.equal(calls.reloads, 1);
  assert.deepEqual(calls.output, []);
  assert.deepEqual(calls.warnings, []);
});

test("/skills reload tolerates surrounding whitespace", async () => {
  const { env } = createEnvironment();
  const { context, calls } = createInteractiveContext(env);
  await handleSkillsInteractive(env, "/skills   reload  ", context);
  assert.equal(calls.reloads, 1);
});

test("/skills reload with an extra argument shows usage instead of reloading", async () => {
  const { env } = createEnvironment();
  const { context, calls } = createInteractiveContext(env);
  await handleSkillsInteractive(env, "/skills reload now", context);
  assert.equal(calls.reloads, 0, "an unrecognized invocation must not reload");
  assert.equal(calls.warnings.length, 1);
  assert.match(calls.warnings[0] ?? "", /^Usage: \/skills/);
});

test("/skills without a subcommand shows usage instead of reloading", async () => {
  const { env } = createEnvironment();
  const { context, calls } = createInteractiveContext(env);
  await handleSkillsInteractive(env, "/skills", context);
  assert.equal(calls.reloads, 0);
  assert.equal(calls.warnings.length, 1);
  assert.match(calls.warnings[0] ?? "", /^Usage: \/skills/);
});

test("/skills active includes session paths alongside persisted scopes", async () => {
  const { env } = createEnvironment({
    files: { "/agent/skills.json": JSON.stringify({ enabled: ["global-skill"] }) },
  });
  const { context, calls } = createInteractiveContext(env, { additionalSkillPaths: ["/tmp/session-skill"] });
  await handleSkillsInteractive(env, "/skills active", context);
  assert.deepEqual(calls.output, [
    ["Active skills:", "  global: global-skill", "  session: /tmp/session-skill"].join("\n"),
  ]);
});

test("/skills add --session activates for the session and reloads", async () => {
  const { env } = withCatalog([{ name: "alpha", description: "First", filePath: "/pkg/alpha/SKILL.md" }]);
  /** @type {string[]} */
  const paths = [];
  const { context, calls } = createInteractiveContext(env, { additionalSkillPaths: paths });
  await handleSkillsInteractive(env, "/skills add alpha --session", context);
  assert.deepEqual(paths, ["/pkg/alpha/SKILL.md"], "the loader's list is mutated in place");
  assert.deepEqual(calls.output, ["Enabled /pkg/alpha/SKILL.md for this session."]);
  assert.equal(calls.reloads, 1);
});

test("/skills remove --session deactivates without resolving packages", async () => {
  const { env } = withCatalog([{ name: "alpha", description: "First", filePath: "/pkg/alpha/SKILL.md" }]);
  const paths = ["/pkg/alpha/SKILL.md"];
  const { context, calls } = createInteractiveContext(env, { additionalSkillPaths: paths });
  let packageResolutions = 0;
  env.resolvePackageResources = () => {
    packageResolutions += 1;
    return Promise.reject(new Error("package resolution must not run during session removal"));
  };

  await handleSkillsInteractive(env, "/skills remove alpha --session", context);
  assert.deepEqual(paths, [], "the loader's list is mutated in place");
  assert.deepEqual(calls.output, ["Disabled alpha for this session."]);
  assert.equal(packageResolutions, 0);
});

test("/skills remove --session matches resolved path inputs without resolving packages", async () => {
  const { env } = createEnvironment();
  const paths = ["/work/alpha"];
  const { context, calls } = createInteractiveContext(env, { additionalSkillPaths: paths });
  env.resolvePackageResources = () =>
    Promise.reject(new Error("package resolution must not run during session removal"));

  await handleSkillsInteractive(env, "/skills remove ./alpha --session", context);
  assert.deepEqual(paths, []);
  assert.deepEqual(calls.errors, []);
  assert.deepEqual(calls.output, ["Disabled /work/alpha for this session."]);
});

test("/skills add and remove --session expand variables in path inputs", async () => {
  const { env } = createEnvironment({ variables: { SKILLS: "/opt/skills" } });
  env.fs.existsSync = (path) => path === "/opt/skills/alpha";
  /** @type {string[]} */
  const paths = [];
  const { context, calls } = createInteractiveContext(env, { additionalSkillPaths: paths });

  await handleSkillsInteractive(env, "/skills add ${SKILLS}/alpha --session", context);
  assert.deepEqual(calls.errors, []);
  assert.deepEqual(paths, ["/opt/skills/alpha"]);

  await handleSkillsInteractive(env, "/skills remove $SKILLS/alpha --session", context);
  assert.deepEqual(calls.errors, []);
  assert.deepEqual(paths, []);
});

test("session add and remove agree when an expanded value contains a literal variable", async () => {
  const literal = "/opt/$PROFILE/tool";
  const expandedAgain = "/opt/prod/tool";
  const { env } = createEnvironment({
    variables: { SKILL_DIR: literal, PROFILE: "prod" },
    files: { [literal]: "", [expandedAgain]: "" },
  });
  const paths = [expandedAgain];
  const { context, calls } = createInteractiveContext(env, { additionalSkillPaths: paths });

  await handleSkillsInteractive(env, "/skills add $SKILL_DIR --session", context);
  assert.deepEqual(paths, [expandedAgain, literal]);

  await handleSkillsInteractive(env, "/skills remove $SKILL_DIR --session", context);
  assert.deepEqual(paths, [expandedAgain]);
  assert.deepEqual(calls.errors, []);
  assert.equal(calls.reloads, 2);
});

test("/skills remove --session does not treat an empty expanded path as the working directory", async () => {
  const { env } = createEnvironment({ variables: { SKILL_DIR: "" } });
  const paths = ["/work"];
  const { context, calls } = createInteractiveContext(env, { additionalSkillPaths: paths });
  context.resolveResourcePath = (path) => posix.resolve(context.cwd, path.trim());

  await handleSkillsInteractive(env, "/skills remove $SKILL_DIR --session", context);
  assert.deepEqual(paths, ["/work"]);
  assert.match(calls.errors[0] ?? "", /Skill is not enabled/);
  assert.equal(calls.reloads, 0);

  await handleSkillsInteractive(env, "/skills remove . --session", context);
  assert.deepEqual(paths, [], "an explicit dot still removes the working directory");
});

test("/skills remove --session removes a deleted local skill by its bare name", async () => {
  const { env, store } = createEnvironment();
  withLocalSkills(env, { "/work/local-skill": [localSkill] });
  let pathExists = true;
  env.fs.existsSync = (path) => (path === "/work/local-skill" ? pathExists : store.has(path));
  const paths = ["/pkg/other/SKILL.md"];
  const { context, calls } = createInteractiveContext(env, { additionalSkillPaths: paths });

  await handleSkillsInteractive(env, "/skills add local-skill --session", context);
  assert.deepEqual(paths, ["/pkg/other/SKILL.md", "/work/local-skill"]);

  pathExists = false;
  await handleSkillsInteractive(env, "/skills remove local-skill --session", context);
  assert.deepEqual(calls.errors, []);
  assert.deepEqual(paths, ["/pkg/other/SKILL.md"], "only the stale local path is removed");
  assert.deepEqual(calls.output.at(-1), "Disabled local-skill for this session.");
});

test("/skills remove --session reports a skill that is not active", async () => {
  const { env } = withCatalog([{ name: "alpha", description: "First", filePath: "/pkg/alpha/SKILL.md" }]);
  const { context, calls } = createInteractiveContext(env, { additionalSkillPaths: [] });
  await handleSkillsInteractive(env, "/skills remove alpha --session", context);
  assert.equal(calls.errors.length, 1);
  assert.match(calls.errors[0] ?? "", /not enabled for this session/);
});

test("/skills session scope reports unavailability when the loader exposes no session list", async () => {
  const { env } = withCatalog([{ name: "alpha", description: "First", filePath: "/pkg/alpha/SKILL.md" }]);
  const { context, calls } = createInteractiveContext(env, { additionalSkillPaths: undefined });
  await handleSkillsInteractive(env, "/skills add alpha --session", context);
  assert.deepEqual(calls.errors, ["Session skill activation is unavailable for this resource loader."]);
});

test("/skills add defers the reload while the agent is busy", async () => {
  const { env } = withCatalog([{ name: "alpha", description: "First", filePath: "/pkg/alpha/SKILL.md" }]);
  const { context, calls } = createInteractiveContext(env, { additionalSkillPaths: [] });
  context.isBusy = () => true;
  await handleSkillsInteractive(env, "/skills add alpha --session", context);
  assert.equal(calls.reloads, 0);
  assert.match(calls.output[0] ?? "", /Change will apply after `\/skills reload`/);
});
