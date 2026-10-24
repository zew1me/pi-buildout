# pi-buildout

Local pi customizations and supporting notes used to make pi the desired coding-agent harness.

| Component                              | Purpose                                                                                     | Documentation                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `extensions/clear`                     | `/clear`: replace the current session and disclose project instructions, skills, and tools  | [`extensions/clear/README.md`](extensions/clear/README.md)                           |
| `extensions/markdown-backlinks`        | Track `@file.ext` pointers found in Markdown and suggest reading them                       | [`extensions/markdown-backlinks/README.md`](extensions/markdown-backlinks/README.md) |
| `extensions/effort`                    | `/effort`: select and persist thinking effort                                               | [`extensions/effort/README.md`](extensions/effort/README.md)                         |
| `extensions/subagents`                 | Natural-language creation and control of isolated, recursively nestable Pi subagents        | [`extensions/subagents/README.md`](extensions/subagents/README.md)                   |
| `.agents/skills/installed-pi-patching` | Notes for patching the installed pi skill-loading behavior                                  | [skill README](.agents/skills/installed-pi-patching/README.md)                       |
| `patches/pi-<version>`                 | Versioned runtime snapshots for the opt-in `/skills` behavior, one per supported pi version | [`patches/pi-1.4.0/README.md`](patches/pi-1.4.0/README.md)                           |
| `pi-overlay`                           | Authored TypeScript the newest `/skills` patch is generated from                            | [`pi-overlay/README.md`](pi-overlay/README.md)                                       |

## Installation

Public npm packages are defined under [`packages/`](packages/README.md), one per extension plus a separate, explicitly
invoked `/skills` patch CLI. See that guide for npm installation commands, the version-bump-driven CI release policy,
and the required npm trusted-publisher setup. Packages become installable after their first publish.

From this repository, install the packaged extensions into the default pi extension directory:

```bash
./scripts/install-extensions.sh
```

Use `PI_AGENT_DIR` to select another pi agent directory:

```bash
PI_AGENT_DIR=/tmp/pi-agent ./scripts/install-extensions.sh
```

For patching, discovery checks the exact `@earendil-works/pi-coding-agent` package identity. It supports direct CLI
links, Homebrew wrappers, and direct or symlinked managed launchers in `<agent>/bin/pi` using
`<agent>/install/current-version`. Managed discovery requires either both literal launcher signatures
`PI_MANAGED_INSTALL_ROOT=` and `/install/current-version`, or `install/managed-install.json` with
`kind: pi-managed-install`, numeric `schemaVersion: 1`, and `layout: releases-v1`. Launchers are inspected, never
executed. A recognized but broken managed installation (even a missing install directory) stops discovery instead of
patching an unrelated npm-global Pi; the active package's version must match the pointer. Unrelated sibling `install`
paths, pointers, and releases do not change ordinary wrapper lookup or version-manager shims' npm-global fallback.
Extension-only installation does not require Pi discovery.

For a custom pi installation whose package path cannot be derived from `pi`, point `PI_PACKAGE_DIR` to the directory
containing pi's `package.json`:

```bash
PI_PACKAGE_DIR=/opt/pi/lib/node_modules/@earendil-works/pi-coding-agent ./scripts/install-extensions.sh
```

The installer verifies the installed pi package against the versioned `/skills` patch baseline, derives the complete set
of runtime files from that patch's checksum manifest, stages and verifies the patch, then replaces those files. For
bundled pi releases, the versioned patch delegates the published entrypoints to the patched unbundled runtime. The
installer can also migrate recognized earlier patch states and rejects unknown or mixed states. It does not modify pi
settings. Use `--skip-skill-loading-patch` to install only the extensions.

### Where the `/skills` patch comes from

The patch is **generated, not hand-authored**. Reviewed TypeScript in [`pi-overlay`](pi-overlay) is the source of truth;
each `patches/pi-<version>/*` is produced from it.

The repository supports pi 1.0.3 and newer. It keeps the latest patched pi release and at most four previous patched
releases, so at most five `patches/pi-<version>` directories exist. Today those are 1.4.0 (latest), 1.3.0, 1.1.0, 1.0.4,
and 1.0.3. When a new patch would make a sixth, the oldest patch directory and its `pi-overlay/versions/<version>`
inputs are deleted in the same change. The installer refuses to patch any pi release without a patch directory; use
`--skip-skill-loading-patch` to install only the extensions for those releases.

Regenerate or check a patch with:

```bash
npm run patches:build                                   # regenerate every versioned patch and its checksum manifests
npm run patches:check                                   # check every versioned patch in pi-overlay/versions
node scripts/build-pi-patch.mjs --version 1.0.3 --check # check only the 1.0.3 patch
node scripts/build-pi-patch.mjs --version 1.0.4 --check # check only the 1.0.4 patch
node scripts/build-pi-patch.mjs --version 1.1.0 --check # check only the 1.1.0 patch
node scripts/build-pi-patch.mjs --version 1.3.0 --check # check only the 1.3.0 patch
node scripts/build-pi-patch.mjs --version 1.4.0 --check # check only the 1.4.0 patch
```

The pipeline fetches the pinned upstream release source archive and npm tarball, verifies both against checksums
committed in `pi-overlay/versions/<version>/upstream.json`, and proves the unmodified pinned source rebuilds the
published runtime byte-for-byte before it will emit anything. It also holds edits to pre-existing upstream files to a
declared budget, so logic that creeps into pi's own files fails the build. Regeneration is network-bound and builds pi's
workspace packages, so it runs in its own scheduled CI job rather than on every pull request.

## Development and quality checks

Use Node.js 22.19 or newer and Pi 1.0.3 or newer. The authored extensions, overlay, and scripts are developed and tested
against the minimum supported release, Pi `1.0.3`, with every `@earendil-works/*` package held at `1.0.3`. Do not use Pi
APIs introduced after 1.0.3. The installed-baseline patch tests use that same development dependency; no separate
baseline alias is needed. Releases before 1.0.3 are unsupported and have no retained patch artifacts. Install
[ShellCheck](https://www.shellcheck.net/) and the pinned npm dependencies, which also installs the repository's Git
hooks:

```bash
brew install shellcheck # macOS; use the equivalent package on other platforms
npm install
```

Run the complete local quality gate with:

```bash
npm run check
```

The gate checks Prettier formatting (120-column width and LF line endings), strict type-aware ESLint rules, Markdown
style, shell scripts, TypeScript types, tests, unused code and dependencies with Knip, and committed secrets. Run
`npm run audit` separately to check the dependency tree for known high-severity vulnerabilities.

The pre-commit hook auto-fixes and re-stages supported staged files with Prettier, ESLint, and Markdownlint. The
pre-push hook is deliberately conservative: it runs the complete read-only `npm run check` gate and rejects the push
instead of modifying files. Files in `patches/` are upstream runtime snapshots, so authored-code formatting and lint
checks intentionally leave them unchanged.

## Verification

Run all extension helper tests:

```bash
status=0
for test in extensions/*/*.test.mjs; do node --test "$test" || status=$?; done
exit "$status"
```

Extensions are TypeScript modules loaded directly by pi's extension loader. Use `/reload` after reinstalling them in a
running pi session.
