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

| Pre-existing upstream file                   | 0.85.1, previously hand-written | 0.85.1, generated | 0.99.2, generated | 1.0.3, generated | 1.0.4, generated | 1.1.0, generated |
| -------------------------------------------- | ------------------------------- | ----------------- | ----------------- | ---------------- | ---------------- | ---------------- |
| `dist/core/resource-loader.js`               | 55                              | 16                | 16                | 16               | 16               | 16               |
| `dist/core/slash-commands.js`                | 1                               | 1                 | 1                 | 1                | 1                | 1                |
| `dist/main.js`                               | 32                              | 5                 | 5                 | 5                | 5                | 5                |
| `dist/modes/interactive/interactive-mode.js` | 82                              | 25                | 26                | 26               | 26               | 26               |
| **Total**                                    | **170**                         | **47**            | **48**            | **48**           | **48**           | **48**           |

The 0.99.2, 1.0.3, 1.0.4, and 1.1.0 seams make the same calls as the 0.85.1 one. Their one extra edited line is in
`interactive-mode.ts`, which already imports `getCwdRelativePath` from `utils/paths.ts`; the seam extends that import
with `resolvePath` instead of adding a second import from the same module. The shared `skill-management*.ts` needed no
change for these releases and compiles to byte-identical `dist/core/skill-management*.js` in all five generated
versions.

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
  revisions in `ATTRIBUTION.md` exactly (`0.85.1` → `d981de1229ef899957bbe968bc8dcda02a21f477`, `0.99.2` →
  `005af57d88ee23b33778f343a9595b32e67ff788`, `1.0.3` → `d78dc83d633229d12f8b79631384c4c2717c399f`, `1.0.4` →
  `7c10bd4337495ee613f2224843ecdf349b80d1df`, `1.1.0` → `abe508e1b89912adde45528136c3221eb69acdd7`).
- **Upstream ships a deterministic source archive.** Each GitHub release carries `pi-<version>-source.tar.gz` (built by
  upstream's `scripts/create-source-archive.sh`) alongside a `SHA256SUMS`. GitHub's _auto-generated_ tag tarballs are
  not byte-stable and are deliberately not used.

A git submodule was rejected: it vendors the whole tree for no reproducibility gain. A long-lived fork was rejected as
unjustified unless we intend to contribute to or maintain an upstream branch. Upstream is MIT; this repository vendors
no upstream source.

## Reproducibility

Verified for 0.85.1: building the pinned source archive reproduces the published npm runtime **exactly** — 209 of 209
unbundled `.js` files byte-identical, including every tracked file. Verified the same way for 0.99.2: 244 of 244. For
1.0.3, 1.0.4, and 1.1.0, the clean build reproduces all four pre-existing runtime files tracked by each patch
byte-for-byte before the overlay is applied. No normalization is applied. If that ever stops holding, generation fails
rather than emitting a patch carrying toolchain noise.

Two caveats the pipeline must respect:

- `dist/bundle/` is esbuild output with content-hashed chunks and is never rebuilt. The patch replaces the bundled
  entrypoints with the small wrappers in `replacements/`, so only their baseline hashes are needed and those come from
  the npm tarball. For 0.85.1 those are `dist/bundle/cli.js` and `dist/bundle/rpc-entry.js`. In 0.99.2,
  `dist/bundle/cli.js` is a loader that enables Node's compile cache and `require()`s `dist/bundle/cli-runtime.js`, so
  the patch replaces `cli-runtime.js` and `rpc-entry.js` and keeps the loader, declared `"source": "unchanged"` so both
  checksum manifests pin it and the installer rejects a package whose loader would bypass the replaced runtime. Pi
  1.0.3, 1.0.4, and 1.1.0 have the same loader contract. Pi 1.1.0's RPC wrapper additionally preserves upstream's
  process markers and HTTP-dispatcher setup.
- The source archive does not build cleanly end to end offline for 0.85.1: `packages/ai`'s `generate-models` does not
  emit `src/providers/kimi-coding.models.ts`, so `tsgo` reports `TS2307` for that package. It still emits usable output,
  so `packages/coding-agent` is unaffected — but the pipeline must build the workspace chain explicitly and gate on the
  artifact comparison, never on the root build's exit status. The 0.99.2, 1.0.3, 1.0.4, and 1.1.0 workspaces build
  cleanly; the pipeline gates the same way regardless. `workspaceBuildOrder` follows each release's root `build` script;
  0.99.2 adds `packages/codemode`, `packages/mcp`, and `packages/durable`, 1.0.3 uses the same order, 1.0.4 adds
  `packages/env` before `packages/agent`, and 1.1.0 retains that order.

Upstream 0.85.1 pins `@typescript/native-preview` to the dated dev build `7.0.0-dev.20260120.1`; 0.99.2, 1.0.3, 1.0.4,
and 1.1.0 build with the released `typescript` `7.0.2` (`tsc`). If a pinned compiler is withdrawn or its emit changes,
reproducibility breaks; the scheduled drift job is the detector.
