import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildFreshContextDisclosure } from "./helpers.ts";
import type { ContextFile } from "./helpers.ts";

const CONTEXT_FILE_NAMES = new Set(["AGENTS.MD", "CLAUDE.MD"]);

/** Read every AGENTS.md and CLAUDE.md variant directly in the working directory. */
async function loadCurrentDirectoryContextFiles(cwd: string): Promise<ContextFile[]> {
  let entries: string[];
  try {
    entries = await readdir(cwd);
  } catch {
    return [];
  }

  const files: ContextFile[] = [];
  for (const name of entries) {
    if (!CONTEXT_FILE_NAMES.has(name.toUpperCase())) continue;
    const path = join(cwd, name);
    try {
      files.push({ path, content: await readFile(path, "utf8") });
    } catch {
      // A disappearing or unreadable context file must not prevent a fresh session.
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export default function clearExtension(pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Discard conversation context and start fresh with project instructions, skills, and tools",
    handler: async (_args, ctx) => {
      // Session replacement is only safe after a running agent has fully settled.
      await ctx.waitForIdle();

      const result = await ctx.newSession({
        withSession: async (freshCtx) => {
          const options = freshCtx.getSystemPromptOptions();
          const contextFiles = await loadCurrentDirectoryContextFiles(freshCtx.cwd);
          const disclosure = buildFreshContextDisclosure({
            contextFiles,
            skills: options.skills ?? [],
            selectedTools: options.selectedTools ?? [],
          });

          // This context message ensures both AGENTS.md and CLAUDE.md are available even
          // when Pi's normal context discovery prefers one filename over the other.
          await freshCtx.sendMessage({
            customType: "fresh-context-disclosure",
            content: disclosure,
            display: true,
            details: {
              contextFiles: contextFiles.map((file) => file.path),
              skills: options.skills?.map((skill) => skill.name) ?? [],
              tools: options.selectedTools ?? [],
            },
          });
          freshCtx.ui.notify("Fresh context started; project instructions, skills, and tools were reloaded", "info");
        },
      });

      if (result.cancelled) {
        ctx.ui.notify("Fresh context cancelled", "info");
      }
    },
  });
}
