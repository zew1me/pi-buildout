# pi 0.87.1 `/skills` patch

A version-specific unified patch that changes pi skills from automatically loaded prompt context to an opt-in
catalog with explicit activation. The asynchronous catalog includes fixed global/project directories plus
package `skills/` and `pi.skills` declarations and global/trusted-project `settings.skills` entries. It is
derived from the published `@earendil-works/pi-coding-agent@0.87.1` package.

**These files are generated. Do not edit them by hand.** The authored source is the TypeScript overlay in
[`pi-overlay/`](../../pi-overlay); see its README for the design and the reproducibility policy.

## Regenerating

```bash
node scripts/build-pi-patch.mjs --version 0.87.1           # rewrite the artifacts below
node scripts/build-pi-patch.mjs --version 0.87.1 --check   # fail if the committed artifacts are stale
npm run patches:check                                      # the same check for every overlay version
```

The repository's `@earendil-works/*` development dependencies stay pinned to 0.85.1, because the router's cost
tests pin that model registry, so this version is always named explicitly or reached through `--all`.

The pipeline fetches the pinned upstream source archive and npm tarball, verifies both against checksums in
`pi-overlay/versions/0.87.1/upstream.json`, cross-checks the source archive against upstream's published
`SHA256SUMS`, proves the unmodified source rebuilds the published runtime byte-for-byte, then applies the
overlay and diffs the result. It refuses to emit anything if the clean build disagrees with the published
package, if the patch touches an undeclared path, or if edits to pre-existing upstream code exceed the
declared budget.

## Contents

- `skills.patch` — the runtime, bundled-entrypoint, and documentation changes.
- `baseline.sha256` — checksums for files that must match the clean 0.87.1 package, including the
  untouched `dist/bundle/cli.js` loader.
- `baseline.absent` — paths that must not exist in the clean package.
- `patched.sha256` — checksums expected after applying `skills.patch`; the loader's entry equals its
  baseline.

There are no upgrade states: this repository never shipped an earlier 0.87.1 patch, so the installer
recognizes only the clean package and this patch's own result.

## Bundled entrypoints

Pi 0.87.1 changed the bundled bin layout. `dist/bundle/cli.js` is now a small loader that enables Node's
compile cache and then loads `dist/bundle/cli-runtime.js` with `createRequire(import.meta.url)`; the bundled
runtime itself lives in `cli-runtime.js` and its content-hashed `chunks/`.

The patch therefore replaces `dist/bundle/cli-runtime.js`, not `cli.js`, with a thin wrapper around the
patched unbundled runtime (`../cli/setup.js` and `../main.js`), and replaces `dist/bundle/rpc-entry.js` the
same way. Upstream's `cli.js` loader and its compile cache are kept unchanged, but because the patch only
takes effect through that loader, `baseline.sha256` and `patched.sha256` both pin it to its published
checksum: the installer refuses a package whose loader differs instead of patching a runtime the bin might
never reach. `pi`, `pi skills …`, RPC child
sessions started through the bin with `--mode rpc` (as the subagents extension does), and consumers of the
`./rpc-entry` export all run the patched skill loader. `dist/bundle/chunks/` and `dist/bundle/index.js` are
left in place and are no longer reached from either entrypoint.

## How the installer uses these

`scripts/install-extensions.sh` derives its complete replacement set from `patched.sha256`, verifies the
package version and baseline before modifying anything, applies the patch to staged copies, verifies their
patched checksums, then replaces each installed file atomically, with rollback on failure. A package already
matching `patched.sha256` is left unchanged. Any unknown or mixed state is rejected and must be restored to
the clean package rather than overwritten.

## Tests

- `pi-overlay/skill-management-core.test.mjs` unit-tests the authored logic at the TypeScript level.
- `scripts/build-pi-patch.test.mjs` checks that this directory agrees with the overlay declaration: tracked
  paths, verbatim replacements, and the exact upstream-edit budget.
- `scripts/skills-patch-dispatch.test.mjs` checks that the patch routes all three `/skills` dispatch surfaces
  into the shared module.
- `scripts/skills-patch-entrypoint.test.mjs` runs upstream's loader shape against the patched `cli-runtime.js`
  and `rpc-entry.js`.
- `scripts/skills-catalog.test.mjs` installs and applies this patch to a clean package and verifies fixed,
  package, and settings catalog sources, trust boundaries, precedence, and activation through the packaged
  CLI entrypoint.

The dispatch and catalog tests need a clean 0.87.1 package. The repository's development dependency is
0.85.1, so they skip for 0.87.1 unless one is supplied:

```bash
PI_SKILLS_TEST_PACKAGES=/path/to/clean/pi-coding-agent-0.87.1 npm test
```

The directory must contain the unpatched package's `package.json`, `dist/`, `docs/`, and a resolvable
`node_modules/`. Tests only read it.

Do not apply this patch to another pi version. Add an overlay for that version and regenerate instead.
