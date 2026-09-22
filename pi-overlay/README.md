# Pi `/skills` TypeScript overlay

The authored form of the `/skills` runtime patch. Reviewed TypeScript here is the source of truth; the artifacts under
`patches/pi-<version>/` are generated from it.

## Layout

| Path                                   | What it is                                                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skill-management-core.ts`             | All original logic, including the interactive `/skills` command body. Imports nothing — Node built-ins and Pi's own helpers arrive through the injected `SkillEnvironment` seam. |
| `skill-management.ts`                  | The Pi-facing shell. The only file that names Pi modules; it binds the real implementations and keeps each export's signature identical to what Pi's call sites use.             |
| `skill-management-core.test.mjs`       | Focused unit tests over the core, using a fake environment. No real filesystem, no real git.                                                                                     |
| `versions/<version>/integration.patch` | The seam edits against upstream `packages/coding-agent` TypeScript source.                                                                                                       |
| `versions/<version>/replacements/`     | Files copied verbatim over the published package, not built from source.                                                                                                         |

## Why the core/shell split

Pi's source imports its own modules with `.ts` specifiers (`../config.ts`), enforced upstream by
`npm run check:ts-relative-imports`. Those specifiers resolve only inside a Pi source tree. Keeping every upstream
reference in one thin shell means:

- `skill-management-core.ts` type-checks and unit-tests inside this repository with no stubs and no loader tricks, under
  the repo's normal `strictTypeChecked` ESLint and `tsc --noEmit` gates;
- `skill-management.ts` is type-checked where it actually lives, by upstream's own `tsgo` against real upstream types,
  during patch generation. It is excluded from this repo's `tsconfig.json` and ESLint config because its imports cannot
  resolve here.

Hand-written `.d.ts` stubs were considered and rejected: they drift from upstream and prove less than compiling against
the real thing.

Keep the shell as thin as it can be. Because it is outside this repository's ESLint and `tsc` runs, anything that lives
there is checked only by upstream's compiler — no strict lint rules, no complexity limit. Logic put there and later
moved into the core has arrived carrying lint errors more than once. New logic belongs in `skill-management-core.ts`;
the shell should only bind and forward.

## Minimal seam policy

New logic goes in `skill-management*.ts`. Upstream files get imports and a call site, nothing more.

Measured against each clean package, edits to pre-existing upstream files:

| Pre-existing upstream file                   | 0.85.1, previously hand-written | 0.85.1, generated | 0.87.1, generated |
| -------------------------------------------- | ------------------------------- | ----------------- | ----------------- |
| `dist/core/resource-loader.js`               | 55                              | 16                | 16                |
| `dist/core/slash-commands.js`                | 1                               | 1                 | 1                 |
| `dist/main.js`                               | 32                              | 5                 | 5                 |
| `dist/modes/interactive/interactive-mode.js` | 82                              | 25                | 26                |
| **Total**                                    | **170**                         | **47**            | **48**            |

The 0.87.1 seam makes the same calls as the 0.85.1 one. Its one extra line is in `interactive-mode.ts`, which now
already imports `getCwdRelativePath` from `utils/paths.ts`; the seam extends that import with `resolvePath` instead of
adding a second import from the same module.

The shared `skill-management-core.ts` and `skill-management.ts` needed no change for 0.87.1: every Pi API the shell
binds is unchanged between the two releases, and both versions compile them to byte-identical
`dist/core/skill-management*.js`.

The budget counts only files where upstream code is edited in place. Files the patch _adds_ are ours; `docs/skills.md`
and the two bundled entrypoints are replaced wholesale rather than surgically edited, so none of them belong in a number
meant to track how much upstream code we reach into. The generation pipeline enforces the total as
`maxUpstreamEditedLines` in `versions/<version>/upstream.json`, so the policy is a build failure rather than a review
convention.

Two consequences worth knowing:

- `DefaultResourceLoader` no longer gains any skill-specific API. The five methods the earlier patch added to it —
  `getActiveSkillPaths`, `invalidateSkillCatalogCache`, `normalizeSkillEntry`, `resolveSkillEntry`,
  `findCatalogSkillPath` — are free functions here. Interactive session scope resolves entries through this module too,
  rather than reaching into the loader.
- The catalog cache is now local to `resolveActiveSkillPaths`. It was only ever reachable from one call path (`reload()`
  → `getActiveSkillPaths()` → `resolveSkillEntry()`), so an instance field and its invalidation were never reused across
  calls. Behaviour is unchanged; the end-to-end catalog test is the check on that.

## Delivery: why a patch rather than copying files in

The installer already delivers `dist/core/skill-management.js` as a _new_ file, through a `--- /dev/null` hunk tracked
by `baseline.absent` and `patched.sha256`. A file added through the patch **is** a copied-in file — it simply travels
through a channel that already has checksum verification, atomic replacement with rollback, refusal on unknown or mixed
state, and upgrade migrations. A second copy mechanism would duplicate that machinery and lose the verification.

Registering `/skills` from a Pi **extension** was evaluated and rejected. The extension API does offer
`registerCommand()` and `ctx.reload()`, but `ExtensionContext` exposes no resource loader, no `getSkills`, and no
`additionalSkillPaths`. An extension therefore cannot implement session scope, cannot make skills opt-in at all — which
is the whole point of the `resource-loader` change — and cannot serve non-interactive `pi skills …`. Worth revisiting if
Pi ever exposes the resource loader to extensions.

## Source acquisition

Per version, `versions/<version>/upstream.json` pins the inputs. Two properties make this reproducible:

- **The exact upstream commit is published.** The npm registry records `gitHead` for every release, and it matches the
  revisions in `ATTRIBUTION.md` exactly (`0.85.1` → `d981de1229ef899957bbe968bc8dcda02a21f477`, `0.87.1` →
  `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`).
- **Upstream ships a deterministic source archive.** Each GitHub release carries `pi-<version>-source.tar.gz` (built by
  upstream's `scripts/create-source-archive.sh`) alongside a `SHA256SUMS`. GitHub's _auto-generated_ tag tarballs are
  not byte-stable and are deliberately not used.

A git submodule was rejected: it vendors the whole tree for no reproducibility gain. A long-lived fork was rejected as
unjustified unless we intend to contribute to or maintain an upstream branch. Upstream is MIT; this repository vendors
no upstream source.

## Reproducibility

Verified for 0.85.1: building the pinned source archive reproduces the published npm runtime **exactly** — 209 of 209
unbundled `.js` files byte-identical, including every tracked file. Verified the same way for 0.87.1: 219 of 219. No
normalization is applied. If that ever stops holding, generation fails rather than emitting a patch carrying toolchain
noise.

Two caveats the pipeline must respect:

- `dist/bundle/` is esbuild output with content-hashed chunks and is never rebuilt. The patch replaces the bundled
  entrypoints with the small wrappers in `replacements/`, so only their baseline hashes are needed and those come from
  the npm tarball. Which files those are depends on the release's bin layout: 0.85.1 replaces `dist/bundle/cli.js` and
  `dist/bundle/rpc-entry.js`. 0.87.1 made `dist/bundle/cli.js` a loader that enables Node's compile cache and then
  `require()`s `dist/bundle/cli-runtime.js`, so it replaces `cli-runtime.js` and `rpc-entry.js` and keeps upstream's
  loader. The loader is declared with `"source": "unchanged"`: it never appears in the patch, but both checksum
  manifests pin it, so the installer rejects a package whose loader would bypass the replaced runtime.
- The 0.85.1 source archive does not build cleanly end to end offline: `packages/ai`'s `generate-models` does not emit
  `src/providers/kimi-coding.models.ts`, so `tsgo` reports `TS2307` for that package. It still emits usable output, so
  `packages/coding-agent` is unaffected — but the pipeline must build the workspace chain explicitly and gate on the
  artifact comparison, never on the root build's exit status. Every 0.87.1 workspace builds with exit status 0; the
  pipeline gates the same way regardless.

`workspaceBuildOrder` follows upstream's root `build` script for that release. 0.87.1 added `packages/durable` between
`packages/ai` and `packages/agent`.

`npm run patches:build` and `npm run patches:check` pass `--all`, so every version under `versions/` is regenerated and
checked, not only the one the development dependencies pin. Use `node scripts/build-pi-patch.mjs --version <version>`
for a single version.

Upstream pins `@typescript/native-preview` to the dated dev build `7.0.0-dev.20260120.1`, in both 0.85.1 and 0.87.1. If
that version is withdrawn or its emit changes, reproducibility breaks; the scheduled drift job is the detector.
