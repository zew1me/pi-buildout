import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFreshContextDisclosure } from "./helpers.ts";
import clearExtension from "./index.ts";

describe("clearExtension", () => {
	it("loads and registers the clear command", () => {
		const commands = new Map();
		clearExtension({ registerCommand: (name, command) => commands.set(name, command) });

		assert.equal(
			commands.get("clear")?.description,
			"Discard conversation context and start fresh with project instructions, skills, and tools",
		);
	});
});

describe("buildFreshContextDisclosure", () => {
	it("discloses reloaded instruction files, skills, and active tools", () => {
		const disclosure = buildFreshContextDisclosure({
			contextFiles: [
				{ path: "/repo/AGENTS.md", content: "Use pnpm." },
				{ path: "/repo/CLAUDE.md", content: "Run tests." },
			],
			skills: [{ name: "release", description: "Prepare a release", filePath: "/skills/release/SKILL.md" }],
			selectedTools: ["read", "mcp_search"],
		});

		assert.match(disclosure, /Previous conversation context was discarded/);
		assert.match(disclosure, /<project_instructions path="\/repo\/AGENTS\.md">\nUse pnpm\./);
		assert.match(disclosure, /<project_instructions path="\/repo\/CLAUDE\.md">\nRun tests\./);
		assert.match(disclosure, /- release: Prepare a release \(\/skills\/release\/SKILL\.md\)/);
		assert.match(disclosure, /- read/);
		assert.match(disclosure, /- mcp_search/);
	});

	it("makes empty resource groups explicit", () => {
		const disclosure = buildFreshContextDisclosure({ contextFiles: [], skills: [], selectedTools: [] });

		assert.match(disclosure, /- \(none found in the current working directory\)/);
		assert.match(disclosure, /- \(none active\)/);
		assert.match(disclosure, /- \(none active; no MCP tools are configured\)/);
	});
});
