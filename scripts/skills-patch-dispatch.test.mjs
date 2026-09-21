import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Guards the wiring the patch installs, not the behaviour behind it.
 *
 * `/skills` has three dispatch surfaces — the interactive command, the one-shot CLI, and the builtin command
 * list — and all three must route into the shared skill-management module rather than carrying their own
 * copy of the logic. The behaviour itself is covered by `pi-overlay/skill-management-core.test.mjs` at the
 * TypeScript level and by `scripts/skills-catalog.test.mjs` against a really patched package.
 */
const patchPath = fileURLToPath(new URL("../patches/pi-0.85.1/skills.patch", import.meta.url));

/**
 * Returns the lines the patch adds to a given file.
 *
 * Only added lines, so this proves what the patch introduces but never what the patched file ends up
 * containing. Assertions that something is *absent* belong against the applied result instead — see
 * "the applied patch leaves no relocated implementation behind".
 */
function addedLinesFor(patchText, file) {
  const lines = patchText.split("\n");
  const start = lines.findIndex((line) => line === `+++ b/${file}`);
  assert.notEqual(start, -1, `patch does not touch ${file}`);

  const added = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("--- ") || line.startsWith("diff --git ")) break;
    if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
  }
  return added.join("\n");
}

const patchText = await readFile(patchPath, "utf8");

test("the builtin command list registers /skills with its argument hint", () => {
  const added = addedLinesFor(patchText, "dist/core/slash-commands.js");
  assert.match(added, /name: "skills"/u);
  assert.match(added, /argumentHint: "<active\|list\|search\|add\|remove\|reload>"/u);
});

test("interactive mode delegates /skills to the shared module", () => {
  const added = addedLinesFor(patchText, "dist/modes/interactive/interactive-mode.js");
  assert.match(added, /import \{ handleSkillsInteractive \} from "\.\.\/\.\.\/core\/skill-management\.js"/u);
  assert.match(added, /async handleSkillsCommand\(text\)/u);
  assert.match(added, /await handleSkillsInteractive\(text, \{/u);
  // Defining the handler is not enough: pi dispatches slash commands through an explicit `if (text === ...)`
  // chain, and BUILTIN_SLASH_COMMANDS carries only metadata. Without this branch the method is dead code and
  // `/skills` is submitted to the model as an ordinary message.
  assert.match(added, /if \(text === "\/skills" \|\| text\.startsWith\("\/skills "\)\) \{/u);
  assert.match(added, /await this\.handleSkillsCommand\(text\);/u);
  assert.doesNotMatch(added, /runSkillsCommand\(/u, "interactive mode must not re-implement the dispatch");
});

test("interactive mode forwards the session skill list so session scope can mutate it", () => {
  const added = addedLinesFor(patchText, "dist/modes/interactive/interactive-mode.js");
  assert.match(added, /additionalSkillPaths: this\.session\.resourceLoader\.additionalSkillPaths/u);
  assert.match(added, /reload: \(\) => this\.handleReloadCommand\(\)/u);
});

test("the one-shot CLI delegates pi skills to the shared module", () => {
  const added = addedLinesFor(patchText, "dist/main.js");
  assert.match(added, /import \{ handleSkillsCli \} from "\.\/core\/skill-management\.js"/u);
  assert.match(added, /if \(args\[0\] === "skills"\)/u);
  assert.match(added, /await handleSkillsCli\(\{/u);
});

test("the resource loader asks the shared module for active skills and keeps no skill API of its own", () => {
  const added = addedLinesFor(patchText, "dist/core/resource-loader.js");
  assert.match(added, /import \{ resolveActiveSkillPaths \} from "\.\/skill-management\.js"/u);
  assert.match(added, /await resolveActiveSkillPaths\(\{/u);
  for (const removed of ["getActiveSkillPaths", "resolveSkillEntry", "findCatalogSkillPath"]) {
    assert.doesNotMatch(added, new RegExp(`${removed}\\(`, "u"), `${removed} belongs in skill-management`);
  }
});

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The package-relative paths the patch writes, taken from its own `+++ b/` headers. */
function patchedPaths(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("+++ b/"))
    .map((line) => line.slice("+++ b/".length).trim());
}

async function applyPatchTo(target) {
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
      if (code === 0) resolvePromise();
      else reject(new Error(`patch exited with code ${String(code)}: ${stderr.trim()}`));
    });
    child.stdin.end(patchText);
  });
}

/**
 * Applies the patch to the installed 0.85.1 baseline and asserts against the complete resulting files.
 *
 * The negative claims above are checked against added lines only, so they would also hold if an
 * implementation survived untouched in the baseline. This is the check that actually rules that out.
 */
test("the applied patch leaves no relocated implementation behind", async (t) => {
  if (!(await exists(join(packageRoot, "package.json")))) {
    t.skip("the installed @earendil-works/pi-coding-agent package is unavailable");
    return;
  }

  const target = await mkdtemp(join(tmpdir(), "skills-dispatch-"));
  try {
    for (const path of patchedPaths(patchText)) {
      const source = join(packageRoot, path);
      if (!(await exists(source))) continue; // A file the patch creates.
      await mkdir(join(target, dirname(path)), { recursive: true });
      await cp(source, join(target, path));
    }
    await applyPatchTo(target);

    const interactive = await readFile(join(target, "dist/modes/interactive/interactive-mode.js"), "utf8");
    assert.match(interactive, /await this\.handleSkillsCommand\(text\);/u, "interactive mode must dispatch /skills");
    assert.doesNotMatch(interactive, /runSkillsCommand\(/u, "interactive mode must not re-implement the dispatch");

    const loader = await readFile(join(target, "dist/core/resource-loader.js"), "utf8");
    for (const removed of ["getActiveSkillPaths", "resolveSkillEntry", "findCatalogSkillPath"]) {
      assert.doesNotMatch(loader, new RegExp(`${removed}\\(`, "u"), `${removed} belongs in skill-management`);
    }
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
