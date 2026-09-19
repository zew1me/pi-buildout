# pi 0.84.4 `/skills` patch

This directory contains a version-specific unified patch that changes pi skills from automatically loaded prompt context to an opt-in catalog with explicit activation. It is derived from the published `@earendil-works/pi-coding-agent@0.84.4` package.

## Contents

- `skills.patch` — the runtime and documentation changes.
- `baseline.sha256` — SHA-256 checksums for files that must match the clean 0.84.4 package.
- `baseline.absent` — paths that must not exist in the clean package.
- `patched.sha256` — SHA-256 checksums expected after applying `skills.patch`.
- `pre-lock-patched.sha256` and `pre-lock-upgrade.patch` — the recognized state and migration for installations patched before path normalization and serialized configuration updates were included.

The installer verifies the package version and baseline before modifying anything. It applies the patch to staged copies, verifies their patched checksums, then replaces each installed file atomically, with rollback on a replacement failure. A package already matching `patched.sha256` is left unchanged. Any unknown or mixed state is rejected rather than overwritten.

User-provided tilde and relative skill sources are resolved to absolute paths before session activation or persistence. Persisted global and repository skill updates lock the applicable JSON file across the complete read-modify-write transaction, preventing concurrent CLI processes from discarding one another's changes.

`scripts/skills-patch-dispatch.test.mjs` extracts the interactive `/skills` dispatch and the shared
`runSkillsCommand` from `skills.patch` and exercises them directly, so the patched runtime stays the single source
of truth for those tests.

Because pi 0.84.4 dispatches through bundled entrypoints, the patch also replaces `dist/bundle/cli.js` and
`dist/bundle/rpc-entry.js` with thin wrappers around the patched unbundled runtime. This keeps `pi skills` and RPC
child sessions on the patched skill loader instead of the untouched generated bundle.

Do not apply this patch to another pi version without regenerating the patch and checksum manifests from that version’s clean package.
