> pi can create skills. Ask it to build one for your use case.

# Skills

Skills are self-contained capability packages that the agent loads on-demand. A skill provides specialized workflows, setup instructions, helper scripts, and reference documentation for specific tasks.

Pi implements the [Agent Skills standard](https://agentskills.io/specification), warning about most violations but remaining lenient. Pi allows skill names to differ from their parent directory even though the standard disallows it; that rule is suboptimal for shared skill directories used across multiple agent harnesses.

## Table of Contents

- [Locations](#locations)
- [How Skills Work](#how-skills-work)
- [Skill Commands](#skill-commands)
- [Skill Structure](#skill-structure)
- [Frontmatter](#frontmatter)
- [Validation](#validation)
- [Example](#example)
- [Skill Repositories](#skill-repositories)

## Locations

> **Security:** Skills can instruct the model to perform any action and may include executable code the model invokes. Review skill content before use.

Pi starts with no active skills. Skill directories, packages, and settings form a catalog, but catalog entries are not injected into the system prompt unless explicitly enabled.

Active skills are loaded from:

- Session/CLI: `--skill <path>` (repeatable, additive even with `--no-skills`)
- Global: `~/.pi/agent/skills.json`
- Repository: `~/.pi/agent/repo-skills.json`, keyed by git repository identity

Catalog sources include:

- Global:
  - `~/.pi/agent/skills/`
  - `~/.agents/skills/`
- Project (only after the project is trusted):
  - `.pi/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Packages: `skills/` directories or `pi.skills` entries in `package.json`
- Settings: `skills` array with files or directories

Enable global skills with `~/.pi/agent/skills.json`:

```json
{
  "enabled": [
    "~/.agents/skills/code-review-and-quality",
    { "source": "~/.agents/skills/browser-testing-with-devtools" }
  ]
}
```

Enable repository-scoped skills with `~/.pi/agent/repo-skills.json`:

```json
{
  "github.com:earendil-works/pi-mono": {
    "enabled": ["~/.agents/skills/pi-development"]
  },
  "local:~/Documents/repos/private-tool": {
    "enabled": ["~/.agents/skills/private-tool"]
  }
}
```

Repository keys are resolved from git remotes in this order: `upstream`, then `origin`, then the first configured remote. Remote URLs are normalized so `git@github.com:earendil-works/pi-mono.git`, `https://github.com/earendil-works/pi-mono`, and `ssh://git@github.com/earendil-works/pi-mono.git` all become `github.com:earendil-works/pi-mono`. If no remote exists, pi falls back to `local:<repo-root-relative-to-$HOME>`, such as `local:~/Documents/repos/private-tool`.

Discovery rules:
- In `~/.pi/agent/skills/` and `.pi/skills/`, direct root `.md` files are discovered as individual skills
- In all skill locations, directories containing `SKILL.md` are discovered recursively
- In `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored

Use `--no-skills` to suppress global/repository active skills; explicit `--skill` paths still load.

### Using Skills from Other Harnesses

To use skills from Claude Code or OpenAI Codex, add their directories to settings:

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

For project-level Claude Code skills, add to `.pi/settings.json`:

```json
{
  "skills": ["../.claude/skills"]
}
```

## How Skills Work

1. At startup, pi resolves active skills from session/CLI, global, and repository-scoped configuration.
2. The system prompt includes only active skills in XML format per the [specification](https://agentskills.io/integrate-skills).
3. When a task matches, the agent uses `read` to load the full SKILL.md (models don't always do this; use prompting or `/skill:name` to force it).
4. The agent follows the instructions, using relative paths to reference scripts and assets.

This is progressive disclosure: only active skill descriptions are in context, full instructions load on-demand.

## Skill Commands

Manage activation with either the interactive `/skills` command or the one-shot CLI:

```bash
/skills active
/skills list
/skills search browser
/skills add browser-testing-with-devtools --session
/skills add browser-testing-with-devtools --repo
/skills remove browser-testing-with-devtools --global
/skills reload

pi skills active
pi skills list
pi skills search browser
pi skills add browser-testing-with-devtools --global
pi skills add browser-testing-with-devtools --repo
pi skills remove browser-testing-with-devtools --repo
```

`--session` is interactive-only and lasts until the session ends. `--global` and `--repo` persist to their respective JSON configuration. `list` and `search` show file-based catalog skills; `active` shows the currently configured global and repository entries.

Active skills also register as `/skill:name` commands:

```bash
/skill:brave-search           # Load and execute the skill
/skill:pdf-tools extract      # Load skill with arguments
```

Arguments after the command are appended to the skill content as `User: <args>`.

Toggle skill commands via `/settings` in interactive mode or in `settings.json`:

```json
{
  "enableSkillCommands": true
}
```

## Skill Structure

A skill is a directory with a `SKILL.md` file. Everything else is freeform.

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md Format

````markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:
```bash
cd /path/to/skill && npm install
```

## Usage

```bash
./scripts/process.sh <input>
```
````

Use relative paths from the skill directory:

```markdown
See [the reference guide](references/REFERENCE.md) for details.
```

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase a-z, 0-9, hyphens. Unlike the standard, Pi does not require this to match the parent directory because that standard requirement is suboptimal for shared skill directories. |
| `description` | Yes | Max 1024 chars. What the skill does and when to use it. |
| `license` | No | License name or reference to bundled file. |
| `compatibility` | No | Max 500 chars. Environment requirements. |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools (experimental). |
| `disable-model-invocation` | No | When `true`, skill is hidden from system prompt. Users must use `/skill:name`. |

### Name Rules

- 1-64 characters
- Lowercase letters, numbers, hyphens only
- No leading/trailing hyphens
- No consecutive hyphens
Pi does not require the name to match the parent directory. The Agent Skills standard does, but that requirement is suboptimal for shared skill directories used by multiple tools.

Valid: `pdf-processing`, `data-analysis`, `code-review`
Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description Best Practices

The description determines when the agent loads the skill. Be specific.

Good:
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

Poor:
```yaml
description: Helps with PDFs.
```

## Validation

Pi validates skills against the Agent Skills standard. Most issues produce warnings but still load the skill:

- Name exceeds 64 characters or contains invalid characters
- Name starts/ends with hyphen or has consecutive hyphens
- Description exceeds 1024 characters

Unknown frontmatter fields are ignored.

**Exception:** Skills with missing description are not loaded.

Name collisions (same name from different locations) warn and keep the first skill found.

## Example

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**
````markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && npm install
```

## Search

```bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
```

## Extract Page Content

```bash
./content.js https://example.com
```
````

## Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Web search, browser automation, Google APIs, transcription
