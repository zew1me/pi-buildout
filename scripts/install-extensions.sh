#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)
AGENT_DIR=${PI_AGENT_DIR:-"${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"}
EXTENSION_DIR="$AGENT_DIR/extensions"
APPLY_SKILLS_PATCH=1
INSTALL_EXTENSIONS=1
EXTENSIONS=(clear effort markdown-backlinks subagents)
# The standalone npm package exposes this script as a `pi-skills-patch` bin symlink.
# Resolve data paths from BASH_SOURCE but use the invocation name to default to patch-only mode.
if [[ "$(basename "$0")" == "pi-skills-patch" ]]; then
  set -- --skip-extensions "$@"
fi
PATCH_FILES=()
UPGRADE_SUMS=()
UPGRADE_PATCHES=()
UPGRADE_ABSENT=()
PATCH_STAGE_DIR=
PATCH_BACKUP_DIR=
PATCH_COMMIT_IN_PROGRESS=0
PATCH_APPLIED=()
EXTENSION_STAGE_DIR=
EXTENSION_TARGET=
EXTENSION_BACKUP=
EXTENSION_COMMIT_IN_PROGRESS=0

restore_applied_files() {
  local restored
  for restored in "${PATCH_APPLIED[@]}"; do
    if [[ -f "$PATCH_BACKUP_DIR/$restored" ]]; then
      cp -p "$PATCH_BACKUP_DIR/$restored" "$PI_PACKAGE_DIR/$restored" \
        || printf 'Could not restore %s\n' "$PI_PACKAGE_DIR/$restored" >&2
    else
      rm -f "$PI_PACKAGE_DIR/$restored" \
        || printf 'Could not remove %s during rollback\n' "$PI_PACKAGE_DIR/$restored" >&2
    fi
  done
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if ((PATCH_COMMIT_IN_PROGRESS)); then
    printf 'Interrupted while applying /skills patch; restoring replaced files.\n' >&2
    restore_applied_files
  fi
  if ((EXTENSION_COMMIT_IN_PROGRESS)); then
    if [[ ! -e "$EXTENSION_TARGET" && ! -L "$EXTENSION_TARGET" && (-e "$EXTENSION_BACKUP" || -L "$EXTENSION_BACKUP") ]]; then
      printf 'Interrupted while installing an extension; restoring %s.\n' "$EXTENSION_TARGET" >&2
      mv "$EXTENSION_BACKUP" "$EXTENSION_TARGET" || true
    fi
  fi
  [[ -z "$EXTENSION_STAGE_DIR" ]] || rm -rf "$EXTENSION_STAGE_DIR" || true
  [[ -z "$EXTENSION_BACKUP" ]] || rm -rf "$EXTENSION_BACKUP" || true
  [[ -z "$PATCH_STAGE_DIR" ]] || rm -rf "$PATCH_STAGE_DIR" || true
  [[ -z "$PATCH_BACKUP_DIR" ]] || rm -rf "$PATCH_BACKUP_DIR" || true
  exit "$status"
}
trap 'exit 130' INT
trap 'exit 143' TERM HUP
trap cleanup EXIT

check_legacy_extension_file() {
  local extension=$1 suffix=$2 legacy_file legacy_source
  legacy_file="$EXTENSION_DIR/$extension$suffix"
  [[ -e "$legacy_file" || -L "$legacy_file" ]] || return 0
  if [[ "$suffix" == .ts ]]; then
    legacy_source="$ROOT_DIR/extensions/$extension/index.ts"
  else
    legacy_source="$ROOT_DIR/extensions/$extension/index.test.mjs"
  fi
  if [[ -L "$legacy_file" || ! -f "$legacy_file" || ! -f "$legacy_source" ]] \
    || ! cmp -s "$legacy_file" "$legacy_source"; then
    printf 'Cannot retire %s: it is not a recognized managed legacy extension file. Move it outside the extensions directory after reviewing it, then retry.\n' "$legacy_file" >&2
    return 1
  fi
}

sha256() {
  if command -v shasum > /dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum > /dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    printf 'A SHA-256 utility (shasum or sha256sum) is required.\n' >&2
    return 1
  fi
}

manifest_checksum() {
  awk -v file="$2" '$2 == file { print $1 }' "$1"
}

matches_checksum() {
  [[ -f "$2" && "$(sha256 "$2")" == "$1" ]]
}

find_pi_package() {
  local path package_dir
  path=$(realpath "$1" 2> /dev/null) || return 1
  # Homebrew's wrapper lives in <formula>/bin while the package is nested under
  # <formula>/libexec/lib/node_modules. Check that layout before walking parents.
  for package_dir in \
    "$(dirname "$path")/../libexec/lib/node_modules/@earendil-works/pi-coding-agent" \
    "$(dirname "$path")/../lib/node_modules/@earendil-works/pi-coding-agent"; do
    if [[ -f "$package_dir/package.json" ]]; then
      printf '%s\n' "$(realpath "$package_dir")"
      return 0
    fi
  done
  path=$(dirname "$path")
  while [[ "$path" != / ]]; do
    if [[ -f "$path/package.json" ]]; then
      printf '%s\n' "$path"
      return 0
    fi
    path=$(dirname "$path")
  done
  return 1
}

find_global_pi_package() {
  local npm_root package_dir
  command -v npm > /dev/null || return 1
  npm_root=$(npm root --global 2> /dev/null) || return 1
  package_dir="$npm_root/@earendil-works/pi-coding-agent"
  [[ -f "$package_dir/package.json" ]] || return 1
  printf '%s\n' "$package_dir"
}

for arg in "$@"; do
  case "$arg" in
    --skip-skill-loading-patch) APPLY_SKILLS_PATCH=0 ;;
    --skip-extensions) INSTALL_EXTENSIONS=0 ;;
    -h | --help)
      if ((!INSTALL_EXTENSIONS)); then
        printf 'Usage: pi-skills-patch [--help]\n'
        printf '  Apply only the version-checked /skills runtime patch to the installed Pi package.\n'
      else
        printf 'Usage: %s [--skip-skill-loading-patch] [--skip-extensions]\n' "$(basename "$0")"
        printf '  --skip-extensions  apply only the /skills patch.\n'
      fi
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

if ((!INSTALL_EXTENSIONS && !APPLY_SKILLS_PATCH)); then
  printf 'Both the patch and extensions were skipped; nothing to install.\n' >&2
  exit 2
fi

if ((INSTALL_EXTENSIONS)); then
  # Pi loads both top-level files and directory entrypoints. Refuse unknown legacy
  # names before patching or replacing any extension directories.
  for extension in "${EXTENSIONS[@]}"; do
    for suffix in .ts .test.mjs; do
      check_legacy_extension_file "$extension" "$suffix"
    done
  done
  for extension in "${EXTENSIONS[@]}"; do
    if [[ ! -f "$ROOT_DIR/extensions/$extension/index.ts" ]]; then
      printf 'Missing packaged extension entrypoint: %s\n' "$ROOT_DIR/extensions/$extension/index.ts" >&2
      exit 1
    fi
    if [[ ! -f "$ROOT_DIR/extensions/$extension/helpers.ts" ]]; then
      printf 'Missing packaged extension helper: %s\n' "$ROOT_DIR/extensions/$extension/helpers.ts" >&2
      exit 1
    fi
  done
fi

if ((APPLY_SKILLS_PATCH)); then
  PI_PACKAGE_DIR=${PI_PACKAGE_DIR:-}
  if [[ -z "$PI_PACKAGE_DIR" ]]; then
    PI_BIN=$(command -v pi || true)
    if [[ -n "$PI_BIN" ]]; then
      # `pi` is commonly a symlink to <package>/dist/cli.js, so find the
      # package from its resolved entry point instead of assuming npm's bin layout.
      PI_PACKAGE_DIR=$(find_pi_package "$PI_BIN" || true)
    fi
    # Version managers such as mise can expose `pi` through a shim rather
    # than the package's CLI entrypoint. Fall back to npm's global package root.
    if [[ -z "$PI_PACKAGE_DIR" ]]; then
      PI_PACKAGE_DIR=$(find_global_pi_package || true)
    fi
  fi
  if [[ -z "$PI_PACKAGE_DIR" || ! -f "$PI_PACKAGE_DIR/package.json" ]]; then
    printf 'Could not locate pi package; install extensions only or set PI_PACKAGE_DIR.\n' >&2
    exit 1
  fi
  PI_VERSION=$(node -p 'require(process.argv[1]).version' "$PI_PACKAGE_DIR/package.json")
  PATCH_DIR="$ROOT_DIR/patches/pi-$PI_VERSION"
  PATCH_FILE="$PATCH_DIR/skills.patch"
  BASELINE_SUMS="$PATCH_DIR/baseline.sha256"
  BASELINE_ABSENT="$PATCH_DIR/baseline.absent"
  PATCHED_SUMS="$PATCH_DIR/patched.sha256"
  if [[ ! -f "$PATCH_FILE" || ! -f "$BASELINE_SUMS" || ! -f "$BASELINE_ABSENT" || ! -f "$PATCHED_SUMS" ]]; then
    printf 'No complete /skills patch exists for pi %s. Use --skip-skill-loading-patch.\n' "$PI_VERSION" >&2
    exit 1
  fi

  while read -r checksum file extra; do
    if [[ ! "$checksum" =~ ^[0-9a-f]{64}$ || -z "$file" || -n "${extra:-}" || "$file" == /* || "$file" == ".." || "$file" == ../* || "$file" == */../* || "$file" == */.. ]]; then
      printf 'Patched checksum manifest contains an invalid entry.\n' >&2
      exit 1
    fi
    PATCH_FILES+=("$file")
  done < "$PATCHED_SUMS"
  if ((${#PATCH_FILES[@]} == 0)); then
    printf 'Patched checksum manifest is empty.\n' >&2
    exit 1
  fi

  for upgrade_sums in "$PATCH_DIR"/*-patched.sha256; do
    [[ -f "$upgrade_sums" ]] || continue
    upgrade_patch=${upgrade_sums%-patched.sha256}-upgrade.patch
    if [[ ! -f "$upgrade_patch" ]]; then
      printf 'The /skills upgrade state %s for pi %s is incomplete.\n' "$(basename "$upgrade_sums")" "$PI_VERSION" >&2
      exit 1
    fi
    UPGRADE_SUMS+=("$upgrade_sums")
    UPGRADE_PATCHES+=("$upgrade_patch")
    # Optional, and empty when the state contains every patched file. Lists paths that must not exist in
    # that state, so a patch which adds a file can still describe the states that predate it.
    upgrade_absent=${upgrade_sums%-patched.sha256}-absent
    [[ -f "$upgrade_absent" ]] || upgrade_absent=
    UPGRADE_ABSENT+=("$upgrade_absent")
  done
  for upgrade_patch in "$PATCH_DIR"/*-upgrade.patch; do
    [[ -f "$upgrade_patch" ]] || continue
    upgrade_sums=${upgrade_patch%-upgrade.patch}-patched.sha256
    if [[ ! -f "$upgrade_sums" ]]; then
      printf 'The /skills upgrade state %s for pi %s is incomplete.\n' "$(basename "$upgrade_patch")" "$PI_VERSION" >&2
      exit 1
    fi
  done

  package_is_baseline=1
  package_is_patched=1
  for file in "${PATCH_FILES[@]}"; do
    patched_checksum=$(manifest_checksum "$PATCHED_SUMS" "$file")
    baseline_checksum=$(manifest_checksum "$BASELINE_SUMS" "$file")
    if [[ ! "$patched_checksum" =~ ^[0-9a-f]{64}$ ]]; then
      printf 'Patched checksum manifest is invalid for %s.\n' "$file" >&2
      exit 1
    fi
    if grep -Fxq "$file" "$BASELINE_ABSENT"; then
      if [[ -n "$baseline_checksum" ]]; then
        printf 'Baseline manifests conflict for %s.\n' "$file" >&2
        exit 1
      fi
      [[ ! -e "$PI_PACKAGE_DIR/$file" && ! -L "$PI_PACKAGE_DIR/$file" ]] || package_is_baseline=0
    else
      if [[ ! "$baseline_checksum" =~ ^[0-9a-f]{64}$ ]]; then
        printf 'Baseline checksum manifest is invalid for %s.\n' "$file" >&2
        exit 1
      fi
      matches_checksum "$baseline_checksum" "$PI_PACKAGE_DIR/$file" || package_is_baseline=0
    fi
    matches_checksum "$patched_checksum" "$PI_PACKAGE_DIR/$file" || package_is_patched=0
  done

  MATCHED_UPGRADE_PATCH=
  for upgrade_index in "${!UPGRADE_SUMS[@]}"; do
    upgrade_sums=${UPGRADE_SUMS[$upgrade_index]}
    upgrade_absent=${UPGRADE_ABSENT[$upgrade_index]}
    upgrade_matches=1
    for file in "${PATCH_FILES[@]}"; do
      upgrade_checksum=$(manifest_checksum "$upgrade_sums" "$file")
      if [[ -n "$upgrade_absent" ]] && grep -Fxq "$file" "$upgrade_absent"; then
        if [[ -n "$upgrade_checksum" ]]; then
          printf 'Upgrade manifests conflict for %s in %s.\n' "$file" "$(basename "$upgrade_sums")" >&2
          exit 1
        fi
        [[ ! -e "$PI_PACKAGE_DIR/$file" && ! -L "$PI_PACKAGE_DIR/$file" ]] || upgrade_matches=0
        continue
      fi
      if [[ ! "$upgrade_checksum" =~ ^[0-9a-f]{64}$ ]]; then
        printf 'Upgrade checksum manifest %s is invalid for %s.\n' "$(basename "$upgrade_sums")" "$file" >&2
        exit 1
      fi
      matches_checksum "$upgrade_checksum" "$PI_PACKAGE_DIR/$file" || upgrade_matches=0
    done
    if ((upgrade_matches)); then
      if [[ -n "$MATCHED_UPGRADE_PATCH" ]]; then
        printf 'Installed pi %s matches multiple /skills upgrade states; refusing to modify it.\n' "$PI_VERSION" >&2
        exit 1
      fi
      MATCHED_UPGRADE_PATCH=${UPGRADE_PATCHES[$upgrade_index]}
    fi
  done

  if ((package_is_patched)); then
    APPLY_SKILLS_PATCH=0
    printf '/skills patch for pi %s is already applied.\n' "$PI_VERSION"
  else
    if [[ -n "$MATCHED_UPGRADE_PATCH" ]]; then
      PATCH_TO_APPLY=$MATCHED_UPGRADE_PATCH
      printf 'Upgrading a previously applied /skills patch for pi %s.\n' "$PI_VERSION"
    elif ((!package_is_baseline)); then
      printf 'Installed pi %s does not match this patch baseline; refusing to modify it.\n' "$PI_VERSION" >&2
      exit 1
    else
      PATCH_TO_APPLY="$PATCH_FILE"
    fi

    command -v patch > /dev/null || {
      printf 'The patch utility is required.\n' >&2
      exit 1
    }
    PATCH_STAGE_DIR=$(mktemp -d "$PI_PACKAGE_DIR/.pi-skills-patch.XXXXXX")
    PATCH_BACKUP_DIR=$(mktemp -d "$PI_PACKAGE_DIR/.pi-skills-backup.XXXXXX")
    for file in "${PATCH_FILES[@]}"; do
      mkdir -p "$(dirname "$PATCH_STAGE_DIR/$file")" "$(dirname "$PATCH_BACKUP_DIR/$file")"
      if [[ -f "$PI_PACKAGE_DIR/$file" ]]; then
        cp -p "$PI_PACKAGE_DIR/$file" "$PATCH_STAGE_DIR/$file"
        cp -p "$PI_PACKAGE_DIR/$file" "$PATCH_BACKUP_DIR/$file"
      fi
    done
    patch --batch --forward --strip=1 --directory="$PATCH_STAGE_DIR" < "$PATCH_TO_APPLY" > /dev/null
    for file in "${PATCH_FILES[@]}"; do
      patched_checksum=$(manifest_checksum "$PATCHED_SUMS" "$file")
      if ! matches_checksum "$patched_checksum" "$PATCH_STAGE_DIR/$file"; then
        printf 'Staged /skills patch produced an unexpected %s.\n' "$file" >&2
        exit 1
      fi
    done
  fi
fi

if ((INSTALL_EXTENSIONS)); then
  mkdir -p "$EXTENSION_DIR"
  for extension in "${EXTENSIONS[@]}"; do
    EXTENSION_STAGE_DIR=$(mktemp -d "$EXTENSION_DIR/.${extension}.XXXXXX")
    while IFS= read -r -d '' source_file; do
      relative_file=${source_file#"$ROOT_DIR/extensions/$extension/"}
      mkdir -p "$EXTENSION_STAGE_DIR/$(dirname "$relative_file")"
      cp "$source_file" "$EXTENSION_STAGE_DIR/$relative_file"
    done < <(find "$ROOT_DIR/extensions/$extension" -type f -name '*.ts' ! -name '*.test.*' -print0)

    EXTENSION_TARGET="$EXTENSION_DIR/$extension"
    EXTENSION_BACKUP="$EXTENSION_STAGE_DIR.backup"
    EXTENSION_COMMIT_IN_PROGRESS=1
    if [[ -e "$EXTENSION_TARGET" || -L "$EXTENSION_TARGET" ]]; then
      mv "$EXTENSION_TARGET" "$EXTENSION_BACKUP"
    fi
    if ! mv "$EXTENSION_STAGE_DIR" "$EXTENSION_TARGET"; then
      printf 'Could not install %s; restoring its previous extension tree.\n' "$extension" >&2
      rm -rf "$EXTENSION_TARGET"
      if [[ -e "$EXTENSION_BACKUP" || -L "$EXTENSION_BACKUP" ]]; then
        mv "$EXTENSION_BACKUP" "$EXTENSION_TARGET"
      fi
      EXTENSION_COMMIT_IN_PROGRESS=0
      exit 1
    fi
    EXTENSION_STAGE_DIR=
    rm -rf "$EXTENSION_BACKUP"
    EXTENSION_BACKUP=
    EXTENSION_TARGET=
    EXTENSION_COMMIT_IN_PROGRESS=0
  done

  # Recheck after replacements, immediately before each deletion: another process may have
  # changed a legacy file while the new extension trees were being staged.
  for extension in "${EXTENSIONS[@]}"; do
    for suffix in .ts .test.mjs; do
      check_legacy_extension_file "$extension" "$suffix"
      rm -f "$EXTENSION_DIR/$extension$suffix"
    done
  done
fi

if [[ -n "$PATCH_STAGE_DIR" ]]; then
  PATCH_COMMIT_IN_PROGRESS=1
  for file in "${PATCH_FILES[@]}"; do
    # Record before rename so cleanup can recover even if interrupted immediately after it.
    PATCH_APPLIED+=("$file")
    if ! mv "$PATCH_STAGE_DIR/$file" "$PI_PACKAGE_DIR/$file"; then
      printf 'Could not apply /skills patch; restoring replaced files.\n' >&2
      restore_applied_files
      PATCH_COMMIT_IN_PROGRESS=0
      exit 1
    fi
  done
  PATCH_COMMIT_IN_PROGRESS=0
  printf 'Applied /skills patch for pi %s\n' "$PI_VERSION"
fi

if ((INSTALL_EXTENSIONS)); then
  printf 'Installed pi extensions from %s\n' "$ROOT_DIR/extensions"
  printf 'Destination: %s\n' "$EXTENSION_DIR"
  printf 'Run /reload in an active pi session to load changes.\n'
fi
