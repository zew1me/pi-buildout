import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findMarkdownPointers, formatBacklinkTable, type MarkdownBacklink } from "./markdown-backlinks/helpers.ts";

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export default function markdownBacklinksExtension(pi: ExtensionAPI) {
	const backlinks = new Map<string, MarkdownBacklink>();

	function removeTarget(targetPath: string): void {
		for (const [key, backlink] of backlinks) {
			if (backlink.targetPath === targetPath) backlinks.delete(key);
		}
	}

	function inspectMarkdown(sourcePath: string, content: string): void {
		if (!sourcePath.toLowerCase().endsWith(".md")) return;
		for (const pointer of findMarkdownPointers(content)) {
			const targetPath = resolve(dirname(sourcePath), pointer.slice(1));
			const key = `${sourcePath}\0${targetPath}`;
			if (existsSync(targetPath)) {
				backlinks.set(key, { sourcePath, pointer, targetPath });
			} else {
				backlinks.delete(key);
			}
		}
	}

	pi.on("session_start", async () => {
		backlinks.clear();
	});

	pi.on("before_agent_start", async (event) => {
		for (const file of event.systemPromptOptions.contextFiles ?? []) {
			inspectMarkdown(file.path, file.content);
		}

		const table = formatBacklinkTable([...backlinks.values()]);
		if (!table) return;
		return { systemPrompt: event.systemPrompt + table };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read") return;
		const rawPath = typeof event.input.path === "string" ? event.input.path : "";
		if (!rawPath) return;
		const targetPath = resolve(ctx.cwd, rawPath.startsWith("@") ? rawPath.slice(1) : rawPath);

		// A successful read resolves every pointer to that file. A failed read means
		// the pointer is stale, so remove it as well.
		removeTarget(targetPath);
		if (!event.isError) inspectMarkdown(targetPath, textFromContent(event.content));
	});
}
