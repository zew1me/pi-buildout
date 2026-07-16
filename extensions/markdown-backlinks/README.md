# Markdown backlinks

Tracks references such as `@README.md` and `@src/app.ts` in Markdown files.

When pointers are found, the extension appends a table to the system prompt showing the source Markdown file and target. It tells the model that reading the target is a reasonable `read` tool call. A pointer is removed after the target is read successfully or is found to be missing. Markdown files are inspected when pi loads them as context or when the `read` tool returns them.

## Install

Run `scripts/install-extensions.sh` from the repository root, then use `/reload` in pi.

## Test

```bash
node --test extensions/markdown-backlinks/index.test.mjs
```
