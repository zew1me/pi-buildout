/**
 * Opt-in skill management for the patched Pi runtime.
 *
 * This module holds every piece of original logic in the `/skills` patch. It deliberately imports nothing:
 * both Node built-ins and Pi's own helpers arrive through the injected {@link SkillEnvironment} seam. That
 * keeps the module type-checkable and unit-testable inside this repository, while `skill-management.ts`
 * binds the real implementations when the file is compiled inside a Pi source tree.
 */

/** The subset of Pi's `Skill` that this module reads. Pi's own type is structurally assignable to it. */
export type CatalogSkill = {
  name: string;
  description: string;
  filePath: string;
};

/** The subset of Pi's `SettingsManager` that this module calls. */
export type SettingsManagerLike = {
  isProjectTrusted: () => boolean;
};

/** One resolved package/settings resource from Pi's package manager. */
type ResolvedSkillResource = {
  enabled: boolean;
  path: string;
  metadata: { origin: string; source: string };
};

type SkillCatalogOptions = {
  cwd: string;
  agentDir: string;
  settingsManager?: SettingsManagerLike;
  resolvedSkillResources?: readonly ResolvedSkillResource[];
};

type FileSystemSeam = {
  existsSync: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  mkdirSync: (path: string, options: { recursive: true }) => void;
  readFileSync: (path: string, encoding: "utf-8") => string;
  realpathSync: (path: string) => string;
  renameSync: (from: string, to: string) => void;
  writeFileSync: (path: string, data: string) => void;
};

type PathSeam = {
  dirname: (path: string) => string;
  isAbsolute: (path: string) => boolean;
  join: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
  resolve: (...parts: string[]) => string;
  sep: string;
};

/** Everything environmental or upstream that this module needs. */
/** Environment variables the core sets for Git, merged over the inherited environment by the shell. */
type GitEnvironmentOverrides = { LC_ALL?: "C"; GIT_CEILING_DIRECTORIES?: string };

export type SkillEnvironment = {
  fs: FileSystemSeam;
  path: PathSeam;
  homedir: () => string;
  /** Reads one environment variable, mirroring `process.env[name]`. */
  environmentVariable: (name: string) => string | undefined;
  /** Runs a subprocess and returns stdout, mirroring `child_process.execFileSync`. */
  execFileSync: (
    file: string,
    args: string[],
    options: {
      encoding: "utf-8";
      stdio: ["ignore", "pipe", "pipe" | "ignore"];
      timeout: number;
      /** Overrides merged over the inherited environment. */
      env?: GitEnvironmentOverrides;
    },
  ) => string;
  /** Process id, used only to make the atomic-write temp filename unique. */
  processId: () => number;
  /** Pi's synchronous `proper-lockfile` lock; returns the function that releases it. */
  lockSync: (directory: string, options: { realpath: false; lockfilePath: string }) => () => void;
  /** Blocks the calling thread for the given time without busy-waiting. */
  sleepSync: (milliseconds: number) => void;
  /** Reports a problem that must not replace the result or error of the operation in progress. */
  reportError: (message: string) => void;
  /** Pi's `CONFIG_DIR_NAME`. */
  configDirName: string;
  /** Pi's `resolvePath` from `utils/paths`. */
  resolvePath: (input: string, baseDir: string, options: { trim: true }) => string;
  /** Pi's `loadSkillsFromDir` from `core/skills`. */
  loadSkillsFromDir: (options: { dir: string; source: string }) => { skills: CatalogSkill[] };
  /** Pi's `loadSkills` from `core/skills`. */
  loadSkills: (options: { cwd: string; agentDir: string; skillPaths: string[]; includeDefaults: boolean }) => {
    skills: CatalogSkill[];
  };
  /** Builds an untrusted-by-default `SettingsManager` when a caller does not supply one. */
  createSettingsManager: (cwd: string, agentDir: string) => SettingsManagerLike;
  /** Runs Pi's `DefaultPackageManager.resolve()`. */
  resolvePackageResources: (options: {
    cwd: string;
    agentDir: string;
    settingsManager: SettingsManagerLike;
  }) => Promise<{ skills: ResolvedSkillResource[] }>;
};

export type SkillScope = "global" | "repo" | "directory" | "session";

/** A scope whose entries persist to a configuration file. */
type PersistedScope = Exclude<SkillScope, "session">;

export type ActiveSkillEntry = {
  scope: PersistedScope;
  source: string;
};

export type SkillCommandOptions = {
  cwd: string;
  agentDir: string;
  settingsManager?: SettingsManagerLike;
  allowSession?: boolean;
};

export type SkillCommandResult = {
  exitCode: number;
  lines: string[];
  activeEntries?: ActiveSkillEntry[];
  session?: { action: "add" | "remove"; source: string };
};

export type ActiveSkillEntriesOptions = {
  cwd: string;
  agentDir: string;
  strict?: boolean;
  onWarn?: (message: string) => void;
};

type JsonRecord = Record<string, unknown>;

function isObjectRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(env: SkillEnvironment, path: string): JsonRecord {
  if (!env.fs.existsSync(path)) return {};
  try {
    const value: unknown = JSON.parse(env.fs.readFileSync(path, "utf-8"));
    if (!isObjectRecord(value)) throw new Error("Expected a JSON object");
    return value;
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJson(env: SkillEnvironment, path: string, value: JsonRecord): void {
  env.fs.mkdirSync(env.path.dirname(path), { recursive: true });
  const tempPath = `${path}.${String(env.processId())}.tmp`;
  env.fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  env.fs.renameSync(tempPath, path);
}

const skillConfigLockAttempts = 100;
const skillConfigLockDelayMs = 20;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

/** Follows Pi's trust-store lock: retry only while another process holds the lock. */
function acquireSkillConfigLock(env: SkillEnvironment, path: string): () => void {
  const configDir = env.path.dirname(path);
  env.fs.mkdirSync(configDir, { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    try {
      return env.lockSync(configDir, { realpath: false, lockfilePath: `${path}.lock` });
    } catch (error) {
      if (errorCode(error) !== "ELOCKED" || attempt >= skillConfigLockAttempts) throw error;
      env.sleepSync(skillConfigLockDelayMs);
    }
  }
}

/**
 * Runs a read-modify-write of one configuration file under its lock.
 *
 * A failed release is reported rather than thrown, so it never hides the update's own result or error.
 */
function withSkillConfigLock<T>(env: SkillEnvironment, path: string, fn: () => T): T {
  const release = acquireSkillConfigLock(env, path);
  try {
    return fn();
  } finally {
    try {
      release();
    } catch (error) {
      env.reportError(
        `Could not release skill configuration lock ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// `git rev-parse --local-env-vars` lists settings tied to a repository. These can override `git -C`.
const repositoryGitVariables = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]);

/** Filter actual keys because Windows child processes look up environment variables case-insensitively. */
export function withoutRepositoryGitEnvironment(
  environment: Record<string, string | undefined>,
  caseInsensitive: boolean,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !repositoryGitVariables.has(caseInsensitive ? name.toUpperCase() : name),
    ),
  );
}

function git(
  env: SkillEnvironment,
  cwd: string,
  args: string[],
  strictDiscovery = false,
  extraEnv: GitEnvironmentOverrides = {},
): string | undefined {
  // Match only Git's C-locale non-repository diagnostic, not arbitrary failures with exit status 128.
  const overrides: GitEnvironmentOverrides = strictDiscovery ? { ...extraEnv, LC_ALL: "C" } : extraEnv;
  try {
    return env.execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", strictDiscovery ? "pipe" : "ignore"],
      timeout: 2000,
      ...(Object.keys(overrides).length > 0 ? { env: overrides } : {}),
    });
  } catch (error) {
    if (strictDiscovery && !gitReportedNoRepository(error)) {
      const timedOut = error instanceof Error && "code" in error && error.code === "ETIMEDOUT";
      const reason = timedOut ? "timed out" : "failed";
      throw new Error(`Git checkout discovery ${reason}; check Git and retry the directory-scoped command.`, {
        cause: error,
      });
    }
    return undefined;
  }
}

function gitReportedNoRepository(error: unknown): boolean {
  if (!(error instanceof Error) || !("status" in error) || error.status !== 128 || !("stderr" in error)) return false;
  if (typeof error.stderr !== "string") return false;
  const firstLine = error.stderr.split(/\r?\n/, 1)[0];
  return (
    firstLine === "fatal: not a git repository (or any of the parent directories): .git" ||
    /^fatal: not a git repository \(or any parent up to mount point .+\)$/.test(firstLine ?? "")
  );
}

export function normalizeGitRemoteUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  const url = rawUrl.trim().replace(/^git\+/, "");
  if (!url) return undefined;

  const scpLike = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(url);
  const scpHost = scpLike?.[1];
  const scpPath = scpLike?.[2];
  if (scpHost && scpPath !== undefined && !url.includes("://")) {
    const repoPath = scpPath.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
    return repoPath ? `${scpHost.toLowerCase()}:${repoPath}` : undefined;
  }

  try {
    const parsed = new URL(url);
    const repoPath = parsed.pathname.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
    const defaultPort = parsed.protocol === "ssh:" ? "22" : parsed.protocol === "git:" ? "9418" : undefined;
    const host = parsed.port && parsed.port !== defaultPort ? parsed.host : parsed.hostname;
    return host && repoPath ? `${host.toLowerCase()}:${repoPath}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `checkoutRoot` lets a caller that already looked up the checkout root key that same checkout: remotes are
 * then read from the root, and the no-remote fallback uses it rather than a second lookup.
 */
export function resolveRepoKey(
  env: SkillEnvironment,
  cwd: string,
  checkoutRoot: { value: string | undefined } = { value: findRepoRoot(env, cwd) },
): string | undefined {
  // Read remotes from the captured root, and stop Git from searching above it: if that checkout disappears
  // before these calls, they must not report an enclosing checkout's remote for the captured root.
  let ceiling: GitEnvironmentOverrides = {};
  if (checkoutRoot.value !== undefined) {
    cwd = checkoutRoot.value;
    ceiling = { GIT_CEILING_DIRECTORIES: env.path.dirname(env.path.resolve(cwd)) };
  }
  const remoteUrl = (name: string): string | undefined =>
    normalizeGitRemoteUrl(git(env, cwd, ["remote", "get-url", name], false, ceiling));
  for (const remote of ["upstream", "origin"]) {
    const key = remoteUrl(remote);
    if (key) return key;
  }

  const firstRemote = git(env, cwd, ["remote"], false, ceiling)
    ?.split(/\r?\n/)
    .map((name) => name.trim())
    .find(Boolean);
  const firstKey = firstRemote && remoteUrl(firstRemote);
  if (firstKey) return firstKey;

  // Keep the legacy on-disk key for repositories without a remote. Only the directory identity and
  // path resolution need the untrimmed checkout root; do not look up a second repo bucket.
  const root = checkoutRoot.value?.trim();
  if (!root) return undefined;
  const rel = env.path.relative(env.homedir(), root).split(env.path.sep).join("/");
  return rel && !rel.startsWith("..") && rel !== "." ? `local:~/${rel}` : `local:${root}`;
}

/** The checkout root for `cwd`; relative repository entries resolve against it. */
function findRepoRoot(env: SkillEnvironment, cwd: string, strictDiscovery = false): string | undefined {
  const output = git(env, cwd, ["rev-parse", "--show-toplevel"], strictDiscovery);
  // The output is a path, not a remote name. Remove only Git's record terminator.
  const root =
    env.path.sep === "\\" && output?.endsWith("\r\n")
      ? output.slice(0, -2)
      : output?.endsWith("\n")
        ? output.slice(0, -1)
        : output;
  if (root === "" && strictDiscovery) throw new Error("Git checkout discovery failed: Git returned no checkout root.");
  return root === "" ? undefined : root;
}

/**
 * The directory base that keys directory-scope entries: the root of the current checkout or worktree inside a git
 * repository, otherwise the working directory itself.
 *
 * Unlike {@link resolveRepoKey}, this is a path rather than a remote, so every clone and every git worktree of the
 * same repository gets its own key. It is a real path, so a base reached through a symlink shares its key with the
 * base it points to.
 */
export function resolveDirectoryKey(
  env: SkillEnvironment,
  cwd: string,
  checkoutRoot: { value: string | undefined } = { value: findRepoRoot(env, cwd, true) },
): string {
  const base = env.path.resolve(checkoutRoot.value ?? cwd);
  if (!env.fs.existsSync(base)) return base;
  // The base can disappear between the two calls; its unresolved path keeps global and repository skills
  // loading, and the next reload looks it up again.
  try {
    return env.fs.realpathSync(base);
  } catch {
    return base;
  }
}

export function sourceOf(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as JsonRecord;
  const source = record.source ?? record.path ?? record.name;
  return typeof source === "string" ? source : undefined;
}

export function enabledEntries(value: unknown): unknown[] {
  if (!isObjectRecord(value)) return [];
  const enabled = value.enabled;
  return Array.isArray(enabled) ? enabled : [];
}

/** The scope flags a command surface accepts, in the order usage text lists them. */
function scopeFlags(allowSession: boolean): string[] {
  return ["--global", "--repo", "--directory", ...(allowSession ? ["--session"] : [])];
}

/** The scope flags joined for a usage line, such as `--global|--repo|--directory`. */
function scopeList(allowSession: boolean): string {
  return scopeFlags(allowSession).join("|");
}

export function scopeFromArgs(args: string[], allowSession = false): SkillScope {
  const allowed = scopeFlags(allowSession);
  const scopes = args.filter((arg) => allowed.includes(arg));
  const scope = scopes[0];
  if (scopes.length !== 1 || scope === undefined) {
    const last = allowed.at(-1);
    throw new Error(`Specify exactly one scope: ${allowed.slice(0, -1).join(", ")}, or ${String(last)}.`);
  }
  return scope.slice(2) as SkillScope;
}

export function configLocation(
  env: SkillEnvironment,
  scope: SkillScope,
  cwd: string,
  agentDir: string,
  checkoutRoot?: { value: string | undefined },
): { path?: string; key?: string } {
  if (scope === "global") return { path: env.path.join(agentDir, "skills.json") };
  if (scope === "repo") {
    const key = resolveRepoKey(env, cwd, checkoutRoot);
    if (!key) throw new Error("Repository scope requires a git repository.");
    return { path: env.path.join(agentDir, "repo-skills.json"), key };
  }
  if (scope === "directory") {
    return { path: env.path.join(agentDir, "directory-skills.json"), key: resolveDirectoryKey(env, cwd) };
  }
  return {};
}

export function looksLikePath(value: string): boolean {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    value.startsWith("~") ||
    value.startsWith("$")
  );
}

const environmentVariableReference = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;

/**
 * Expands `$NAME` and `${NAME}` references in a skill path.
 *
 * `/skills` arguments never pass through a shell, so without this a path such as `$HOME/skills/x` would be
 * resolved against the working directory. An unset variable is left as written rather than removed: a path
 * that genuinely contains `$` still resolves, and callers can name the variable when the path does not exist.
 */
export function expandEnvironmentVariables(env: SkillEnvironment, input: string): { value: string; unset: string[] } {
  const unset: string[] = [];
  const value = input.replace(environmentVariableReference, (reference, braced?: string, bare?: string) => {
    const name = braced ?? bare ?? "";
    const expanded = env.environmentVariable(name);
    if (expanded !== undefined) return expanded;
    if (!unset.includes(name)) unset.push(name);
    return reference;
  });
  return { value, unset };
}

/** Resolves a path-like skill source to the absolute path it names, expanding variables and `~`. */
function resolveSkillPath(env: SkillEnvironment, source: string, cwd: string): string {
  return env.resolvePath(expandEnvironmentVariables(env, source).value, cwd, { trim: true });
}

/**
 * True for a path-like source that expands to nothing, such as `$SKILL_DIR` with the variable set to an empty
 * string. Resolving it would name the base directory itself, so it is treated as unresolved; `.` still selects
 * the base explicitly.
 */
function expandsToEmptyPath(env: SkillEnvironment, source: string): boolean {
  return expandEnvironmentVariables(env, source).value.trim() === "";
}

/** True for a path that does not depend on the directory it is read from: absolute, `~`, or a `file:` URL. */
function isAnchoredPath(env: SkillEnvironment, value: string): boolean {
  return env.path.isAbsolute(value) || value === "~" || value.startsWith("~/") || value.startsWith("file:");
}

/** `path` relative to `root` with `/` separators, comparing real paths, or undefined when it lies outside. */
function pathInside(env: SkillEnvironment, root: string, path: string): string | undefined {
  const real = (value: string): string => (env.fs.existsSync(value) ? env.fs.realpathSync(value) : value);
  const relative = env.path.relative(real(root), real(path));
  if (relative === ".." || relative.startsWith(`..${env.path.sep}`) || env.path.isAbsolute(relative)) return undefined;
  return relative.split(env.path.sep).join("/");
}

/**
 * Where a persisted entry lives, which decides what its relative paths are relative to.
 *
 * `root` is the base that relative entries of a keyed scope resolve against: the checkout root for repository
 * scope, the directory base for directory scope, and undefined for global scope, whose relative entries resolve
 * against the working directory.
 */
type EntryContext = { cwd: string; scope: SkillScope; root: string | undefined };

/**
 * Chooses how an added path is written to configuration.
 *
 * Repository entries are shared by every checkout with the same remote, so a path inside the current checkout
 * is stored relative to its root; a directory entry likewise stores a path inside its base relative to that base,
 * so it resolves the same way from any subdirectory. Otherwise a `~` or `$NAME` spelling that resolves now is kept as typed, so it
 * is expanded each time skills load rather than frozen at add time, and any other path is stored absolute,
 * under `~` when it is in the home directory.
 */
function persistedForm(env: SkillEnvironment, source: string, resolvedPath: string, context: EntryContext): string {
  const rootRelative = context.root === undefined ? undefined : pathInside(env, context.root, resolvedPath);
  if (rootRelative === "") return ".";
  // A literal ~/ or file: prefix inside the root must not become an anchored path, and leading whitespace must
  // survive the trim applied when skills load. A generated path containing any variable reference, set or not,
  // could expand differently in a later process, so the original portable spelling is preferred over it.
  if (rootRelative?.search(environmentVariableReference) === -1 && rootRelative.trimEnd() === rootRelative) {
    const needsPrefix = !looksLikePath(rootRelative) || isAnchoredPath(env, rootRelative) || /^\s/.test(rootRelative);
    return needsPrefix ? `./${rootRelative}` : rootRelative;
  }
  const typed = source.trim();
  if (isPortableSpelling(env, typed)) return typed;
  const home = pathInside(env, env.homedir(), resolvedPath);
  // A resolved alias can still name its target even when the canonical spelling ends in whitespace.
  // Keep the alias rather than storing a generated spelling that the loader would trim.
  const hasPortableHomePath = home !== undefined && !/\s$/.test(home);
  const fallback = hasPortableHomePath ? (home === "" ? "~" : `~/${home}`) : resolvedPath;
  if (fallback.trimEnd() !== fallback) {
    throw new Error(`Cannot persist ${resolvedPath}: trailing whitespace would be trimmed when skills load.`);
  }
  // A literal `$NAME` in the path that is set now would expand on the next load and name a different path.
  if (expandEnvironmentVariables(env, fallback).value !== fallback) {
    throw new Error(
      `Cannot persist ${resolvedPath}: it contains an environment variable reference that would expand when skills load.`,
    );
  }
  return fallback;
}

/** Variables naming a working directory: a path spelled with them means the directory it named at add time. */
const directoryVariables = new Set(["PWD", "OLDPWD"]);

function referencesDirectoryVariable(typed: string): boolean {
  return [...typed.matchAll(environmentVariableReference)].some((match) =>
    directoryVariables.has(match[1] ?? match[2] ?? ""),
  );
}

/** True for a `~` or `$NAME` path that resolves the same way from any directory in the current environment. */
function isPortableSpelling(env: SkillEnvironment, typed: string): boolean {
  const spelled = typed === "~" || typed.startsWith("~/") || typed.search(environmentVariableReference) !== -1;
  if (!spelled || !looksLikePath(typed) || referencesDirectoryVariable(typed)) return false;
  const { value, unset } = expandEnvironmentVariables(env, typed);
  return unset.length === 0 && isAnchoredPath(env, value.trim());
}

function unsetVariableHint(env: SkillEnvironment, source: string): string | undefined {
  const { unset } = expandEnvironmentVariables(env, source);
  if (unset.length === 0) return undefined;
  const names = unset.map((name) => `$${name}`).join(", ");
  return `environment variable ${names} ${unset.length === 1 ? "is" : "are"} not set`;
}

function skillNotFoundMessage(env: SkillEnvironment, source: string): string {
  const hint = looksLikePath(source) ? unsetVariableHint(env, source) : undefined;
  return `Skill not found in the catalog or at an existing path: ${source}${hint ? ` (${hint})` : ""}`;
}

/** Explains why a persisted path entry could not be found, beyond its simply not existing. */
function unresolvedEntryHint(
  env: SkillEnvironment,
  source: string,
  scope: ActiveSkillEntry["scope"],
): string | undefined {
  if (!looksLikePath(source)) return undefined;
  const unset = unsetVariableHint(env, source);
  if (unset !== undefined) return unset;
  if (isAnchoredPath(env, expandEnvironmentVariables(env, source).value.trim())) return undefined;
  if (scope === "repo") return "relative repository paths resolve against the root of the current checkout";
  if (scope === "directory") {
    return "relative directory paths resolve against the root of the current checkout, or the working directory outside one";
  }
  return "relative paths resolve against the working directory; remove it, then add it again to store its absolute path";
}

function unresolvedSkillDiagnostic(env: SkillEnvironment, entry: ActiveSkillEntry): SkillDiagnostic {
  const hint = unresolvedEntryHint(env, entry.source, entry.scope);
  return {
    type: "warning",
    message: `Active skill could not be resolved${hint ? `: ${hint}` : ""}`,
    path: entry.source,
  };
}

/** True when `path` exists and Pi's own loader finds at least one skill in it. */
function containsSkills(env: SkillEnvironment, path: string, options: { cwd: string; agentDir: string }): boolean {
  if (!env.fs.existsSync(path)) return false;
  const { skills } = env.loadSkills({
    cwd: options.cwd,
    agentDir: options.agentDir,
    skillPaths: [path],
    includeDefaults: false,
  });
  return skills.length > 0;
}

/**
 * Normalizes an entry already persisted in a configuration file, for comparison.
 *
 * User input is normalized before it is stored, so a stored bare value is a catalog name and is compared
 * literally. Resolving it against whatever happens to exist in the current directory would let an unrelated
 * local folder make a catalog-name entry match, or block, a path entry. A path entry compares by the real path
 * it names, so `~/x`, `$HOME/x`, and a repository- or directory-relative `x` all match the same absolute path.
 */
function normalizePersistedSource(
  env: SkillEnvironment,
  source: string | undefined,
  context: EntryContext,
): string | undefined {
  if (!source) return undefined;
  if (!looksLikePath(source)) return source;
  const value = expandEnvironmentVariables(env, source).value.trim();
  if (value === "") return source;
  const path =
    context.root !== undefined && !isAnchoredPath(env, value)
      ? env.path.resolve(context.root, value)
      : env.resolvePath(value, context.cwd, { trim: true });
  return canonicalSkillPath(env, path);
}

function canonicalSkillPath(env: SkillEnvironment, path: string): string {
  return env.fs.existsSync(path) ? env.fs.realpathSync(path) : path;
}

/** Where a mutation writes and what its relative paths are relative to, resolved together once. */
type MutationTarget = { location: { path?: string; key?: string }; context: EntryContext };

/**
 * Resolves the configuration location and entry context for one mutation.
 *
 * Formatting the path, matching existing entries, and selecting the bucket must all use the same base: if a
 * checkout were created or removed between separate lookups, a path could be written relative to one base
 * under the key of another. A directory key is its base, so it is looked up only once.
 */
function mutationTarget(env: SkillEnvironment, scope: SkillScope, cwd: string, agentDir: string): MutationTarget {
  if (scope === "repo") {
    // One checkout lookup selects the bucket and is the base its relative entries are written against.
    const checkoutRoot = { value: findRepoRoot(env, cwd) };
    const location = configLocation(env, scope, cwd, agentDir, checkoutRoot);
    return { location, context: { cwd, scope, root: checkoutRoot.value } };
  }
  const location = configLocation(env, scope, cwd, agentDir);
  return { location, context: { cwd, scope, root: scope === "directory" ? location.key : undefined } };
}

export function updatePersistedSkill(
  env: SkillEnvironment,
  action: "add" | "remove",
  source: string,
  scope: SkillScope,
  options: { cwd: string; agentDir: string },
  resolvedTarget: MutationTarget = mutationTarget(env, scope, options.cwd, options.agentDir),
): boolean {
  const key = normalizePersistedSource(env, source, resolvedTarget.context);
  return updatePersistedSkillByKey(env, action, source, scope, resolvedTarget, key);
}

function updatePersistedSkillByKey(
  env: SkillEnvironment,
  action: "add" | "remove",
  source: string,
  scope: SkillScope,
  { location, context }: MutationTarget,
  key: string | undefined,
): boolean {
  const path = location.path;
  if (path === undefined) throw new Error(`Scope ${scope} has no persisted configuration.`);

  const matches = (entry: unknown): boolean => normalizePersistedSource(env, sourceOf(entry), context) === key;

  return withSkillConfigLock(env, path, () => {
    const config = readJson(env, path);
    const existing = location.key === undefined ? config : config[location.key];
    const target: JsonRecord = location.key === undefined ? config : isObjectRecord(existing) ? existing : {};

    const enabled = enabledEntries(target);
    const matched = enabled.some(matches);
    if (action === "remove" && !matched) return false;

    target.enabled =
      action === "add" ? (matched ? enabled : [...enabled, source]) : enabled.filter((entry) => !matches(entry));

    // Directory keys are paths, one per checkout, worktree, or plain directory ever used, so a key is dropped
    // once nothing is enabled under it. Keys are never pruned for a directory that no longer exists: such a key
    // is inert, and the directory may only be temporarily unavailable, such as on an unmounted volume.
    if (location.key !== undefined && scope === "directory" && enabledEntries(target).length === 0) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the key is a path, so a Map-shaped object is the stored format
      delete config[location.key];
    } else if (location.key !== undefined) config[location.key] = target;
    writeJson(env, path, config);
    return true;
  });
}

/**
 * Compares remove operands relative to cwd, while stored entries resolve against their scope's base.
 * A path operand is expanded once; its resolved path may itself contain literal variable syntax.
 * A bare name tries the catalog name first, then the cwd-relative path, even if that path was deleted.
 */
function removePersistedSkill(
  env: SkillEnvironment,
  source: string,
  scope: SkillScope,
  resolvedTarget: MutationTarget,
): boolean {
  const { context } = resolvedTarget;
  const operand = normalizePersistedSource(env, source, { ...context, root: undefined });
  const remove = (key: string | undefined): boolean =>
    updatePersistedSkillByKey(env, "remove", source, scope, resolvedTarget, key);
  return (
    remove(operand) ||
    (!looksLikePath(source) && remove(canonicalSkillPath(env, env.resolvePath(source, context.cwd, { trim: true }))))
  );
}

export function getActiveSkillEntries(env: SkillEnvironment, options: ActiveSkillEntriesOptions): ActiveSkillEntry[] {
  return readActiveSkillEntries(env, options).entries;
}

/**
 * `strictDirectory` defaults to `strict`. Listing passes `false` so a Git discovery failure is reported through
 * `onWarn` while the other scopes still list; only mutations need strict discovery to avoid a fallback bucket.
 */
function readActiveSkillEntries(
  env: SkillEnvironment,
  { cwd, agentDir, strict = false, onWarn }: ActiveSkillEntriesOptions,
  strictDirectory = strict,
): { entries: ActiveSkillEntry[]; directoryKey: string | undefined; repoRoot: string | undefined } {
  const entries: ActiveSkillEntry[] = [];
  const safeRead = (path: string): JsonRecord => {
    try {
      return readJson(env, path);
    } catch (error) {
      if (strict) throw error;
      onWarn?.(`Ignoring skill configuration: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  };

  const append = (scope: PersistedScope, config: unknown): void => {
    for (const entry of enabledEntries(config)) {
      const source = sourceOf(entry);
      if (source) entries.push({ scope, source });
    }
  };
  append("global", safeRead(env.path.join(agentDir, "skills.json")));
  const directoryConfig = safeRead(env.path.join(agentDir, "directory-skills.json"));
  const needsDirectoryKey = Object.keys(directoryConfig).length > 0;

  // One checkout lookup selects the repository bucket, keys the directory bucket and supplies the base for
  // relative repository entries, so a checkout that appears or changes in between cannot pair one checkout's
  // entries with another's root. Discovery is strict only when a directory key depends on it.
  let discovery: CheckoutDiscovery;
  try {
    discovery = { value: findRepoRoot(env, cwd, needsDirectoryKey) };
  } catch (error) {
    discovery = { error };
  }
  const repoRoot = "value" in discovery ? discovery.value : undefined;
  const key = resolveRepoKey(env, cwd, { value: repoRoot });
  if (key) append("repo", safeRead(env.path.join(agentDir, "repo-skills.json"))[key]);

  // Directory entries come last, so on a name collision between different files the broader scope's skill
  // loads first and wins, as global already does over repository.
  const directoryKey = needsDirectoryKey ? readDirectoryKey(env, cwd, discovery, strictDirectory, onWarn) : undefined;
  // A running loader can retain a cwd that no longer exists. Leave its saved entries alone, but do not
  // activate them even if the entries themselves point to paths that still exist outside the base.
  if (directoryKey !== undefined && env.fs.isDirectory(directoryKey))
    append("directory", directoryConfig[directoryKey]);
  return { entries, directoryKey, repoRoot };
}

/** The result of one checkout-root lookup: the root (undefined outside a checkout), or why discovery failed. */
type CheckoutDiscovery = { value: string | undefined } | { error: unknown };

function readDirectoryKey(
  env: SkillEnvironment,
  cwd: string,
  discovery: CheckoutDiscovery,
  strict: boolean,
  onWarn: ActiveSkillEntriesOptions["onWarn"],
): string | undefined {
  // A lookup that found no checkout is still an answer: key by cwd rather than asking Git again.
  if ("value" in discovery) return resolveDirectoryKey(env, cwd, discovery);
  if (strict) throw discovery.error;
  const { error } = discovery;
  onWarn?.(`Ignoring directory skills: ${error instanceof Error ? error.message : String(error)}`);
  return undefined;
}

function getProjectAgentSkillDirs(env: SkillEnvironment, cwd: string): string[] {
  const dirs: string[] = [];
  const repoRoot = findRepoRoot(env, cwd);
  const stopAt = repoRoot ? env.fs.realpathSync(env.path.resolve(repoRoot)) : undefined;
  const resolvedCwd = env.path.resolve(cwd);
  if (!env.fs.existsSync(resolvedCwd)) return dirs;

  let current = env.fs.realpathSync(resolvedCwd);
  for (;;) {
    if (stopAt !== undefined) {
      const fromRoot = env.path.relative(stopAt, current);
      if (fromRoot === ".." || fromRoot.startsWith(`..${env.path.sep}`) || env.path.isAbsolute(fromRoot)) break;
    }
    dirs.push(env.path.join(current, ".agents", "skills"));
    if (current === stopAt) break;
    const parent = env.path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

export function getSkillCatalogDirs(
  env: SkillEnvironment,
  { cwd, agentDir, projectTrusted = false }: { cwd: string; agentDir: string; projectTrusted?: boolean },
): string[] {
  const dirs = [env.path.join(agentDir, "skills"), env.path.join(env.homedir(), ".agents", "skills")];
  if (projectTrusted) {
    dirs.push(env.path.join(cwd, env.configDirName, "skills"), ...getProjectAgentSkillDirs(env, cwd));
  }
  return dirs;
}

export async function getSkillCatalog(
  env: SkillEnvironment,
  { cwd, agentDir, settingsManager, resolvedSkillResources }: SkillCatalogOptions,
): Promise<CatalogSkill[]> {
  const manager = settingsManager ?? env.createSettingsManager(cwd, agentDir);
  const found = new Map<string, CatalogSkill>();
  const addSkills = (skills: CatalogSkill[]): void => {
    for (const skill of skills) {
      if (!found.has(skill.name)) found.set(skill.name, skill);
    }
  };

  for (const dir of getSkillCatalogDirs(env, { cwd, agentDir, projectTrusted: manager.isProjectTrusted() })) {
    addSkills(env.loadSkillsFromDir({ dir, source: "path" }).skills);
  }

  const resolved =
    resolvedSkillResources ?? (await env.resolvePackageResources({ cwd, agentDir, settingsManager: manager })).skills;
  const addResolvedSkills = (resources: ResolvedSkillResource[]): void => {
    const paths = resources.filter((resource) => resource.enabled).map((resource) => resource.path);
    addSkills(env.loadSkills({ cwd, agentDir, skillPaths: paths, includeDefaults: false }).skills);
  };

  addResolvedSkills(resolved.filter((resource) => resource.metadata.origin === "package"));
  addResolvedSkills(
    resolved.filter((resource) => resource.metadata.origin === "top-level" && resource.metadata.source === "local"),
  );

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function resolveSkillSource(
  env: SkillEnvironment,
  source: string,
  options: SkillCatalogOptions,
): Promise<{ normalized: string; resolved: string | undefined }> {
  if (looksLikePath(source)) {
    const resolvedPath = resolveSkillPath(env, source, options.cwd);
    const exists = !expandsToEmptyPath(env, source) && env.fs.existsSync(resolvedPath);
    return { normalized: resolvedPath, resolved: exists ? resolvedPath : undefined };
  }
  const resolvedPath = env.resolvePath(source, options.cwd, { trim: true });

  // Build the catalog once, then use it both to prefer catalog names over same-named local folders and to
  // resolve the selected skill. A bare local folder is retained as a path only when no catalog entry wins.
  const catalog = await getSkillCatalog(env, options);
  const catalogSkill = catalog.find((skill) => skill.name === source);
  const normalized = containsSkills(env, resolvedPath, options) && !catalogSkill ? resolvedPath : source;
  return { normalized, resolved: normalized === source ? catalogSkill?.filePath : resolvedPath };
}

function commandName(allowSession = false): string {
  return allowSession ? "/skills" : "pi skills";
}

export function usage(allowSession = false): string[] {
  const command = commandName(allowSession);
  const scopes = scopeList(allowSession);
  return [
    `Usage: ${command} <active|list|search|add|remove${allowSession ? "|reload" : ""}>`,
    `  ${command} active`,
    `  ${command} list`,
    `  ${command} search <query>`,
    `  ${command} add <skill-or-path> ${scopes}`,
    `  ${command} remove <skill-or-path> ${scopes}`,
    ...(allowSession ? [`  ${command} reload`] : []),
  ];
}

function runActiveCommand(
  env: SkillEnvironment,
  rest: string[],
  surface: string,
  options: SkillCommandOptions,
): SkillCommandResult {
  if (rest.length !== 0) throw new Error(`Usage: ${surface} active`);
  const warnings: string[] = [];
  const { entries, directoryKey, repoRoot } = readActiveSkillEntries(
    env,
    { ...options, strict: true, onWarn: (message) => warnings.push(message) },
    false,
  );
  const operand = ({ source, scope }: ActiveSkillEntry): string => {
    if (scope === "global" || !looksLikePath(source)) return source;
    const value = expandEnvironmentVariables(env, source).value.trim();
    if (value === "" || isAnchoredPath(env, value)) return source;
    const root = scope === "directory" ? directoryKey : repoRoot;
    if (root === undefined) return source;

    // `remove` resolves an operand against cwd, not the base of a stored entry. Show a path that names
    // the same target from this cwd, or label the stored spelling with its base if it cannot round-trip.
    const absolute = env.path.resolve(root, value);
    const usable = (path: string): boolean =>
      !(options.allowSession && /\s/.test(path)) && resolveSkillPath(env, path, options.cwd) === absolute;
    if (usable(absolute)) return absolute;
    const relative = `./${env.path.relative(options.cwd, absolute)}`;
    return usable(relative) ? relative : `${source} (relative to ${root})`;
  };
  return {
    exitCode: 0,
    lines: entries.length
      ? ["Active skills:", ...entries.map((entry) => `  ${entry.scope}: ${operand(entry)}`), ...warnings]
      : ["Skills: none", ...warnings],
    activeEntries: entries,
  };
}

async function runCatalogCommand(
  env: SkillEnvironment,
  command: "list" | "search",
  rest: string[],
  surface: string,
  options: SkillCommandOptions,
): Promise<SkillCommandResult> {
  if (command === "list" && rest.length !== 0) throw new Error(`Usage: ${surface} list`);
  const query = command === "search" ? rest.join(" ").trim().toLowerCase() : "";
  if (command === "search" && !query) throw new Error(`Usage: ${surface} search <query>`);

  const skills = (await getSkillCatalog(env, options)).filter(
    (skill) => !query || `${skill.name} ${skill.description}`.toLowerCase().includes(query),
  );
  return {
    exitCode: 0,
    lines: skills.length
      ? skills.map((skill) => `${skill.name}\t${skill.description}`)
      : [query ? "No matching skills." : "No catalog skills found."],
  };
}

/** What `add` writes for a resolved source: a catalog name as is, a path in its {@link persistedForm}. */
function persistedAddForm(env: SkillEnvironment, source: string, target: string, context: EntryContext): string {
  if (!looksLikePath(source) && target === source) return source;
  return persistedForm(env, source, target, context);
}

async function runMutationCommand(
  env: SkillEnvironment,
  command: "add" | "remove",
  rest: string[],
  surface: string,
  options: SkillCommandOptions,
): Promise<SkillCommandResult> {
  const scopes = scopeList(options.allowSession ?? false);
  const source = rest.find((arg) => !arg.startsWith("--"));
  if (!source) throw new Error(`Usage: ${surface} ${command} <skill-or-path> ${scopes}`);

  const scope = scopeFromArgs(rest, options.allowSession);
  if (rest.length !== 2 || rest.some((arg) => ![source, `--${scope}`].includes(arg))) {
    throw new Error(`Usage: ${surface} ${command} <skill-or-path> ${scopes}`);
  }

  // Removal never consults the catalog, whose package resolution can install missing packages. A stored bare
  // value is a catalog name, so removing a bare name tries that literal name first and its resolved path after.
  const resolution = command === "add" ? await resolveSkillSource(env, source, options) : undefined;
  if (resolution && !resolution.resolved) throw new Error(skillNotFoundMessage(env, source));

  if (scope === "session") {
    return { exitCode: 0, lines: [], session: { action: command, source: resolution?.normalized ?? source } };
  }

  const resolvedTarget = mutationTarget(env, scope, options.cwd, options.agentDir);
  const updated = resolution
    ? updatePersistedSkill(
        env,
        "add",
        persistedAddForm(env, source, resolution.normalized, resolvedTarget.context),
        scope,
        options,
        resolvedTarget,
      )
    : removePersistedSkill(env, source, scope, resolvedTarget);
  if (!updated) throw new Error(`Skill is not enabled for ${scope} scope: ${source}`);
  return { exitCode: 0, lines: [`${command === "add" ? "Enabled" : "Disabled"} ${source} for ${scope} scope.`] };
}

export async function runSkillsCommand(
  env: SkillEnvironment,
  args: string[],
  options: SkillCommandOptions,
): Promise<SkillCommandResult> {
  try {
    const surface = commandName(options.allowSession);
    const [command, ...rest] = args;
    if (command === "active") return runActiveCommand(env, rest, surface, options);
    if (command === "list" || command === "search") {
      return await runCatalogCommand(env, command, rest, surface, options);
    }
    if (command === "add" || command === "remove") {
      return await runMutationCommand(env, command, rest, surface, options);
    }
    return { exitCode: 1, lines: usage(options.allowSession) };
  } catch (error) {
    return { exitCode: 1, lines: [error instanceof Error ? error.message : String(error)] };
  }
}

/** A warning Pi surfaces alongside loaded skills. Structurally a subset of Pi's `ResourceDiagnostic`. */
export type SkillDiagnostic = { type: "warning"; message: string; path?: string };

/**
 * What {@link resolveActiveSkillPaths} needs from `DefaultResourceLoader`.
 *
 * `resolveResourcePath` stays a callback because it applies the loader's own `~`/relative expansion.
 */
export type ActiveSkillPathsContext = {
  cwd: string;
  agentDir: string;
  settingsManager?: SettingsManagerLike;
  /** Package resources already resolved by the resource loader for its current reload. */
  resolvedSkillResources?: readonly ResolvedSkillResource[];
  resolveResourcePath: (path: string) => string;
};

/**
 * Resolves the skills that are explicitly active for this session into concrete paths.
 *
 * Entries are either paths, which must exist, or catalog names, which are looked up by name. Path entries
 * are expanded here, each time skills load, rather than when they are added: `~` and `$NAME` take the current
 * environment, a relative repository entry resolves against the root of the current checkout, and a relative
 * directory entry resolves against its directory base. The loader
 * keeps the result until its next reload (`/reload`, `/skills reload`, or the reload `/skills add` and
 * `/skills remove` trigger), which is what makes this a once-per-session expansion. The catalog is built at
 * most once per call: every caller resolves a whole entry list in one pass, so a longer-lived cache would only
 * need invalidating without ever being reused.
 */
export async function resolveActiveSkillPaths(
  env: SkillEnvironment,
  context: ActiveSkillPathsContext,
): Promise<{ paths: string[]; diagnostics: SkillDiagnostic[] }> {
  const { cwd, agentDir } = context;
  const paths: string[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  // The checkout root comes from the same lookup that selected the repository bucket, before the catalog wait
  // below, so a checkout that changes afterwards cannot supply the base for that bucket's entries.
  const { entries, directoryKey, repoRoot } = readActiveSkillEntries(env, {
    cwd,
    agentDir,
    onWarn: (message) => diagnostics.push({ type: "warning", message }),
  });

  let catalogPathsByName: Map<string, string> | undefined;
  if (entries.some((entry) => !looksLikePath(entry.source))) {
    const catalog = await getSkillCatalog(env, context);
    catalogPathsByName = new Map(catalog.map((skill) => [skill.name, skill.filePath]));
  }
  // Catalog lookup can yield while the base disappears. Validate the captured key, not another checkout lookup.
  const directoryUnavailable =
    catalogPathsByName !== undefined && directoryKey !== undefined && !env.fs.isDirectory(directoryKey);

  const resolveEntryPath = activeEntryPathResolver(env, context, directoryKey, repoRoot);
  for (const entry of entries) {
    if (entry.scope === "directory" && directoryUnavailable) continue;
    const path = looksLikePath(entry.source) ? resolveEntryPath(entry) : catalogPathsByName?.get(entry.source);
    if (path !== undefined) paths.push(path);
    else diagnostics.push(unresolvedSkillDiagnostic(env, entry));
  }
  return { paths, diagnostics };
}

function activeEntryPathResolver(
  env: SkillEnvironment,
  { resolveResourcePath }: ActiveSkillPathsContext,
  directoryKey: string | undefined,
  repoRoot: string | undefined,
): (entry: ActiveSkillEntry) => string | undefined {
  return ({ source, scope }) => {
    const value = expandEnvironmentVariables(env, source).value.trim();
    if (value === "") return undefined;
    let base: string | undefined;
    if (!isAnchoredPath(env, value)) {
      if (scope === "directory") base = directoryKey;
      // A relative repository entry names a path inside its checkout. Without an observed root (a bare
      // repository, or a checkout that appeared after the lookup) there is nothing to resolve it against.
      if (scope === "repo" && repoRoot === undefined) return undefined;
      if (scope === "repo") base = repoRoot;
    }
    const path = base === undefined ? resolveResourcePath(value) : env.path.resolve(base, value);
    return env.fs.existsSync(path) ? path : undefined;
  };
}

/**
 * Resolves a single skill entry for session scope.
 *
 * Returns both the normalized form (an expanded path, or the catalog name unchanged) and the concrete file
 * path when one exists. Session activation needs both: the normalized form to match entries already in the
 * session list, and the resolved path to add.
 */
export async function resolveSkillEntryPath(
  env: SkillEnvironment,
  context: ActiveSkillPathsContext,
  source: string,
): Promise<{ normalized: string; resolved: string | undefined }> {
  const { cwd, agentDir, settingsManager, resolvedSkillResources, resolveResourcePath } = context;

  if (looksLikePath(source)) {
    const normalized = resolveResourcePath(expandEnvironmentVariables(env, source).value);
    const exists = !expandsToEmptyPath(env, source) && env.fs.existsSync(normalized);
    return { normalized, resolved: exists ? normalized : undefined };
  }

  const catalog = await getSkillCatalog(env, {
    cwd,
    agentDir,
    ...(settingsManager ? { settingsManager } : {}),
    ...(resolvedSkillResources ? { resolvedSkillResources } : {}),
  });
  return { normalized: source, resolved: catalog.find((skill) => skill.name === source)?.filePath };
}

/** What {@link handleSkillsInteractive} needs from `InteractiveMode`. */
export type InteractiveSkillsContext = {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManagerLike;
  /**
   * The resource loader's session skill list, mutated in place so the loader sees the change.
   *
   * Optional because `ResourceLoader` implementations other than `DefaultResourceLoader` need not expose it;
   * session scope reports that it is unavailable rather than failing.
   */
  additionalSkillPaths: string[] | undefined;
  resolveResourcePath: (path: string) => string;
  /** True while the agent is streaming or compacting, when a reload must be deferred. */
  isBusy: () => boolean;
  reload: () => Promise<void>;
  showWarning: (message: string) => void;
  showError: (message: string) => void;
  showOutput: (message: string) => void;
};

/**
 * Applies a session-scope activation to the resource loader's own skill list.
 *
 * Returns the line to show, or `undefined` when it has already reported an error. The list is mutated in
 * place because the loader holds the same array.
 */
async function applySessionSkillChange(
  env: SkillEnvironment,
  session: { action: "add" | "remove"; source: string },
  context: InteractiveSkillsContext,
): Promise<string | undefined> {
  const { cwd, agentDir, settingsManager, additionalSkillPaths, resolveResourcePath } = context;
  if (!additionalSkillPaths) {
    context.showError("Session skill activation is unavailable for this resource loader.");
    return undefined;
  }

  if (session.action === "add") {
    const pathContext = { cwd, agentDir, settingsManager, resolveResourcePath };
    const { resolved } = await resolveSkillEntryPath(env, pathContext, session.source);
    if (!resolved) {
      context.showError(`Skill not found in the catalog: ${session.source}`);
      return undefined;
    }
    if (!additionalSkillPaths.includes(resolved)) additionalSkillPaths.push(resolved);
    return `Enabled ${resolved} for this session.`;
  }

  // Removal must not resolve packages. Recover bare names from the already-enabled paths, and compare explicit
  // paths after applying the same resolution used by the resource loader.
  const pathSource = looksLikePath(session.source);
  const value = pathSource ? expandEnvironmentVariables(env, session.source).value : session.source;
  if (pathSource && value.trim() === "") {
    context.showError(`Skill is not enabled for this session: ${session.source}`);
    return undefined;
  }
  const normalized = pathSource ? resolveResourcePath(value) : value;
  const skillPaths = pathSource
    ? []
    : env
        .loadSkills({ cwd, agentDir, skillPaths: additionalSkillPaths, includeDefaults: false })
        .skills.filter((skill) => skill.name === session.source)
        .map((skill) => skill.filePath);
  const direct = (path: string): boolean => path === normalized || skillPaths.includes(path);
  // A bare name added as a local path stays removable by that name after the path is deleted, but only when
  // nothing matches it directly.
  const localPath = pathSource ? undefined : env.resolvePath(session.source, cwd, { trim: true });
  const matches = additionalSkillPaths.some(direct) ? direct : (path: string): boolean => path === localPath;
  if (!additionalSkillPaths.some(matches)) {
    context.showError(`Skill is not enabled for this session: ${session.source}`);
    return undefined;
  }
  const retained = additionalSkillPaths.filter((path) => !matches(path));
  additionalSkillPaths.splice(0, additionalSkillPaths.length, ...retained);
  return `Disabled ${normalized} for this session.`;
}

/** Renders `/skills active`, which adds session paths to the persisted scopes the shared command reports. */
function formatActiveSkillLines(lines: string[], additionalSkillPaths: string[] | undefined): string[] {
  if (!additionalSkillPaths?.length) return lines;
  return ["Active skills:", ...lines.slice(1), ...additionalSkillPaths.map((source) => `  session: ${source}`)];
}

/**
 * Runs the interactive `/skills` command.
 *
 * This holds the whole command body so `InteractiveMode` only needs to forward its context. Session scope
 * resolves entries here rather than through resource-loader methods, so the loader keeps no skill-specific
 * API of its own.
 */
export async function handleSkillsInteractive(
  env: SkillEnvironment,
  text: string,
  context: InteractiveSkillsContext,
): Promise<void> {
  const args = text.slice("/skills".length).trim().split(/\s+/).filter(Boolean);
  if (args.length === 1 && args[0] === "reload") {
    await context.reload();
    return;
  }

  const { cwd, agentDir, settingsManager } = context;
  const result = await runSkillsCommand(env, args, { cwd, agentDir, settingsManager, allowSession: true });
  if (result.exitCode !== 0) {
    context.showWarning(result.lines.join("\n"));
    return;
  }

  let lines = result.lines;
  if (result.session) {
    const line = await applySessionSkillChange(env, result.session, context);
    if (line === undefined) return;
    lines = [line];
  }

  if (args[0] === "active") {
    lines = formatActiveSkillLines(lines, context.additionalSkillPaths);
  }

  if (args[0] === "add" || args[0] === "remove") {
    if (context.isBusy()) {
      lines = [...lines, "Change will apply after `/skills reload` when the current operation finishes."];
    } else {
      await context.reload();
    }
  }

  if (lines.length > 0) context.showOutput(lines.join("\n"));
}
