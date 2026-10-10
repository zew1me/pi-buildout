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
- The unchanged loader enables Node's compile cache and loads the replaced `dist/bundle/cli-runtime.js`; RPC uses the replaced `dist/bundle/rpc-entry.js`. The installer verifies baseline and result and refuses unknown or mixed states. One historical 1.1.0 patched state is migrated: `pre-expansion-` (`pre-expansion-patched.sha256`, `pre-expansion-upgrade.patch`) is the patch as shipped at repository commit `fe4aa4b`, before environment-variable expansion in skill paths. The builder reverse-applies that migration to every regenerated tree and fails unless it reconstructs the recorded state.

## Runtime behavior tests

The catalog integration suite runs against a clean, unpatched Pi package of the matching version. If Pi 1.1.0 is not installed as the repository's development dependency, provide a clean package directory with `package.json`, `dist/`, `docs/`, and resolvable `node_modules/`:

```bash
PI_SKILLS_TEST_PACKAGES=/path/to/pi-1.1.0/package npm test
```

The directory must match the Pi 1.1.0 checksums in `baseline.sha256` and paths in `baseline.absent`. The suite copies the package to a temporary directory, applies the patch there, and exercises the CLI; it does not modify the supplied package. Multiple package directories can be separated with the platform path delimiter.

The opt-in behavior preserves explicit `--skill` with `--no-skills`, supports session/global/repository activation, and serializes persisted configuration updates. See the patched `docs/skills.md` for commands and configuration format.
