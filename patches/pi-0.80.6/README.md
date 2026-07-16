# pi 0.80.6 `/skills` patch

This directory contains a version-specific unified patch that changes pi skills from automatically loaded prompt context to an opt-in catalog with explicit activation. It is derived from the published `@earendil-works/pi-coding-agent@0.80.6` npm package.

## Contents

- `skills.patch` — the runtime and documentation changes.
- `baseline.sha256` — SHA-256 checksums for files that must match the clean 0.80.6 package.
- `baseline.absent` — paths that must not exist in the clean package.
- `patched.sha256` — SHA-256 checksums expected after applying `skills.patch`.

The installer verifies the package version and baseline before modifying anything. It applies the patch to staged copies, verifies their patched checksums, then atomically replaces the installed files with rollback on a replacement failure. A package already matching `patched.sha256` is left unchanged. Any unknown or mixed state is rejected rather than overwritten.

## Behavior

- Discovered skills form a catalog but are not injected into the system prompt by default.
- Active skills can be configured globally in `~/.pi/agent/skills.json` or per repository in `~/.pi/agent/repo-skills.json`.
- `/skills active`, `list`, `search`, `add`, `remove`, and `reload` are available interactively.
- `pi skills ...` provides the corresponding CLI operations.
- `--no-skills` suppresses global and repository skills while preserving explicit `--skill` paths.
- Repository keys prefer `upstream`, then `origin`, then other remotes, with a local-path fallback.

Do not apply this patch to another pi version without regenerating the patch and checksum manifests from that version’s clean package.
