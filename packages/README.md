# Public npm packages

The source of truth remains in `extensions/` and `patches/`. Each package has its own version in
`packages/pi-*/package.json` as version templates; the private root package is never published. Public packages target
npmjs.org only.

| Package                         | Install / activation                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `@zew1me/pi-clear`              | `pi install npm:@zew1me/pi-clear@alpha`                                               |
| `@zew1me/pi-effort`             | `pi install npm:@zew1me/pi-effort@alpha`                                              |
| `@zew1me/pi-markdown-backlinks` | `pi install npm:@zew1me/pi-markdown-backlinks@alpha`                                  |
| `@zew1me/pi-subagents`          | `pi install npm:@zew1me/pi-subagents@alpha`                                           |
| `@zew1me/pi-skills-patch`       | `npm install -g @zew1me/pi-skills-patch@alpha`, then explicitly run `pi-skills-patch` |

The first four packages expose TypeScript entrypoints through the `pi` manifest and declare Pi's host-provided modules
as peers rather than bundling a second Pi. They load normally without applying the `/skills` patch. Remove copies
installed by the checkout installer before loading the corresponding npm packages to avoid duplicate commands/tools. The
patch package is separate: installing it does not modify Pi. Its CLI patches only an exactly supported Pi baseline,
never installs extensions, and needs Bash, Node, `patch`, and a SHA-256 utility (as does the checkout installer).

## Release policy

The `quality` workflow in `.github/workflows/check.yml` runs checks and packs all five packages for pull requests and
pushes to `main`. Only a **push to `zew1me/pi-buildout`'s `main`** can publish, after both jobs succeed.

- Each push compares the final tree with the push event's `before` commit. Changed extension runtime files or package
  files release that package; patch files and the installer release the patch package. Changes to the staging script,
  license or attribution release all packages. Tests alone do not trigger extension releases.
- CI generates `X.Y.(Z+1)-alpha.RUN` from each stable `X.Y.Z` manifest template, or `X.Y.Z-alpha.RUN` from an alpha
  `alpha.0` template. `RUN` is the GitHub workflow run number, fixed on reruns. Packages advance independently. Change a
  template core deliberately when a new compatibility line is needed; do not commit CI-generated versions. Migrate other
  alpha templates to a higher core with `alpha.0` before enabling automatic releases.
- Releases use the `alpha` npm dist-tag, not `latest`. Non-ancestor and zero/missing bases are rejected. CI does not
  commit, tag Git, or create GitHub Releases.

Workflow runs are queued (`queue: max`, at most 100 pending), not cancelled by newer pushes. Avoid force-pushing the
release branch. GitHub queues by arrival rather than guaranteeing commit order; preflight rejects an unpublished release
older than the current version on its target distribution tag, rather than moving consumers backward. CI validates
workflow syntax with the [zew1me/actionlint fork](https://github.com/zew1me/actionlint) v1.8.0, which supports GitHub's
`queue` concurrency setting.

## Local checks and archive inspection

Use the repository's pinned npm 11.17.0 and Node >=22.19 (CI uses Node 24). From the repository root:

```bash
npm ci
npm run check
npm run audit
node scripts/prepare-auto-release.mjs origin/main 123 # modifies changed manifests locally
npm run release:packages -- plan --base origin/main
npm run release:packages -- pack
```

`pack` is safe by default: it stages minimal runtime payloads using `prepack` and writes real `.tgz` archives plus
`release-assets.json` into ignored `release-artifacts/`. Use `--artifacts /some/directory` to override the destination.
Commit extension changes before previewing: preparation selects only committed changes between the base and HEAD, not
uncommitted changes. Run the preparation command before `pack`; it modifies package manifests in the working tree, so
restore those changes afterwards. `plan` prints the packages with version increases relative to the chosen ancestor
without publishing anything.

Inspect every archive (for example `tar -tzf release-artifacts/zew1me-pi-clear-0.1.1-alpha.123.tgz`). Archives include
runtime files, package documentation, license, and attribution, but not tests, development dependencies, local agent
settings, or the full repository. Test extension archives in a disposable Pi installation before a release. Do not load
a package alongside its checkout-installed equivalent. For prereleases, explicitly install a version or channel, e.g.
`pi install npm:@zew1me/pi-clear@alpha`.

## One-time maintainer setup (required before enabling publication)

These are human/admin actions, not performed by CI or repository setup:

1. Confirm you control the `@zew1me` npm scope, enable account 2FA, and review the public archive contents and licenses.
2. Bootstrap each new npm package from a reviewed archive using an authenticated maintainer account. npm trusted
   publishers are configured on existing packages; never put an account token into this repository. For example, **only
   when ready to make the first public release**, run:

   ```bash
   npm publish ./release-artifacts/zew1me-pi-clear-0.1.0.tgz \
     --registry https://registry.npmjs.org/ --access public --tag latest --ignore-scripts
   ```

   Repeat for the other four reviewed archives. Use the appropriate prerelease tag if bootstrapping a prerelease. This
   is a real public write; version contents cannot be replaced. A dummy placeholder at the same version will conflict
   with CI's archive-integrity check.

3. Create/protect the GitHub environment **`npm`**, restricted to `main`; optionally require reviewer approval. Protect
   `main` with required quality checks and reviews of manifests, staging scripts, and workflows.
4. On **each npm package**, configure a GitHub Actions trusted publisher with these exact values:
   - Organization/user: `zew1me`
   - Repository: `pi-buildout`
   - Workflow filename: **`check.yml`** (not its path or the workflow display name)
   - Environment: **`npm`**
   - Allow direct **`npm publish`** (not only staged publishing).
5. Newly configured publishers must complete a successful publish within npm's current setup expiry window (currently
   two days). Configure each publisher close to a change that selects that package, or ensure a planned change selects
   every configured package, then merge it and verify each resulting release. After validating OIDC, restrict
   traditional token publishing in npm package settings. No `NPM_TOKEN` or AWS secrets are needed in GitHub.

See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/) for current setup requirements.
The workflow pins an OIDC-capable npm and gives `id-token: write` only to the environment-gated publish job. It uses
GitHub-hosted runners and public-package provenance. Package `repository.url` must continue to match this repository.

## Publication and recovery

The credential-free packaging job uploads its exact archives. The publish job downloads artifacts **from the same
workflow run**, selects only version increases, verifies each selected archive's SHA-512 integrity, and checks every
selected npm version before writing anything. Publishing uses those archives with lifecycle scripts disabled: no rebuild
or `prepack` execution occurs with publishing credentials.

- An existing identical archive is skipped, allowing reruns after a partial failure.
- An existing name/version with different contents fails the whole preflight: fix the issue and trigger a new run.
- Registry/network/authentication errors fail closed; they are not treated as missing versions.
- A stale unpublished version behind its channel's current tag is rejected before any writes. Publish a new, higher
  version instead. Identical previously published versions remain safe to skip, without changing tags.
- A failure after one successful publish is not transactional. Re-run the failed job for the **original workflow run**,
  while its artifacts are available (14 days). Already-published identical packages are skipped.
- If artifacts expired, a run was dropped/cancelled, or a newer release makes an old partial run stale, make a new
  change to every package still needing publication to trigger a new run. A failed preflight publishes none of the
  selected packages; changing only one of them later does not retry the others. A shared release input such as
  `ATTRIBUTION.md` selects all packages.

Each published/skipped package appears in the Actions job summary. Verify with
`npm view @zew1me/pi-clear --registry https://registry.npmjs.org/` and test a fresh consumer install.

For exceptional, explicitly approved manual publication, the same preflight can run against reviewed archives:

```bash
npm run release:packages -- publish --base THE_PRE_PUSH_COMMIT --artifacts release-artifacts
```

This command is a **real public write**. It requires npm authentication; provenance requires a supported CI OIDC
context. Normal local usage should stop at `pack` and `plan`.
