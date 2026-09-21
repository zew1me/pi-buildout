import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

/** Returns the lines the patch adds to a given file. */
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
