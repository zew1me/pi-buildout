# pi 1.5.2 `/skills` patch

Version-specific opt-in skill activation for the published `@earendil-works/pi-coding-agent@1.5.2`. Configured global and trusted-project directories, packages, and settings form a catalog; only explicitly activated skills enter the prompt. The authored TypeScript lives in [`pi-overlay/`](../../pi-overlay); the patch and checksum manifests here are generated.

## Rebuild and verification

```bash
npm_config_registry=https://registry.npmjs.org node scripts/build-pi-patch.mjs --version 1.5.2
npm_config_registry=https://registry.npmjs.org node scripts/build-pi-patch.mjs --version 1.5.2 --check
npm test
```

The pinned release archive, published checksum, npm tarball, source revision, workspace build order, and tracked files are in [`upstream.json`](../../pi-overlay/versions/1.5.2/upstream.json). The builder compares the unmodified source build with the published runtime before generating a patch, enforces the 48-line upstream seam budget, applies the patch to a clean package, and verifies every resulting checksum. Do not apply this patch to another Pi version.

- `skills.patch` changes the unbundled resource loader, CLI and interactive dispatch, and skill documentation; it adds the shared skill-management modules and replaces bundled CLI and RPC runtime entrypoints.
- `baseline.sha256` and `baseline.absent` specify the required clean state. `patched.sha256` pins the result, including the unchanged `dist/bundle/cli.js` loader.
- The unchanged loader enables Node's compile cache and loads the replaced `dist/bundle/cli-runtime.js`; RPC uses the replaced `dist/bundle/rpc-entry.js`. The installer verifies baseline and result and refuses unknown or mixed states. One historical 1.5.2 patched state is migrated: `pre-directory-scope-` (`pre-directory-scope-patched.sha256`, `pre-directory-scope-upgrade.patch`) is the patch as shipped at repository commit `a4c8ab1`, before the `--directory` scope. The builder reverse-applies that migration to every regenerated tree and fails unless it reconstructs the recorded state.

## Original 1.5.2 patch compared with 1.5.0

This comparison describes the original 1.5.2 patch at `a4c8ab1`, now the `pre-directory-scope` upgrade input. That release rebased the 1.5.0 integration without changing the overlay logic or the 48-line upstream seam. The current patch also changes the shared skill-management core and skill documentation to support directory scope.

- `integration.patch` changes only hunk positions and blob indexes. The CLI import and dispatch hunks move by 3 and 37 lines; the interactive imports, command dispatch, and handler hunks move by 8, 64, and 86 lines. The patch is regenerated from the 1.5.2 sources and applies without offset or fuzz.
- Upstream `src/core/resource-loader.ts`, `src/core/slash-commands.ts`, `src/core/skills.ts`, `src/core/project-trust.ts`, and `docs/skills.md` are byte-identical to 1.5.0. The skill loading, catalog, and trust APIs used by the overlay are unchanged.
- `main.ts` adds auth login/logout dispatch and missing-session-directory fork handling; interactive mode adds session-fork choices and other UI changes. These remain upstream behavior, not overlay implementations. The skills dispatch stays between existing early commands and argument parsing; the interactive skills handler still delegates reload to upstream.
- `src/cli.ts`, `src/rpc-entry.ts`, `src/cli/setup.ts`, and the published `dist/bundle/cli.js` loader are unchanged from 1.5.0. The `cli-runtime.js` and `rpc-entry.js` wrappers are reused byte-for-byte. Baseline hashes pin the new published bundled runtimes.
- The workspace build order and TypeScript 7.0.2 toolchain were unchanged. At `a4c8ab1`, the shared `skill-management*.js` output and patched `docs/skills.md` were byte-identical to 1.5.0; the current `patched.sha256` is a separate state.
- The npm registry publishes no `gitHead` for 1.5.2. The manifest records the commit that the `v1.5.2` release tag points to.

## Runtime behavior tests

Provide a clean, unpatched Pi 1.5.2 package with `package.json`, `dist/`, `docs/`, and resolvable `node_modules/`:

```bash
PI_SKILLS_TEST_VERSION=1.5.2 PI_SKILLS_TEST_PACKAGE_DIR=/path/to/pi-1.5.2/package \
  node --test scripts/skills-catalog.test.mjs
```

The directory must match `baseline.sha256` and `baseline.absent`. The tests copy and patch it in temporary directories; they do not modify the supplied package. To prepare a package, extract the pinned npm tarball and link its `node_modules` to dependencies installed with `npm ci --ignore-scripts` from the release's checksum-verified `pi-coding-agent-install-package.json` and `pi-coding-agent-install-package-lock.json`.

The suite verifies opt-in loading, explicit `--skill` with `--no-skills`, session/global/repository/directory activation, catalog trust and precedence, serialized configuration updates, installer idempotency and mixed-state rejection, and patch reversal. This repository generates the patch using its own shared overlay, including portable skill paths.
