---
name: patch-skill-loading-behavior
description:
  Use when modifying skill discovery, activation, or prompt-loading behavior in the locally installed pi coding agent
  package
---

# Patch Skill Loading Behavior

This is part of the installed-pi-patching skill collection.

Use this when the task is to change skill discovery, activation, or prompt-loading behavior in the installed `pi`
package on this machine, especially when there is no normal source checkout available.

## Orientation

This folder is a buildout/notes repo, not necessarily the package source. The installed package on this Homebrew machine
is usually under:

```text
/opt/homebrew/Cellar/pi-coding-agent/<version>/libexec/lib/node_modules/@earendil-works/pi-coding-agent
```

For installation methods and platform-specific package-manager instructions, see the upstream
[Pi Quick Start](https://github.com/earendil-works/pi#quick-start).

Start from the live package that `pi` resolves to. Useful pointers:

```bash
which pi
pi --version
ls /opt/homebrew/Cellar/pi-coding-agent
```

Important files in the installed pi 0.80.6 package were, at the time this was written:

```text
dist/core/resource-loader.js      # resource discovery/loading, skills/prompts/themes/extensions
dist/core/skill-management.js     # global/repo config mutation, catalog/list/search, git repo identity
dist/core/skills.js               # skill parsing/formatting
dist/core/package-manager.js      # package/settings resource resolution
dist/core/agent-session.js        # /skill invocation, command listing, session wiring
dist/modes/interactive/*          # /skills handling, startup header, and interactive UI
dist/main.js                      # one-shot `pi skills ...` dispatch
dist/cli/args.js                  # CLI flags/help text
docs/skills.md                    # skill docs
README.md                         # high-level docs and CLI table
```

Source maps may exist, but the editable runtime is `dist/*.js`. Prefer changing the smallest runtime surface that proves
the behavior.

## Working Pattern

1. **Locate the live install.** Do not assume the current folder is the package source.
2. **Write a small executable verification first.** A temp Node script that imports the installed `dist/` module is
   usually enough.
3. **Patch the installed runtime JS and docs.** Keep changes narrow and reversible.
4. **Verify with `node --check` and the behavior script.** Avoid calling providers or making API requests just to test
   local loading behavior.
5. **Leave breadcrumbs.** Summarize changed installed files and any repo-local skill/config files.

## Current Skill-Loading Patch Pointers

The opt-in skill-loading behavior is centered in:

```text
dist/core/resource-loader.js
```

Look near `DefaultResourceLoader.reload()` for the construction of `skillPaths`. The intended behavior is:

- session/CLI `--skill` paths load
- global active skills come from `~/.pi/agent/skills.json`
- repo active skills come from `~/.pi/agent/repo-skills.json`
- ordinary discovered/catalog skills do not enter the prompt by default
- `--no-skills` suppresses global/repo active skills but still allows explicit `--skill`

Repo keys should prefer `upstream`, then `origin`, then first remote, then fall back to
`local:<repo-root-relative-to-$HOME>`. Normalize common git URL forms to the same key, e.g.:

```text
git@github.com:earendil-works/pi-mono.git
https://github.com/earendil-works/pi-mono
ssh://git@github.com/earendil-works/pi-mono.git
```

all become:

```text
github.com:earendil-works/pi-mono
```

## Interactive and CLI Skill Management

The command surfaces are deliberately thin wrappers around `dist/core/skill-management.js`:

- interactive: `/skills active|list|search|add|remove|reload`
- CLI: `pi skills active|list|search|add|remove`
- session scope is interactive-only; mutate `resourceLoader.additionalSkillPaths` and reload
- global/repo scopes mutate JSON first, then reload so the current session reflects the change

Avoid adding separate configuration semantics in the TUI and CLI. Keep parsing, repo-key resolution, persistence, and
catalog queries in the shared core module.

## Verification Ideas

Create temp skills and temp agent dirs. Exercise these behaviors without network calls:

- default loader returns no skills even if `agentDir/skills/<name>/SKILL.md` exists
- `additionalSkillPaths` loads a session skill
- `agentDir/skills.json` enables a global skill
- `agentDir/repo-skills.json` enables a repo skill by normalized upstream URL
- `noSkills: true` ignores global/repo active skills

Example shape:

```js
import { DefaultResourceLoader } from "<installed>/dist/core/resource-loader.js";
const loader = new DefaultResourceLoader({ cwd, agentDir, additionalSkillPaths: [skillPath] });
await loader.reload();
console.log(loader.getSkills().skills.map((s) => s.name));
```

## Judgment Calls

Do not blindly recreate an old patch if the installed version changed. Re-read nearby code and adapt. Preserve existing
extension, prompt, theme, package, and trust behavior unless the task explicitly says otherwise. If a proper source
checkout appears later, prefer patching source and rebuilding over editing installed `dist/` directly.
