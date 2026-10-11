# pi 1.1.0 `/skills` patch

Version-specific opt-in skill activation for the published `@earendil-works/pi-coding-agent@1.1.0`. Configured global and trusted-project directories, packages, and settings form a catalog; only explicitly activated skills enter the prompt. The authored TypeScript lives in [`pi-overlay/`](../../pi-overlay); the patch and checksum manifests here are generated.

## Rebuild and verification

```bash
npm_config_registry=https://registry.npmjs.org node scripts/build-pi-patch.mjs --version 1.1.0
npm_config_registry=https://registry.npmjs.org node scripts/build-pi-patch.mjs --version 1.1.0 --check
npm test
```

The pinned release archive, published checksum, npm tarball, source revision, workspace build order, and tracked files are in [`upstream.json`](../../pi-overlay/versions/1.1.0/upstream.json). The builder compares the unmodified source build with the published runtime before generating a patch, enforces the 48-line upstream seam budget, applies the patch to a clean package, and verifies every resulting checksum. Do not apply this patch to another Pi version.

- `skills.patch` changes the unbundled resource loader, CLI and interactive dispatch, and skill documentation; it adds the shared skill-management modules and replaces bundled CLI and RPC runtime entrypoints.
- `baseline.sha256` and `baseline.absent` specify the required clean state. `patched.sha256` pins the result, including the unchanged `dist/bundle/cli.js` loader.
- The unchanged loader enables Node's compile cache and loads the replaced `dist/bundle/cli-runtime.js`; RPC uses the replaced `dist/bundle/rpc-entry.js`. The installer verifies baseline and result and refuses unknown or mixed states. There are no historical 1.1.0 patched states to migrate.

## Runtime behavior tests

The end-to-end catalog and dispatch suites run against the lowest retained patch, Pi 1.0.3, not this one; see [`patches/pi-1.0.3/README.md`](../pi-1.0.3/README.md). The `skill-management*.js` modules this patch adds are byte-identical to 1.0.3's, so that run exercises the same logic. This patch's seams and bundled entrypoints are checked by the manifest tests in `scripts/skills-patch-103.test.mjs` and by the scheduled regeneration job.

The opt-in behavior preserves explicit `--skill` with `--no-skills`, supports session/global/repository activation, and serializes persisted configuration updates. See the patched `docs/skills.md` for commands and configuration format.
