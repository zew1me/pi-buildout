export type MarkdownBacklink = { sourcePath: string; pointer: string; targetPath: string };

/** Find @file.ext references in Markdown text. */
export function findMarkdownPointers(text: string): string[] {
  const found = new Set<string>();
  const pattern = /(^|[\s([{"'`])@([^\s<>()[\]{},;:"'`]+\.[A-Za-z0-9][^\s<>()[\]{},;:"'`]*)/gm;
  for (const match of text.matchAll(pattern)) {
    if (match[2]) found.add(`@${match[2].replace(/[.,!?]+$/, "")}`);
  }
  return [...found];
}

export function formatBacklinkTable(backlinks: MarkdownBacklink[]): string {
  if (backlinks.length === 0) return "";
  const rows = [...backlinks]
    .sort((a, b) => a.targetPath.localeCompare(b.targetPath) || a.sourcePath.localeCompare(b.sourcePath))
    .map((link) => `- \`${link.pointer}\` → \`${link.targetPath}\` (from \`${link.sourcePath}\`)`)
    .join("\n");
  const description = [
    "The following file pointers were found in Markdown files. Treat each as a reasonable candidate for a ",
    "`read` tool call when relevant. The pointer remains listed until the target is read successfully or is found ",
    "to be missing; missing targets are removed.",
  ].join("");
  return `\n\n## Markdown file pointers\n\n${description}\n\n${rows}`;
}
