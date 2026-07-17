# pi-buildout

Local pi customizations and supporting notes used to make pi the desired coding-agent harness.

| Component | Purpose | Documentation |
|---|---|---|
| `extensions/clear` | `/clear`: replace the current session and disclose project instructions, skills, and tools | [`extensions/clear/README.md`](extensions/clear/README.md) |
| `extensions/markdown-backlinks` | Track `@file.ext` pointers found in Markdown and suggest reading them | [`extensions/markdown-backlinks/README.md`](extensions/markdown-backlinks/README.md) |
| `extensions/effort` | `/effort`: select and persist thinking effort | [`extensions/effort/README.md`](extensions/effort/README.md) |
| `.agents/skills/installed-pi-patching` | Notes for patching the installed pi skill-loading behavior | [skill README](.agents/skills/installed-pi-patching/README.md) |
| `patches/pi-0.80.6` | Versioned runtime snapshot for the opt-in `/skills` behavior | [`patches/pi-0.80.6/README.md`](patches/pi-0.80.6/README.md) |

## Installation

From this repository, install the packaged extensions into the default pi extension directory:

```bash
./scripts/install-extensions.sh
```

Use `PI_AGENT_DIR` to select another pi agent directory:

```bash
PI_AGENT_DIR=/tmp/pi-agent ./scripts/install-extensions.sh
```

For a custom pi installation whose package path cannot be derived from `pi`, point `PI_PACKAGE_DIR` to the directory containing pi's `package.json`:

```bash
PI_PACKAGE_DIR=/opt/pi/lib/node_modules/@earendil-works/pi-coding-agent ./scripts/install-extensions.sh
```

The installer verifies the installed pi package against the versioned `/skills` patch baseline, stages and verifies the patch, then replaces its runtime files. It does not modify pi settings. Use `--skip-skill-loading-patch` to install only the extensions.

## Verification

Run all extension helper tests:

```bash
status=0
for test in extensions/*/*.test.mjs; do node --test "$test" || status=$?; done
exit "$status"
```

Extensions are TypeScript modules loaded directly by pi's extension loader. Use `/reload` after reinstalling them in a running pi session.
