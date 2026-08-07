# pi 0.84.0 `/skills` patch

This directory contains a version-specific unified patch that changes pi skills from automatically loaded prompt context to an opt-in catalog with explicit activation. It is derived from the published `@earendil-works/pi-coding-agent@0.84.0` npm package.

## Contents

- `skills.patch` — the runtime and documentation changes.
- `baseline.sha256` — SHA-256 checksums for files that must match the clean 0.84.0 package.
- `baseline.absent` — paths that must not exist in the clean package.
- `patched.sha256` — SHA-256 checksums expected after applying `skills.patch`.

The installer verifies the package version and baseline before modifying anything. It applies the patch to staged copies, verifies their patched checksums, then atomically replaces the installed files with rollback on a replacement failure. A package already matching `patched.sha256` is left unchanged. Any unknown or mixed state is rejected rather than overwritten.

Do not apply this patch to another pi version without regenerating the patch and checksum manifests from that version’s clean package.
