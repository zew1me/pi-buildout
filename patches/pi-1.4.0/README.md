# pi 1.4.0 `/skills` patch

Version-specific opt-in skill activation for `@earendil-works/pi-coding-agent@1.4.0`. Discovered directories, packages, and settings form a catalog; only explicitly activated skills enter the prompt. The authored TypeScript lives in [`pi-overlay/`](../../pi-overlay); the patch and checksum manifests here are generated. Do not apply this patch to another Pi version.

## Rebuild and verification

```bash
npm_config_registry=https://registry.npmjs.org node scripts/build-pi-patch.mjs --version 1.4.0
npm_config_registry=https://registry.npmjs.org node scripts/build-pi-patch.mjs --version 1.4.0 --check
npm run check
```

[`upstream.json`](../../pi-overlay/versions/1.4.0/upstream.json) pins the release archive, published checksum, npm tarball, source revision, toolchain, workspace build order, and tracked files. The builder proves the unmodified source reproduces all four pre-existing runtime files byte-for-byte, enforces the 48-line seam budget, then applies the generated patch to a clean package and verifies every resulting checksum.

- `skills.patch` modifies resource loading, CLI/interactive dispatch, and skill documentation, adds the shared skill-management modules, and replaces the bundled CLI/RPC runtime entrypoints with wrappers around the patched unbundled runtime.
- `baseline.sha256` and `baseline.absent` specify the clean package state; `patched.sha256` pins the result, including the unchanged `dist/bundle/cli.js` compile-cache loader.
- This is the first 1.4.0 patch, so there are no historical patched-state migrations. The installer rejects unknown or mixed states and recognizes an already-applied patch.

## Drift from 1.3.0

No shared overlay logic changed. The integration patch has the same added and removed lines as 1.3.0. Upstream's interactive-mode changes move its command-dispatch and handler hunks 45 lines earlier; the other three source files and upstream skill documentation are unchanged. The regenerated integration patch applies without offset or fuzz.

The CLI and RPC entrypoint sources, CLI setup, and published compile-cache loader are unchanged, so both wrappers are reused byte-for-byte. The generated skill-management modules, patched skill documentation, resource loader, slash-command list, and main entrypoint are byte-identical to 1.3.0's output. Only the patched interactive-mode checksum changes. Upstream's root build moves `packages/telemetry` before `packages/chord`; the pinned workspace order follows it.

The npm registry publishes no `gitHead`; the pinned revision `4a080252f06caf63a525d7873c5d94d3c23887e0` is the commit referenced by the lightweight `v1.4.0` release tag. GitHub reports that commit as unsigned.

## Isolated runtime behavior tests

The normal test suite uses the minimum supported Pi 1.0.3 development dependency. Dispatch and manifest assertions cover every retained patch. The drift workflow additionally runs the catalog/activation/installer suite against an isolated clean 1.4.0 npm package. To reproduce that verification without modifying the live Pi installation:

```bash
work=$(mktemp -d)
npm_config_registry=https://registry.npmjs.org node scripts/build-pi-patch.mjs \
  --version 1.4.0 --check --work-dir "$work/build"
npm install --prefix "$work/runtime" --ignore-scripts --no-audit --no-fund \
  --registry=https://registry.npmjs.org "$work/build/cache/pi-coding-agent-1.4.0.tgz"
PI_SKILLS_TEST_VERSION=1.4.0 \
  PI_SKILLS_TEST_PACKAGE_DIR="$work/runtime/node_modules/@earendil-works/pi-coding-agent" \
  node --test scripts/skills-catalog.test.mjs
```

The fixture path must name a clean npm-installed package with matching version and baseline checksums. An explicitly selected invalid fixture fails rather than silently skipping. Tests copy and patch only temporary packages, covering catalog precedence and trust, inactive-by-default discovery, explicit session paths with `--no-skills`, suppression of persisted activation, global/repository configuration, portable paths, concurrent mutations, bundled CLI dispatch, and installer idempotence. They make no model/provider requests.
