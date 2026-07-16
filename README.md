# pi-buildout

Local pi customizations and supporting notes used to make pi the desired coding-agent harness.

| Component | Purpose | Documentation |
|---|---|---|
| `extensions/clear` | `/clear`: replace the current session and disclose project instructions, skills, and tools | [`extensions/clear/README.md`](extensions/clear/README.md) |
| `extensions/markdown-backlinks` | Track `@file.ext` pointers found in Markdown and suggest reading them | [`extensions/markdown-backlinks/README.md`](extensions/markdown-backlinks/README.md) |
| `extensions/effort` | `/effort`: select and persist thinking effort | [`extensions/effort/README.md`](extensions/effort/README.md) |
| `.agents/skills/installed-pi-patching` | Notes for patching the installed pi skill-loading behavior | [skill README](.agents/skills/installed-pi-patching/README.md) |
| `docs/superpowers` | Design specifications and implementation plans | [`docs/superpowers/README.md`](docs/superpowers/README.md) |

## Installation

From this repository, install the packaged extensions into the default pi extension directory:

```bash
./scripts/install-extensions.sh
```

Use `PI_AGENT_DIR` to select another pi agent directory:

```bash
PI_AGENT_DIR=/tmp/pi-agent ./scripts/install-extensions.sh
```

The installer copies the extension directories and does not modify pi's installed runtime or settings.

## Verification

Run all extension helper tests:

```bash
for test in extensions/*/*.test.mjs; do node --test "$test"; done
```

Extensions are TypeScript modules loaded directly by pi's extension loader. Use `/reload` after reinstalling them in a running pi session.
