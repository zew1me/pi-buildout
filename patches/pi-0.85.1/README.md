# pi 0.85.1 `/skills` patch

This directory contains a version-specific unified patch that changes pi skills from automatically loaded prompt context to an opt-in catalog with explicit activation. The asynchronous catalog includes fixed global/project directories plus package `skills/` and `pi.skills` declarations and global/trusted-project `settings.skills` entries. It is derived from the published `@earendil-works/pi-coding-agent@0.85.1` package.

## Contents

- `skills.patch` — the runtime, bundled-entrypoint, and documentation changes.
- `baseline.sha256` — SHA-256 checksums for files that must match the clean 0.85.1 package.
- `baseline.absent` — paths that must not exist in the clean package.
- `patched.sha256` — SHA-256 checksums expected after applying `skills.patch`.
- `legacy-patched.sha256` and `legacy-upgrade.patch` — the recognized state and migration for installations patched before bundled entrypoints and expanded catalog sources were included.
- `pre-validation-patched.sha256` and `pre-validation-upgrade.patch` — the exact patched state recorded by repository commit `c8bbfc6` and its migration to the current patch, which adds strict configuration validation and remote-port preservation.

The installer derives its complete replacement set from `patched.sha256`, verifies the package version and baseline before modifying anything, applies the patch to staged copies, verifies their patched checksums, then replaces each installed file atomically, with rollback on a replacement failure. Upgrade manifests are limited to exact full-file states previously produced by this repository; a matching package version alone never authorizes an upgrade. A package already matching `patched.sha256` is left unchanged. Any unknown or mixed state is rejected and must be restored to the clean package rather than overwritten.

`scripts/skills-patch-dispatch.test.mjs` exercises the interactive `/skills` dispatch,
`scripts/skills-patch-entrypoint.test.mjs` verifies the bundled CLI delegate and migration manifests, and
`scripts/skills-catalog.test.mjs` applies this patch to the pinned package and verifies fixed, package, and settings
catalog sources, trust boundaries, precedence, activation through the packaged CLI entrypoint, and generated checksums.

Because pi 0.85.1 dispatches through bundled entrypoints, the patch also replaces `dist/bundle/cli.js` and
`dist/bundle/rpc-entry.js` with thin wrappers around the patched unbundled runtime. This keeps `pi skills` and RPC child
sessions on the patched skill loader instead of the untouched generated bundle.

Do not apply this patch to another pi version without regenerating the patch and checksum manifests from that version’s clean package.
