import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const patchPath = fileURLToPath(new URL("../patches/pi-0.84.2/skills.patch", import.meta.url));

function countOccurrences(text, character) {
  return text.split(character).length - 1;
}

/**
 * Extract a brace-balanced block that the patch adds, keeping the patched runtime as the single
 * source of truth for these tests instead of restating its dispatch logic here.
 */
function extractAddedBlock(patchText, signature) {
  const lines = patchText.split("\n");
  const start = lines.findIndex((line) => line.startsWith("+") && line.slice(1).trimStart().startsWith(signature));
  assert.notEqual(start, -1, `patch does not add a block starting with ${signature}`);

  const block = [];
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    assert.ok(line.startsWith("+"), `block starting with ${signature} is not fully added by the patch`);
    const source = line.slice(1);
    block.push(source);
    depth += countOccurrences(source, "{") - countOccurrences(source, "}");
    if (depth === 0) {
      return block.join("\n");
    }
  }
  assert.fail(`block starting with ${signature} is not brace balanced`);
}

async function loadPatchedHandler() {
  const patchText = await readFile(patchPath, "utf8");
  const usageSource = extractAddedBlock(patchText, "function usage(");
  const runSkillsCommandSource = extractAddedBlock(patchText, "export function runSkillsCommand(");
  const handlerSource = extractAddedBlock(patchText, "async handleSkillsCommand(");

  // Catalog and persistence helpers throw so that any dispatch beyond the paths under test is loud.
  const moduleSource = [
    "function unavailable(name) {",
    "  return () => {",
    "    throw new Error(`unexpected call to ${name}`);",
    "  };",
    "}",
    'const getActiveSkillEntries = unavailable("getActiveSkillEntries");',
    'const getSkillCatalog = unavailable("getSkillCatalog");',
    'const updatePersistedSkill = unavailable("updatePersistedSkill");',
    'const scopeFromArgs = unavailable("scopeFromArgs");',
    usageSource,
    runSkillsCommandSource,
    "export function attachSkillsHandler(instance, { getAgentDir, Spacer, Text }) {",
    "  Object.assign(instance, {",
    handlerSource,
    "  });",
    "  return instance;",
    "}",
  ].join("\n");

  const directory = await mkdtemp(join(tmpdir(), "skills-patch-dispatch-"));
  const modulePath = join(directory, "patched-dispatch.mjs");
  await writeFile(modulePath, moduleSource, "utf8");
  const { attachSkillsHandler } = await import(pathToFileURL(modulePath).href);
  return attachSkillsHandler;
}

const attachSkillsHandler = await loadPatchedHandler();

function createInteractiveModeStub() {
  const calls = { reloads: 0, warnings: [], errors: [], rendered: 0 };
  const instance = {
    editor: {
      setText() {},
    },
    sessionManager: {
      getCwd: () => process.cwd(),
    },
    session: {
      isStreaming: false,
      isCompacting: false,
      resourceLoader: {
        additionalSkillPaths: [],
        resolveSkillEntry: () => undefined,
      },
    },
    chatContainer: {
      addChild() {
        calls.rendered += 1;
      },
    },
    ui: {
      requestRender() {},
    },
    showWarning(text) {
      calls.warnings.push(text);
    },
    showError(text) {
      calls.errors.push(text);
    },
    handleReloadCommand() {
      calls.reloads += 1;
      return Promise.resolve();
    },
  };

  attachSkillsHandler(instance, {
    getAgentDir: () => join(process.cwd(), ".pi"),
    Spacer: class Spacer {},
    Text: class Text {},
  });

  return { instance, calls };
}

test("/skills reload triggers a reload", async () => {
  const { instance, calls } = createInteractiveModeStub();

  await instance.handleSkillsCommand("/skills reload");

  assert.equal(calls.reloads, 1);
  assert.deepEqual(calls.warnings, []);
  assert.deepEqual(calls.errors, []);
  assert.equal(calls.rendered, 0);
});

test("/skills reload tolerates surrounding whitespace", async () => {
  const { instance, calls } = createInteractiveModeStub();

  await instance.handleSkillsCommand("/skills   reload  ");

  assert.equal(calls.reloads, 1);
  assert.deepEqual(calls.warnings, []);
});

test("/skills reload with an extra argument shows usage instead of reloading", async () => {
  const { instance, calls } = createInteractiveModeStub();

  await instance.handleSkillsCommand("/skills reload unexpected");

  assert.equal(calls.reloads, 0);
  assert.equal(calls.errors.length, 0);
  assert.equal(calls.warnings.length, 1);
  assert.match(calls.warnings[0], /^Usage: \/skills <active\|list\|search\|add\|remove\|reload>$/m);
  assert.equal(calls.rendered, 0);
});

test("/skills without a subcommand shows usage instead of reloading", async () => {
  const { instance, calls } = createInteractiveModeStub();

  await instance.handleSkillsCommand("/skills");

  assert.equal(calls.reloads, 0);
  assert.equal(calls.warnings.length, 1);
  assert.match(calls.warnings[0], /^Usage: \/skills </m);
});
