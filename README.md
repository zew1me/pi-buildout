# pi-buildout

Local pi customizations and supporting notes used to make pi the desired coding-agent harness.

| Component                              | Purpose                                                                                     | Documentation                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `extensions/clear`                     | `/clear`: replace the current session and disclose project instructions, skills, and tools  | [`extensions/clear/README.md`](extensions/clear/README.md)                           |
| `extensions/markdown-backlinks`        | Track `@file.ext` pointers found in Markdown and suggest reading them                       | [`extensions/markdown-backlinks/README.md`](extensions/markdown-backlinks/README.md) |
| `extensions/effort`                    | `/effort`: select and persist thinking effort                                               | [`extensions/effort/README.md`](extensions/effort/README.md)                         |
| `extensions/subagents`                 | Natural-language creation and control of isolated, recursively nestable Pi subagents        | [`extensions/subagents/README.md`](extensions/subagents/README.md)                   |
| `.agents/skills/installed-pi-patching` | Notes for patching the installed pi skill-loading behavior                                  | [skill README](.agents/skills/installed-pi-patching/README.md)                       |
| `patches/pi-<version>`                 | Versioned runtime snapshots for the opt-in `/skills` behavior, one per supported pi version | [`patches/pi-0.87.1/README.md`](patches/pi-0.87.1/README.md)                         |
| `pi-overlay`                           | Authored TypeScript the generated `/skills` patches (0.85.1 and later) come from            | [`pi-overlay/README.md`](pi-overlay/README.md)                                       |

## Installation

From this repository, install the packaged extensions into the default pi extension directory:

```bash
./scripts/install-extensions.sh
```

Use `PI_AGENT_DIR` to select another pi agent directory:

```bash
PI_AGENT_DIR=/tmp/pi-agent ./scripts/install-extensions.sh
```

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

From pi 0.85.1 the patch is **generated, not hand-authored**. Reviewed TypeScript in [`pi-overlay`](pi-overlay) is the
source of truth, and `patches/pi-0.85.1/*` and `patches/pi-0.87.1/*` are produced from it:

```bash
npm run patches:build                                    # regenerate every version's patch and checksum manifests
npm run patches:check                                    # fail if any version's committed artifacts are stale
node scripts/build-pi-patch.mjs --version 0.87.1 --check # one version only
```

The pipeline fetches the pinned upstream release source archive and npm tarball, verifies both against checksums
committed in `pi-overlay/versions/<version>/upstream.json`, and proves the unmodified pinned source rebuilds the
published runtime byte-for-byte before it will emit anything. It also holds edits to pre-existing upstream files to a
declared budget, so logic that creeps into pi's own files fails the build. Regeneration is network-bound and builds pi's
workspace packages, so it runs in its own scheduled CI job rather than on every pull request.

## Development and quality checks

Use Node.js 22.19 or newer. The authored extensions and test suite target Pi `0.85.1`; compatibility with older Pi
versions is not guaranteed. The `/skills` patch tests run for every supported pi version; for a version other than the
pinned one, the tests that apply the patch to a real package skip unless `PI_SKILLS_TEST_PACKAGES` names a clean package
of that version (see [`patches/pi-0.87.1/README.md`](patches/pi-0.87.1/README.md#tests)). Install
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
