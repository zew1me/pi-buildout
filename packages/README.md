# Internal Pi alpha packages

The source of truth stays in `extensions/` and `patches/`. `npm pack` runs `scripts/stage-release-package.mjs` to
construct minimal package payloads in ignored `packages/pi-*/dist/` directories. This is a **manual prerelease**
workflow: the CI quality gate never publishes.

## Consumer setup (read-only)

Choose either method before a `pi install npm:@upstart/...` command below.

### Option A: UMT-managed npm configuration

```bash
umt artifacts --tools npm
pi install npm:@upstart/pi-router-otel@0.1.1-alpha.8
```

The [UMT artifacts command](https://github.com/teamupstart/umt/blob/main/cmd/umt-go/artifacts.go) uses read-only SSO
roles by default. Its [npm writer](https://github.com/teamupstart/umt/blob/main/internal/artifacts/dotfile/npm.go)
updates a managed region of `~/.npmrc` with `@upstart:registry=.../npm/npm-prod/` and a token scoped to that exact
registry path. It leaves the unscoped public npm registry alone. Re-run `umt artifacts --tools npm` when the token
expires (about 12 hours). It changes your persistent user npm configuration, unlike Option B; do not combine it with a
`NPM_CONFIG_USERCONFIG` override from Option B. For npm consumption the dotfile is sufficient;
`source umt artifacts --tools npm` is only needed when the current shell also needs UMT's exported token variables.

### Option B: direct AWS CLI and temporary npm configuration

Authenticate with an AWS SSO **read-only** CodeArtifact profile. These underlying commands avoid `umt` and do not change
a persistent `~/.npmrc`. Keep the temporary file and token out of commits and logs; refresh the token when it expires
(about 12 hours). Run `pi install` in the same shell so Pi's npm subprocess inherits `NPM_CONFIG_USERCONFIG` and
`CODEARTIFACT_AUTH_TOKEN`:

```bash
export RO_PROFILE=YOUR_CODEARTIFACT_READONLY_PROFILE
aws sso login --profile "$RO_PROFILE"
export AWS_PROFILE="$RO_PROFILE" AWS_REGION=us-east-1
export CODEARTIFACT_AUTH_TOKEN="$(aws codeartifact get-authorization-token \
  --domain code-artifacts-prod --domain-owner 801997600626 \
  --region us-east-1 --query authorizationToken --output text)"
REGISTRY='https://code-artifacts-prod-801997600626.d.codeartifact.us-east-1.amazonaws.com/npm/npm-prod/'
export NPM_CONFIG_USERCONFIG="$(mktemp)"
chmod 600 "$NPM_CONFIG_USERCONFIG"
trap 'rm -f "$NPM_CONFIG_USERCONFIG"; unset CODEARTIFACT_AUTH_TOKEN NPM_CONFIG_USERCONFIG' EXIT
printf '%s\n' "@upstart:registry=$REGISTRY" \
  "//${REGISTRY#https://}:_authToken=\${CODEARTIFACT_AUTH_TOKEN}" > "$NPM_CONFIG_USERCONFIG"
```

Keep the default unscoped registry public; only `@upstart` resolves through CodeArtifact. Publisher setup and the
write-capable SSO role are a separate, later checkpoint below.

| Package                                        | Contents                                                         | Activation                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `@upstart/pi-router-otel@0.1.1-alpha.8`        | Router and OTel together, with their shared runtime dependencies | `pi install npm:@upstart/pi-router-otel@0.1.1-alpha.8`                          |
| `@upstart/pi-clear@0.1.0-alpha.1`              | Clear                                                            | `pi install npm:@upstart/pi-clear@0.1.0-alpha.1`                                |
| `@upstart/pi-effort@0.1.0-alpha.2`             | Effort                                                           | `pi install npm:@upstart/pi-effort@0.1.0-alpha.2`                               |
| `@upstart/pi-markdown-backlinks@0.1.0-alpha.1` | Backlinks                                                        | `pi install npm:@upstart/pi-markdown-backlinks@0.1.0-alpha.1`                   |
| `@upstart/pi-subagents@0.1.0-alpha.3`          | Subagents                                                        | `pi install npm:@upstart/pi-subagents@0.1.0-alpha.3`                            |
| `@upstart/pi-skills-patch@0.1.0-alpha.3`       | Versioned `/skills` patch and patch-only CLI                     | `npm install -g @upstart/pi-skills-patch@0.1.0-alpha.3`, then `pi-skills-patch` |

The packages can advance independently: increment `alpha.N` for each changed package, then use `-beta.N`, `-rc.N`, or
stable SemVer after validation. Always publish prereleases with `--tag alpha` so they do **not** become npm `latest`.
CodeArtifact will not replace an already published name/version; increment before retrying a changed tarball. The
standalone patch checks the exact installed Pi baseline, refuses unknown states, and never installs extensions. A user
can instead run the checkout installer (`scripts/install-extensions.sh`) for both; the legacy `--with-otel` flag remains
a no-op compatibility alias, and `--without-otel` opts out.

## Before publishing

1. **Human checkpoint — data and licensing:** review the package's full-content OTel capture default and the staging
   collector (`https://corp-otel-staging-1.upstart.com`). Opt out with `PI_OTEL_DISABLED=1` or `otel.enabled=false`, or
   override individual settings. Remove a separately installed `npm:pi-otel` first to prevent duplicate telemetry. The
   vendored fork is Apache-2.0; its `LICENSE` and the root `ATTRIBUTION.md` are included. Do not remove those notices.
2. **Human checkpoint — package contents and names:** run `npm run check`, then
   `cd packages/pi-router-otel && npm pack --dry-run --json` (repeat for each other package). Review every file and
   confirm there are no secrets, tests, generated reports, or development dependencies in any archive. Run the OTel
   tests separately: `cd extensions/otel && npm ci --ignore-scripts --registry=https://registry.npmjs.org/ && npm test`.
   Test each package in a disposable Pi installation. Package dependencies are resolved by Pi's package manager; do not
   load a package alongside copies of its individual extensions installed by the checkout script.
3. **Human checkpoint — publish identity/version:** establish an AWS SSO CLI profile with the `CodeArtifact-Prod-RW`
   permission set for domain owner `801997600626`. Authenticate that profile, verify the active account and role with
   `aws sts get-caller-identity`, and check that each alpha version is unused. Do not assume a read-only token can
   publish.

## Release CLI and manual publish (only after the checkpoints)

The repository provides a small npm-script CLI. Select package names from `router-otel`, `clear`, `effort`,
`markdown-backlinks`, `subagents`, and `skills-patch`. It defaults to `npm pack --dry-run --json`, which stages and
prints the exact archive contents without publishing:

```bash
npm run release:packages -- --package clear,effort
```

Repeat `--package` to select more packages. After reviewing the dry-run output and completing the checkpoints above, add
`--publish` to publish the selected packages at their manifest versions with the `alpha` tag. The CLI uses the
repository's fixed CodeArtifact URL; it does not choose or bump versions. Authenticate npm against that registry using
the setup below first. Publishing is a write operation and must be explicitly requested with `--publish`.

With `--publish`, the CLI packs and validates **all selected packages before the first registry write**, then publishes
those exact tarballs rather than repacking their directories. A temporary integrity receipt records each package's name,
version, archive filename, and SHA-512 integrity. The CLI checks archive hashes and embedded manifests before
publication and rechecks each archive's hash immediately before publishing it. Temporary archives and receipts are
automatically removed when the command returns, including on errors. Separate dry runs remain previews; they do not
create a persistent receipt or bind a later publish invocation to previously reviewed bytes.

This is local archive validation, not registry preflight: the CLI does not query existing versions, reconcile version
conflicts, or reconcile dist-tags. Keep the human availability, identity, and artifact checkpoints above.

These are the underlying AWS/npm operations, **not** `umt` or changes to a persistent `~/.npmrc`. Set `RW_PROFILE` to
the publish-capable SSO profile actually configured on the machine (create one interactively with
`aws configure sso --profile ...` if needed). Keep the terminal private; never echo or commit the token. Use a working
npm 11 CLI (the repository targets npm 11); this machine's npm 12 installation currently fails even for
`npm publish --dry-run` because its `sigstore` module is missing. The Homebrew npm 11 CLI at
`/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js` passed a CodeArtifact-targeted dry run; it can be invoked with
`node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js publish ...` in place of `npm publish` below.

```bash
export RW_PROFILE=YOUR_CODEARTIFACT_RW_PROFILE
aws sso login --profile "$RW_PROFILE"
export AWS_PROFILE="$RW_PROFILE" AWS_REGION=us-east-1
export CODEARTIFACT_AUTH_TOKEN="$(aws codeartifact get-authorization-token \
  --domain code-artifacts-prod --domain-owner 801997600626 \
  --region us-east-1 --query authorizationToken --output text)"
REGISTRY="$(aws codeartifact get-repository-endpoint \
  --domain code-artifacts-prod --domain-owner 801997600626 \
  --repository npm-prod --format npm --region us-east-1 \
  --query repositoryEndpoint --output text)"
# AWS returns the final slash; validate the destination before the first write.
test "$REGISTRY" = 'https://code-artifacts-prod-801997600626.d.codeartifact.us-east-1.amazonaws.com/npm/npm-prod/'
export NPM_CONFIG_USERCONFIG="$(mktemp)"
chmod 600 "$NPM_CONFIG_USERCONFIG"
trap 'rm -f "$NPM_CONFIG_USERCONFIG"; unset CODEARTIFACT_AUTH_TOKEN NPM_CONFIG_USERCONFIG' EXIT
printf '%s\n' "//${REGISTRY#https://}:_authToken=\${CODEARTIFACT_AUTH_TOKEN}" > "$NPM_CONFIG_USERCONFIG"

# Check availability. Stop and inspect the response for EACH package before publishing it.
for name in pi-router-otel pi-clear pi-effort pi-markdown-backlinks pi-subagents pi-skills-patch; do
  aws codeartifact list-package-versions --domain code-artifacts-prod --domain-owner 801997600626 \
    --repository npm-prod --format npm --namespace upstart --package "$name" --region us-east-1
done

# WRITE OPERATION — only after human approval; publishes only the selected packages.
npm run release:packages -- --package router-otel --publish

# Or use npm directly for one package, if needed:
(cd packages/pi-router-otel && PI_CODEARTIFACT_PUBLISH=1 npm publish --registry "$REGISTRY" --tag alpha --ignore-scripts=false)
```

For direct directory publishing, the `prepublishOnly` gate requires the selected package's expected `@upstart` identity,
a non-private manifest, a strict `-alpha.N` version, the exact CodeArtifact endpoint, `--tag alpha`, and
`PI_CODEARTIFACT_PUBLISH=1`. Keep lifecycle scripts enabled when using npm directly. Tarball publishing does not run
that checkout hook, so the CLI enforces equivalent manifest, registry, tag, and explicit opt-in checks itself. These
guards protect against accidental publication to the repository's public npm registry; **they do not replace a human
check of the artifact and identity**. The token expires after roughly 12 hours.

After a publish, use `npm view @upstart/pi-router-otel@0.1.1-alpha.8 --registry "$REGISTRY"` (or the chosen package) and
test a fresh consumer install with the scoped registry/token configured. Re-run Pi's `/reload` if already running. Do
not publish the same version to JFrog as well.
