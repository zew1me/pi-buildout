# pi 0.85.1 `/skills` patch

A version-specific unified patch that changes pi skills from automatically loaded prompt context to an opt-in
catalog with explicit activation. The asynchronous catalog includes fixed global/project directories plus
package `skills/` and `pi.skills` declarations and global/trusted-project `settings.skills` entries. It is
derived from the published `@earendil-works/pi-coding-agent@0.85.1` package.

**These files are generated. Do not edit them by hand.** The authored source is the TypeScript overlay in
[`pi-overlay/`](../../pi-overlay); see its README for the design and the reproducibility policy.

## Regenerating

```bash
npm run patches:build            # rewrite the artifacts below
npm run patches:check            # fail if the committed artifacts are stale
```

The pipeline fetches the pinned upstream source archive and npm tarball, verifies both against checksums in
`pi-overlay/versions/0.85.1/upstream.json`, proves the unmodified source rebuilds the published runtime
byte-for-byte, then applies the overlay and diffs the result. It refuses to emit anything if the clean build
disagrees with the published package, if the patch touches an undeclared path, or if edits to pre-existing
upstream code exceed the declared budget.

## Contents

- `skills.patch` — the runtime, bundled-entrypoint, and documentation changes.
- `baseline.sha256` — checksums for files that must match the clean 0.85.1 package.
- `baseline.absent` — paths that must not exist in the clean package.
- `patched.sha256` — checksums expected after applying `skills.patch`.

Three recognized already-patched states, each with a migration onto the current patch:

| State | Manifests | What it is |
| --- | --- | --- |
| `legacy-` | `legacy-patched.sha256`, `legacy-absent`, `legacy-upgrade.patch` | patched before bundled entrypoints and the expanded catalog sources were included |
| `pre-validation-` | `pre-validation-patched.sha256`, `pre-validation-absent`, `pre-validation-upgrade.patch` | the state recorded by repository commit `c8bbfc6`, before strict configuration validation and remote-port preservation |
| `handwritten-` | `handwritten-patched.sha256`, `handwritten-absent`, `handwritten-upgrade.patch` | the last hand-authored patch, before the runtime was generated from the TypeScript overlay |

### Regenerating the upgrade states

`npm run patches:build` regenerates the four artifacts above but **not** these migrations, because a state is
defined by the bytes of a real tree and cannot be rebuilt from checksums alone. After the main patch changes,
rebuild each migration against the new patched tree:

```bash
node scripts/build-pi-upgrade.mjs --version 0.85.1 --label handwritten \
  --from <tree in that state> --patched <tree the pipeline produced>
```

Materialize an old tree by extracting the clean npm package and applying that state's artifacts from the
commit that introduced them; `git show <commit>:patches/pi-0.85.1/skills.patch` and reverse-applying the older
`*-upgrade.patch` files reconstructs each one.

Forgetting this step is caught rather than shipped: the pipeline reverse-applies every migration against the
freshly generated tree and fails unless it reconstructs exactly the state it claims to come from.

A `<state>-absent` file lists paths that must **not** exist in that state. It is the upgrade-state counterpart
of `baseline.absent`, and it is what lets a patch that adds a new runtime file still describe the states that
predate that file. `dist/core/skill-management-core.js` is new in the generated patch, so all three states
list it.

## How the installer uses these

`scripts/install-extensions.sh` derives its complete replacement set from `patched.sha256`, verifies the
package version and baseline before modifying anything, applies the patch to staged copies, verifies their
patched checksums, then replaces each installed file atomically, with rollback on failure. Upgrade manifests
are limited to exact full-file states previously produced by this repository; a matching package version alone
never authorizes an upgrade. A package already matching `patched.sha256` is left unchanged. Any unknown or
mixed state is rejected and must be restored to the clean package rather than overwritten.

Because pi 0.85.1 dispatches through bundled entrypoints, the patch also replaces `dist/bundle/cli.js` and
`dist/bundle/rpc-entry.js` with thin wrappers around the patched unbundled runtime. This keeps `pi skills` and
RPC child sessions on the patched skill loader instead of the untouched generated bundle.

## Tests

- `pi-overlay/skill-management-core.test.mjs` unit-tests the authored logic at the TypeScript level.
- `scripts/skills-patch-dispatch.test.mjs` checks that the patch routes all three `/skills` dispatch surfaces
  into the shared module.
- `scripts/skills-patch-entrypoint.test.mjs` verifies the bundled CLI delegate and the migration manifests.
- `scripts/skills-catalog.test.mjs` applies this patch to the pinned package and verifies fixed, package, and
  settings catalog sources, trust boundaries, precedence, activation through the packaged CLI entrypoint, and
  the generated checksums.

Do not apply this patch to another pi version. Add an overlay for that version and regenerate instead.
