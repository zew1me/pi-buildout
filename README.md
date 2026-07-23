# pi-buildout

Local pi customizations and supporting notes used to make pi the desired coding-agent harness.

| Component                              | Purpose                                                                                     | Documentation                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `extensions/clear`                     | `/clear`: replace the current session and disclose project instructions, skills, and tools  | [`extensions/clear/README.md`](extensions/clear/README.md)                           |
| `extensions/markdown-backlinks`        | Track `@file.ext` pointers found in Markdown and suggest reading them                       | [`extensions/markdown-backlinks/README.md`](extensions/markdown-backlinks/README.md) |
| `extensions/effort`                    | `/effort`: select and persist thinking effort                                               | [`extensions/effort/README.md`](extensions/effort/README.md)                         |
| `extensions/router`                    | Shadow-first, task-leased model and prompt-profile routing                                  | [`extensions/router/README.md`](extensions/router/README.md)                         |
| `extensions/subagents`                 | Natural-language creation and control of isolated, recursively nestable Pi subagents        | [`extensions/subagents/README.md`](extensions/subagents/README.md)                   |
| `.agents/skills/installed-pi-patching` | Notes for patching the installed pi skill-loading behavior                                  | [skill README](.agents/skills/installed-pi-patching/README.md)                       |
| `patches/pi-<version>`                 | Versioned runtime snapshots for the opt-in `/skills` behavior, one per supported pi version | [`patches/pi-0.80.6/README.md`](patches/pi-0.80.6/README.md)                         |

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

The installer verifies the installed pi package against the versioned `/skills` patch baseline, stages and verifies the
patch, then replaces its runtime files. It does not modify pi settings. Use `--skip-skill-loading-patch` to install only
the extensions.

## Development and quality checks

Use Node.js 22.19 or newer. Install [ShellCheck](https://www.shellcheck.net/) and the pinned npm dependencies, which
also installs the repository's Git hooks:

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
