#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
AGENT_DIR=${PI_AGENT_DIR:-"${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"}
EXTENSION_DIR="$AGENT_DIR/extensions"
APPLY_SKILLS_PATCH=1
EXTENSIONS=(clear effort markdown-backlinks)
PATCH_FILES=(
  dist/core/resource-loader.js
  dist/core/skill-management.js
  dist/core/slash-commands.js
  dist/main.js
  dist/modes/interactive/interactive-mode.js
  docs/skills.md
)
PATCH_STAGE_DIR=
PATCH_BACKUP_DIR=
PATCH_COMMIT_IN_PROGRESS=0
PATCH_APPLIED=()

restore_applied_files() {
  local restored
  for restored in "${PATCH_APPLIED[@]}"; do
    if [[ -f "$PATCH_BACKUP_DIR/$restored" ]]; then
      cp -p "$PATCH_BACKUP_DIR/$restored" "$PI_PACKAGE_DIR/$restored" ||
        printf 'Could not restore %s\n' "$PI_PACKAGE_DIR/$restored" >&2
    else
      rm -f "$PI_PACKAGE_DIR/$restored" ||
        printf 'Could not remove %s during rollback\n' "$PI_PACKAGE_DIR/$restored" >&2
    fi
  done
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if (( PATCH_COMMIT_IN_PROGRESS )); then
    printf 'Interrupted while applying /skills patch; restoring replaced files.\n' >&2
    restore_applied_files
  fi
  [[ -z "$PATCH_STAGE_DIR" ]] || rm -rf "$PATCH_STAGE_DIR" || true
  [[ -z "$PATCH_BACKUP_DIR" ]] || rm -rf "$PATCH_BACKUP_DIR" || true
  exit "$status"
}
trap 'exit 130' INT
trap 'exit 143' TERM HUP
trap cleanup EXIT

sha256() {
  if command -v shasum >/dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null; then
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
  local path
  path=$(realpath "$1" 2>/dev/null) || return 1
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

for arg in "$@"; do
  case "$arg" in
    --skip-skill-loading-patch) APPLY_SKILLS_PATCH=0 ;;
    -h|--help)
      printf 'Usage: %s [--skip-skill-loading-patch]\n' "$(basename "$0")"
      exit 0
      ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

for extension in "${EXTENSIONS[@]}"; do
  for file in index.ts helpers.ts; do
    if [[ ! -f "$ROOT_DIR/extensions/$extension/$file" ]]; then
      printf 'Missing packaged extension file: %s\n' "$ROOT_DIR/extensions/$extension/$file" >&2
      exit 1
    fi
  done
done

if (( APPLY_SKILLS_PATCH )); then
  PI_PACKAGE_DIR=${PI_PACKAGE_DIR:-}
  if [[ -z "$PI_PACKAGE_DIR" ]]; then
    PI_BIN=$(command -v pi || true)
    if [[ -n "$PI_BIN" ]]; then
      # `pi` is commonly a symlink to <package>/dist/cli.js, so find the
      # package from its resolved entry point instead of assuming npm's bin layout.
      PI_PACKAGE_DIR=$(find_pi_package "$PI_BIN" || true)
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

  if (( package_is_patched )); then
    APPLY_SKILLS_PATCH=0
    printf '/skills patch for pi %s is already applied.\n' "$PI_VERSION"
  elif (( ! package_is_baseline )); then
    printf 'Installed pi %s does not match this patch baseline; refusing to modify it.\n' "$PI_VERSION" >&2
    exit 1
  else
    command -v patch >/dev/null || { printf 'The patch utility is required.\n' >&2; exit 1; }
    PATCH_STAGE_DIR=$(mktemp -d "$PI_PACKAGE_DIR/.pi-skills-patch.XXXXXX")
    PATCH_BACKUP_DIR=$(mktemp -d "$PI_PACKAGE_DIR/.pi-skills-backup.XXXXXX")
    for file in "${PATCH_FILES[@]}"; do
      mkdir -p "$(dirname "$PATCH_STAGE_DIR/$file")" "$(dirname "$PATCH_BACKUP_DIR/$file")"
      if [[ -f "$PI_PACKAGE_DIR/$file" ]]; then
        cp -p "$PI_PACKAGE_DIR/$file" "$PATCH_STAGE_DIR/$file"
        cp -p "$PI_PACKAGE_DIR/$file" "$PATCH_BACKUP_DIR/$file"
      fi
    done
    patch --batch --forward --strip=1 --directory="$PATCH_STAGE_DIR" < "$PATCH_FILE" >/dev/null
    for file in "${PATCH_FILES[@]}"; do
      patched_checksum=$(manifest_checksum "$PATCHED_SUMS" "$file")
      if ! matches_checksum "$patched_checksum" "$PATCH_STAGE_DIR/$file"; then
        printf 'Staged /skills patch produced an unexpected %s.\n' "$file" >&2
        exit 1
      fi
    done
  fi
fi

mkdir -p "$EXTENSION_DIR"
for extension in "${EXTENSIONS[@]}"; do
  mkdir -p "$EXTENSION_DIR/$extension"
  cp "$ROOT_DIR/extensions/$extension/index.ts" "$EXTENSION_DIR/$extension/index.ts"
  cp "$ROOT_DIR/extensions/$extension/helpers.ts" "$EXTENSION_DIR/$extension/helpers.ts"
done

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

printf 'Installed pi extensions from %s\n' "$ROOT_DIR/extensions"
printf 'Destination: %s\n' "$EXTENSION_DIR"
printf 'Run /reload in an active pi session to load changes.\n'
