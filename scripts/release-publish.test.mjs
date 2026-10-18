import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  PACKAGE_KINDS,
  REGISTRY,
  compareVersions,
  packPackages,
  parseVersion,
  planReleases,
  publishPackages,
  publishedVersion,
  taggedVersion,
} from "./release-packages.mjs";

function git(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function archiveFilename(release) {
  return `${release.name.slice(1).replace("/", "-")}-${release.version}.tgz`;
}

function integrityFromBuffer(buffer) {
  return `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
}

function metadata(name, version, integrity = "sha512-ok") {
  return { name, version, dist: { integrity } };
}

function manifestFor(kind, version, overrides = {}) {
  return {
    name: `@zew1me/pi-${kind}`,
    version,
    publishConfig: { registry: REGISTRY, access: "public" },
    ...overrides,
  };
}

function writeManifest(root, kind, manifest) {
  const directory = join(root, "packages", `pi-${kind}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function writePackageSet(root, versionsByKind, options = {}) {
  const missing = new Set(options.missing ?? []);
  const overridesByKind = options.overridesByKind ?? {};
  for (const kind of PACKAGE_KINDS) {
    if (missing.has(kind)) continue;
    const version = versionsByKind[kind] ?? "1.0.0";
    writeManifest(root, kind, manifestFor(kind, version, overridesByKind[kind]));
  }
}

function commitAll(root, message) {
  git(root, ["add", "."]);
  git(root, ["commit", "--no-gpg-sign", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function createGitRepo(context) {
  const root = mkdtempSync(join(tmpdir(), "release-packages-git-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init"]);
  git(root, ["config", "user.name", "pi-tests"]);
  git(root, ["config", "user.email", "pi-tests@example.com"]);
  return root;
}

function writeReleaseAssets(output, releases) {
  mkdirSync(output, { recursive: true });
  const archives = releases.map((release) => {
    const filename = archiveFilename(release);
    const payload = Buffer.from(`archive:${release.name}@${release.version}`);
    writeFileSync(join(output, filename), payload);
    return {
      name: release.name,
      version: release.version,
      filename,
      integrity: integrityFromBuffer(payload),
    };
  });
  writeFileSync(join(output, "release-assets.json"), `${JSON.stringify({ archives }, null, 2)}\n`);
  return archives;
}

function releaseEntry(kind, version, tag) {
  return {
    name: `@zew1me/pi-${kind}`,
    version,
    directory: `packages/pi-${kind}`,
    tag,
  };
}

test("parseVersion accepts stable and alpha/beta/rc prereleases", () => {
  assert.deepEqual(parseVersion("1.2.3"), { core: [1n, 2n, 3n], channel: "latest", number: 0n });
  assert.deepEqual(parseVersion("1.2.3-alpha.4"), { core: [1n, 2n, 3n], channel: "alpha", number: 4n });
  assert.deepEqual(parseVersion("1.2.3-beta.2"), { core: [1n, 2n, 3n], channel: "beta", number: 2n });
  assert.deepEqual(parseVersion("1.2.3-rc.9"), { core: [1n, 2n, 3n], channel: "rc", number: 9n });
});

test("parseVersion rejects unsupported version formats", () => {
  for (const value of [
    "1",
    "1.2",
    "1.2.3-alpha",
    "1.2.3-gamma.1",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-alpha.01",
    "1.2.3+build.7",
  ]) {
    assert.throws(() => parseVersion(value), /Unsupported release version/u, value);
  }
});

test("compareVersions orders prereleases and stable versions correctly", () => {
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.1"), 0);
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.2"), -1);
  assert.equal(compareVersions("1.0.0-alpha.2", "1.0.0-beta.1"), -1);
  assert.equal(compareVersions("1.0.0-beta.9", "1.0.0-rc.1"), -1);
  assert.equal(compareVersions("1.0.0-rc.5", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.1-alpha.1", "1.0.0"), 1);
});

test("planReleases requires a nonzero base commit", (context) => {
  const root = createGitRepo(context);
  writePackageSet(root, Object.fromEntries(PACKAGE_KINDS.map((kind) => [kind, "1.0.0"])));
  commitAll(root, "initial");

  assert.throws(() => planReleases("0", root), /nonzero pre-push base commit/i);
  assert.throws(() => planReleases("0000000", root), /nonzero pre-push base commit/i);
});

test("planReleases compares against the provided base across multiple commits", (context) => {
  const root = createGitRepo(context);
  const versions = Object.fromEntries(PACKAGE_KINDS.map((kind) => [kind, "1.0.0"]));
  writePackageSet(root, versions);
  const base = commitAll(root, "initial");

  writeManifest(root, "clear", manifestFor("clear", "1.0.1"));
  const clearCommit = commitAll(root, "bump clear");

  writeManifest(root, "effort", manifestFor("effort", "1.1.0-beta.1"));
  commitAll(root, "bump effort");

  const fromInitial = planReleases(base, root);
  assert.deepEqual(
    fromInitial
      .map(({ name, version, tag }) => ({ name, version, tag }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    [
      { name: "@zew1me/pi-clear", version: "1.0.1", tag: "latest" },
      { name: "@zew1me/pi-effort", version: "1.1.0-beta.1", tag: "beta" },
    ],
  );

  const fromSecondCommit = planReleases(clearCommit, root);
  assert.deepEqual(
    fromSecondCommit.map(({ name }) => name),
    ["@zew1me/pi-effort"],
  );
});

test("planReleases includes package manifests that are new since base", (context) => {
  const root = createGitRepo(context);
  const versions = Object.fromEntries(PACKAGE_KINDS.map((kind) => [kind, "1.0.0"]));
  writePackageSet(root, versions, { missing: ["subagents"] });
  const base = commitAll(root, "initial without subagents");

  writeManifest(root, "subagents", manifestFor("subagents", "0.1.0-rc.1"));
  commitAll(root, "add subagents package manifest");

  const plan = planReleases(base, root);
  assert.ok(
    plan.some(({ name, version, tag }) => name === "@zew1me/pi-subagents" && version === "0.1.0-rc.1" && tag === "rc"),
  );
});

test("planReleases fails closed on decreases and package rename history", (context) => {
  const root = createGitRepo(context);
  const versions = Object.fromEntries(PACKAGE_KINDS.map((kind) => [kind, "1.0.0"]));
  writePackageSet(root, versions, {
    overridesByKind: {
      clear: { name: "@zew1me/pi-clear-legacy" },
    },
  });
  const renameBase = commitAll(root, "legacy name for clear");

  writeManifest(root, "clear", manifestFor("clear", "1.0.1"));
  commitAll(root, "restore current package name");
  assert.throws(() => planReleases(renameBase, root), /Package renames require a separate migration/u);

  writeManifest(root, "clear", manifestFor("clear", "0.9.9"));
  const decreaseBase = commitAll(root, "reset baseline to 0.9.9");

  writeManifest(root, "clear", manifestFor("clear", "0.9.8"));
  commitAll(root, "decrease clear version");
  assert.throws(() => planReleases(decreaseBase, root), /Version decreased for @zew1me\/pi-clear/u);
});

test("planReleases rejects base commits that are not ancestors of HEAD", (context) => {
  const root = createGitRepo(context);
  writePackageSet(root, Object.fromEntries(PACKAGE_KINDS.map((kind) => [kind, "1.0.0"])));
  const base = commitAll(root, "initial");

  git(root, ["checkout", "-b", "feature"]);
  writeManifest(root, "clear", manifestFor("clear", "1.0.1"));
  const featureCommit = commitAll(root, "feature bump");

  git(root, ["checkout", base]);
  git(root, ["checkout", "-b", "trunk"]);
  writeManifest(root, "effort", manifestFor("effort", "1.0.1"));
  commitAll(root, "main bump");

  assert.throws(() => planReleases(featureCommit, root), /merge-base|ancestor|Command failed/u);
});

test("packPackages validates npm pack output and writes release-assets.json", (context) => {
  const root = mkdtempSync(join(tmpdir(), "release-packages-pack-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const versions = {
    clear: "1.0.0",
    effort: "1.0.0-alpha.1",
    "markdown-backlinks": "1.0.0-beta.2",
    subagents: "1.0.0-rc.3",
    "skills-patch": "2.0.0",
  };
  writePackageSet(root, versions);

  const output = join(root, "artifacts");
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, "npm");
    assert.deepEqual(args.slice(0, 2), ["pack", "--json"]);
    assert.ok(args.includes("--ignore-scripts=false"), "prepack must run despite user or global ignore-scripts");
    const destination = args[args.indexOf("--pack-destination") + 1];
    const manifest = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8"));
    const filename = `${manifest.name.slice(1).replace("/", "-")}-${manifest.version}.tgz`;
    const payload = Buffer.from(`packed:${manifest.name}@${manifest.version}`);
    writeFileSync(join(destination, filename), payload);
    return JSON.stringify([
      {
        name: manifest.name,
        version: manifest.version,
        filename,
        integrity: integrityFromBuffer(payload),
      },
    ]);
  };

  const archives = packPackages(output, root, run);
  assert.equal(calls.length, PACKAGE_KINDS.length);
  assert.equal(archives.length, PACKAGE_KINDS.length);

  const saved = JSON.parse(readFileSync(join(output, "release-assets.json"), "utf8"));
  assert.deepEqual(saved.archives, archives);
  assert.deepEqual(
    archives.map(({ name, tag }) => ({ name, tag })).toSorted((a, b) => a.name.localeCompare(b.name)),
    [
      { name: "@zew1me/pi-clear", tag: "latest" },
      { name: "@zew1me/pi-effort", tag: "alpha" },
      { name: "@zew1me/pi-markdown-backlinks", tag: "beta" },
      { name: "@zew1me/pi-skills-patch", tag: "latest" },
      { name: "@zew1me/pi-subagents", tag: "rc" },
    ],
  );
});

test("packPackages fails closed when npm pack metadata does not match the archive", (context) => {
  const root = mkdtempSync(join(tmpdir(), "release-packages-pack-bad-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writePackageSet(root, Object.fromEntries(PACKAGE_KINDS.map((kind) => [kind, "1.0.0"])));

  const output = join(root, "artifacts");
  const run = (_command, args, options) => {
    const destination = args[args.indexOf("--pack-destination") + 1];
    const manifest = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8"));
    const filename = `${manifest.name.slice(1).replace("/", "-")}-${manifest.version}.tgz`;
    const payload = Buffer.from("good-bytes");
    writeFileSync(join(destination, filename), payload);
    return JSON.stringify([
      {
        name: manifest.name,
        version: manifest.version,
        filename,
        integrity: "sha512-bad-integrity",
      },
    ]);
  };

  assert.throws(() => packPackages(output, root, run), /Unexpected npm pack result/u);
});

test("publishedVersion handles not-found, HTTP errors, and malformed metadata", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (calls.length === 1) return { status: 404, ok: false };
    if (calls.length === 2) return { status: 503, ok: false };
    if (calls.length === 3) {
      return {
        status: 200,
        ok: true,
        async json() {
          return { name: "@zew1me/pi-clear", version: "1.2.3", dist: {} };
        },
      };
    }
    return {
      status: 200,
      ok: true,
      async json() {
        return metadata("@zew1me/pi-clear", "1.2.3");
      },
    };
  };

  const release = { name: "@zew1me/pi-clear", version: "1.2.3" };
  assert.equal(await publishedVersion(release), null);
  await assert.rejects(() => publishedVersion(release), /Registry lookup failed.*503/u);
  await assert.rejects(() => publishedVersion(release), /Invalid registry metadata/u);

  const result = await publishedVersion(release);
  assert.equal(result.dist.integrity, "sha512-ok");
  assert.match(calls[0], /^https:\/\/registry\.npmjs\.org\//u);
  assert.match(calls[0], /%40zew1me%2Fpi-clear\/1\.2\.3$/u);
});

test("taggedVersion handles not-found, HTTP errors, and malformed metadata", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (calls.length === 1) return { status: 404, ok: false };
    if (calls.length === 2) return { status: 502, ok: false };
    if (calls.length === 3) {
      return {
        status: 200,
        ok: true,
        async json() {
          return { name: "@zew1me/pi-clear", version: "1.2.3" };
        },
      };
    }
    if (calls.length === 4) {
      return {
        status: 200,
        ok: true,
        async json() {
          return metadata("@zew1me/pi-effort", "1.2.3");
        },
      };
    }
    return {
      status: 200,
      ok: true,
      async json() {
        return metadata("@zew1me/pi-clear", "1.2.3");
      },
    };
  };

  const release = { name: "@zew1me/pi-clear", version: "9.9.9", tag: "latest" };
  assert.equal(await taggedVersion(release), null);
  await assert.rejects(() => taggedVersion(release), /HTTP 502/u);
  await assert.rejects(() => taggedVersion(release), /Invalid registry metadata/u);
  await assert.rejects(() => taggedVersion(release), /Invalid registry metadata/u);

  const result = await taggedVersion(release);
  assert.equal(result.name, "@zew1me/pi-clear");
  assert.equal(result.version, "1.2.3");
  assert.equal(result.dist.integrity, "sha512-ok");
  assert.match(calls[0], /^https:\/\/registry\.npmjs\.org\//u);
  assert.match(calls[0], /%40zew1me%2Fpi-clear\/latest$/u);
});

test("publishPackages reports no-op when there are no release entries", async () => {
  const messages = [];
  await publishPackages([], "/unused", {
    lookupTag: async () => null,
    report: (message) => messages.push(message),
  });
  assert.deepEqual(messages, ["No package version increases; nothing to publish."]);
});

test("publishPackages preflights all entries before writing and fails closed on conflicts", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "release-packages-publish-preflight-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const releases = [releaseEntry("clear", "1.0.1", "latest"), releaseEntry("effort", "1.0.1", "latest")];
  writeReleaseAssets(root, releases);

  const lookedUp = [];
  const lookup = async (target) => {
    lookedUp.push(target.name);
    if (target.name === "@zew1me/pi-effort") {
      return metadata(target.name, target.version, "sha512-conflict");
    }
    return null;
  };

  const publishCalls = [];
  const run = (...args) => {
    publishCalls.push(args);
    return "";
  };

  await assert.rejects(
    () =>
      publishPackages(releases, root, {
        lookup,
        lookupTag: async () => null,
        run,
      }),
    /Already published with different contents: @zew1me\/pi-effort@1\.0\.1/u,
  );
  assert.deepEqual(lookedUp, ["@zew1me/pi-clear", "@zew1me/pi-effort"]);
  assert.equal(publishCalls.length, 0, "publish must not start before all preflight checks pass");
});

test("publishPackages verifies release assets and blocks modified archives", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "release-packages-publish-modified-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const releases = [releaseEntry("clear", "1.0.1", "latest")];
  const archives = writeReleaseAssets(root, releases);
  writeFileSync(join(root, archives[0].filename), Buffer.from("tampered"));

  let lookedUp = false;
  await assert.rejects(
    () =>
      publishPackages(releases, root, {
        lookup: async () => {
          lookedUp = true;
          return null;
        },
        lookupTag: async () => null,
      }),
    /Missing or modified archive/u,
  );
  assert.equal(lookedUp, false);
});

test("publishPackages handles lookup errors without publishing anything", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "release-packages-publish-lookup-error-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const releases = [releaseEntry("clear", "1.0.1", "latest"), releaseEntry("subagents", "1.0.1", "latest")];
  writeReleaseAssets(root, releases);

  const publishCalls = [];
  await assert.rejects(
    () =>
      publishPackages(releases, root, {
        lookup: async (item) => {
          if (item.name === "@zew1me/pi-subagents") throw new Error("registry outage");
          return null;
        },
        lookupTag: async () => null,
        run: (...args) => {
          publishCalls.push(args);
          return "";
        },
      }),
    /registry outage/u,
  );
  assert.equal(publishCalls.length, 0);
});

test("publishPackages rejects stale candidates when tag already points at a newer version", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "release-packages-publish-stale-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const releases = [releaseEntry("clear", "1.0.0", "latest"), releaseEntry("effort", "1.0.0", "latest")];
  writeReleaseAssets(root, releases);

  const calls = [];
  const lookup = async (item) => {
    calls.push(`lookup:${item.name}`);
    return null;
  };
  const lookupTag = async (item) => {
    calls.push(`lookupTag:${item.name}`);
    if (item.name === "@zew1me/pi-effort") return metadata(item.name, "1.0.1");
    return metadata(item.name, "0.9.0");
  };

  const publishCalls = [];
  await assert.rejects(
    () =>
      publishPackages(releases, root, {
        lookup,
        lookupTag,
        run: (...args) => {
          publishCalls.push(args);
          return "";
        },
      }),
    /stale|older|@zew1me\/pi-effort|latest/u,
  );
  assert.deepEqual(calls, [
    "lookup:@zew1me/pi-clear",
    "lookupTag:@zew1me/pi-clear",
    "lookup:@zew1me/pi-effort",
    "lookupTag:@zew1me/pi-effort",
  ]);
  assert.equal(publishCalls.length, 0);
});

test("publishPackages allows newer candidate than current tag and publishes with requested tag", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "release-packages-publish-tag-progress-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const releases = [releaseEntry("effort", "1.2.0-beta.2", "beta")];
  writeReleaseAssets(root, releases);

  const publishArgs = [];
  await publishPackages(releases, root, {
    lookup: async () => null,
    lookupTag: async (item) => metadata(item.name, "1.2.0-beta.1"),
    run: (_command, args) => {
      publishArgs.push(args);
      return "";
    },
  });

  assert.equal(publishArgs.length, 1);
  assert.equal(publishArgs[0][0], "publish");
  assert.equal(publishArgs[0][publishArgs[0].indexOf("--tag") + 1], "beta");
});

test("publishPackages skips lookupTag and publish when exact version is already published identically", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "release-packages-publish-identical-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const releases = [releaseEntry("clear", "1.0.0", "latest")];
  const [archive] = writeReleaseAssets(root, releases);

  let lookupTagCalls = 0;
  const reports = [];
  const publishCalls = [];
  await publishPackages(releases, root, {
    lookup: async (item) => metadata(item.name, item.version, archive.integrity),
    lookupTag: async () => {
      lookupTagCalls += 1;
      return metadata("@zew1me/pi-clear", "9.9.9");
    },
    run: (...args) => {
      publishCalls.push(args);
      return "";
    },
    report: (line) => reports.push(line),
  });

  assert.equal(lookupTagCalls, 0);
  assert.equal(publishCalls.length, 0);
  assert.deepEqual(reports, ["Already published (identical): @zew1me/pi-clear@1.0.0"]);
});

test("publishPackages uses expected dist-tags and is idempotent for already-published entries", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "release-packages-publish-tags-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const releases = [
    releaseEntry("clear", "1.0.0", "latest"),
    releaseEntry("effort", "1.0.0-alpha.1", "alpha"),
    releaseEntry("markdown-backlinks", "1.0.0-beta.1", "beta"),
    releaseEntry("subagents", "1.0.0-rc.1", "rc"),
  ];
  const archives = writeReleaseAssets(root, releases);

  const published = new Map([["@zew1me/pi-clear@1.0.0", archives[0].integrity]]);
  const lookup = async (item) => {
    const key = `${item.name}@${item.version}`;
    if (!published.has(key)) return null;
    return metadata(item.name, item.version, published.get(key));
  };

  const calls = [];
  const run = (_command, args) => {
    calls.push(args);
    return "";
  };
  const messages = [];

  await publishPackages(releases, root, {
    lookup,
    lookupTag: async () => null,
    run,
    report: (line) => messages.push(line),
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((args) => [args[0], args[args.indexOf("--tag") + 1]]),
    [
      ["publish", "alpha"],
      ["publish", "beta"],
      ["publish", "rc"],
    ],
  );
  for (const args of calls) {
    assert.ok(args.includes("--registry"));
    assert.ok(args.includes(REGISTRY));
    assert.ok(args.includes("--access"));
    assert.ok(args.includes("public"));
    assert.ok(args.includes("--provenance"));
    assert.ok(args.includes("--ignore-scripts"));
  }
  assert.ok(messages.some((line) => line.includes("Already published (identical): @zew1me/pi-clear@1.0.0")));
});

test("publishPackages supports rerun after partial publish failure", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "release-packages-partial-retry-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const releases = [releaseEntry("clear", "2.0.0", "latest"), releaseEntry("effort", "2.0.0", "latest")];
  const archives = writeReleaseAssets(root, releases);

  const published = new Map();
  const lookup = async (item) => {
    const key = `${item.name}@${item.version}`;
    if (!published.has(key)) return null;
    return metadata(item.name, item.version, published.get(key));
  };

  let failedOnce = false;
  const runCalls = [];
  const run = (_command, args) => {
    const archivePath = args[1];
    const filename = archivePath.slice(archivePath.lastIndexOf("/") + 1);
    runCalls.push(filename);

    const archive = archives.find((item) => item.filename === filename);
    assert.ok(archive, `unknown archive ${filename}`);
    const key = `${archive.name}@${archive.version}`;
    if (key === "@zew1me/pi-effort@2.0.0" && !failedOnce) {
      failedOnce = true;
      throw new Error("simulated publish interruption");
    }
    published.set(key, archive.integrity);
    return "";
  };

  await assert.rejects(
    () => publishPackages(releases, root, { lookup, lookupTag: async () => null, run }),
    /simulated publish interruption/u,
  );
  assert.equal(published.has("@zew1me/pi-clear@2.0.0"), true);
  assert.equal(published.has("@zew1me/pi-effort@2.0.0"), false);

  const reports = [];
  await publishPackages(releases, root, {
    lookup,
    lookupTag: async () => null,
    run,
    report: (line) => reports.push(line),
  });

  assert.equal(published.has("@zew1me/pi-effort@2.0.0"), true);
  assert.ok(reports.some((line) => line.includes("Already published (identical): @zew1me/pi-clear@2.0.0")));
  assert.ok(reports.some((line) => line.includes("Published @zew1me/pi-effort@2.0.0")));
  assert.ok(runCalls.includes("zew1me-pi-clear-2.0.0.tgz"));
  assert.ok(runCalls.filter((name) => name === "zew1me-pi-effort-2.0.0.tgz").length >= 2);
});
