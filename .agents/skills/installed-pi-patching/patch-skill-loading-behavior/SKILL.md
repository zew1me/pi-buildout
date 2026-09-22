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

Pi 0.84.4 and 0.85.1 dispatch the installed `pi` command and RPC entrypoint through `dist/bundle/`; their versioned
patches therefore also replace those two bundled entrypoints with wrappers around the patched unbundled runtime. Include
any such entrypoint files in the patch and checksum manifests when a release switches its package bin layout.

Pi 0.87.1 switched it again. `dist/bundle/cli.js` (the `bin`) is now a loader that calls `enableCompileCache()` and then
`createRequire(import.meta.url)("./cli-runtime.js")`; the bundled runtime lives in `dist/bundle/cli-runtime.js` plus
content-hashed `dist/bundle/chunks/`. The 0.87.1 patch replaces `dist/bundle/cli-runtime.js` and
`dist/bundle/rpc-entry.js` and leaves upstream's loader alone (pinned by checksum through an `"unchanged"` tracked file,
so the installer still verifies it), which relies on `require()` of the unbundled ES module graph (Node 22.19+, no
top-level await in that graph). Subagents start RPC children by re-running the bin with `--mode rpc`, so they reach the
patched runtime through that loader. For a new release, read `package.json` `bin` and `exports["./rpc-entry"]` and
follow each file to the first one that holds bundled code; that is the file to replace.

Source maps may exist, but the editable runtime is `dist/*.js`. Prefer changing the smallest runtime surface that proves
the behavior.

Since 0.85.1 the patch also ships `dist/core/skill-management-core.js` beside `dist/core/skill-management.js`. The core
file holds the logic and imports nothing; the other binds pi's modules to it.

## Preferred Process: Author TypeScript, Generate the Patch

For pi 0.85.1 and later this repository no longer hand-edits generated JavaScript. The authored source is the TypeScript
overlay in [`pi-overlay/`](../../../../pi-overlay), and `patches/pi-<version>/*` is generated from it by
`npm run patches:build`. Prefer that route whenever the change belongs in a shipped patch:

1. Put new logic in `pi-overlay/skill-management-core.ts`, which imports nothing and is unit-tested directly by
   `pi-overlay/skill-management-core.test.mjs`.
2. Bind anything from pi in `pi-overlay/skill-management.ts`, the only file that names pi modules.
3. Touch upstream files only through `pi-overlay/versions/<version>/integration.patch`, and only to add an import and a
   call site. The pipeline enforces a line budget on those edits and fails the build if it is exceeded, so logic that
   grows inside an upstream file is a build error rather than a review comment.
4. Run `npm run patches:build`, then `npm test`. Both regenerate and check every version under `pi-overlay/versions/`;
   add `PI_SKILLS_TEST_PACKAGES=<clean package dir>` so the dispatch and catalog tests also run against a version the
   development dependencies do not pin.

To support a new pi release, add `pi-overlay/versions/<version>/` with an `upstream.json` (pinned source archive and npm
tarball checksums, `gitHead`, the release's workspace build order, tracked files), an `integration.patch` rebased by
re-reading that release's sources, and any bundled-entrypoint `replacements/`. Then run
`node scripts/build-pi-patch.mjs --version <version>` and set `maxUpstreamEditedLines` to the count it measures.

Editing `dist/*.js` by hand is now only for exploring the live install, or for a pi version that has no overlay yet.
Anything proven that way should be moved into the overlay before it ships.

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

Starting with the 0.85.1 patch, preserve non-default remote ports in repository keys. Normalize explicit default SSH
port `22` (and Git protocol port `9418`) to the same key as the port-omitted and SCP-like forms. Do not retrofit this
repository-key change into earlier versioned patches unless explicitly requested.

Starting with the 0.85.1 patch, valid JSON with a non-object top-level value in `skills.json` or `repo-skills.json` is a
configuration error rather than an empty configuration. Strict command paths report that error; loader paths warn and
ignore it.

## Interactive and CLI Skill Management

The command surfaces are deliberately thin wrappers around `dist/core/skill-management.js`. Since 0.85.1 the interactive
body lives in the shared module too, as `handleSkillsInteractive`, and `DefaultResourceLoader` carries no skill-specific
methods at all — it calls `resolveActiveSkillPaths` and nothing else:

- interactive: `/skills active|list|search|add|remove|reload`
- `/skills reload` takes no arguments; anything after it is a usage error, not a reload
- CLI: `pi skills active|list|search|add|remove`
- session scope is interactive-only; mutate `resourceLoader.additionalSkillPaths` and reload
- global/repo scopes mutate JSON first, then reload so the current session reflects the change

Avoid adding separate configuration semantics in the TUI and CLI. Keep parsing, repo-key resolution, persistence, and
catalog queries in the shared core module.

Catalog resolution is asynchronous. It keeps fixed global and trusted-project directory discovery first, then reuses
`DefaultPackageManager.resolve()` for package and settings skills rather than approximating manifest, filter, scope, or
precedence behavior. Both `runSkillsCommand()` callers must await it and pass the active `SettingsManager`; name-based
activation in `DefaultResourceLoader` awaits that same catalog so package and settings names resolve consistently.

## Verification Ideas

Create temp skills and temp agent dirs. Exercise these behaviors without network calls:

- default loader returns no skills even if `agentDir/skills/<name>/SKILL.md` exists
- `additionalSkillPaths` loads a session skill
- `agentDir/skills.json` enables a global skill
- `agentDir/repo-skills.json` enables a repo skill by normalized upstream URL
- non-default remote ports stay distinct while explicit default ports retain canonical repository keys
- non-object top-level JSON values fail strict configuration reads
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
