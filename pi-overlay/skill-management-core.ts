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

type FileSystemSeam = {
  existsSync: (path: string) => boolean;
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
export type SkillEnvironment = {
  fs: FileSystemSeam;
  path: PathSeam;
  homedir: () => string;
  /** Runs a subprocess and returns stdout, mirroring `child_process.execFileSync`. */
  execFileSync: (
    file: string,
    args: string[],
    options: { encoding: "utf-8"; stdio: ["ignore", "pipe", "ignore"]; timeout: number },
  ) => string;
  /** Process id, used only to make the atomic-write temp filename unique. */
  processId: () => number;
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

export type SkillScope = "global" | "repo" | "session";

export type ActiveSkillEntry = {
  scope: "global" | "repo";
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

function git(env: SkillEnvironment, cwd: string, args: string[]): string | undefined {
  try {
    return env
      .execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      })
      .trim();
  } catch {
    return undefined;
  }
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

export function resolveRepoKey(env: SkillEnvironment, cwd: string): string | undefined {
  for (const remote of ["upstream", "origin"]) {
    const key = normalizeGitRemoteUrl(git(env, cwd, ["remote", "get-url", remote]));
    if (key) return key;
  }

  const firstRemote = git(env, cwd, ["remote"])
    ?.split(/\r?\n/)
    .map((name) => name.trim())
    .find(Boolean);
  const firstKey = firstRemote && normalizeGitRemoteUrl(git(env, cwd, ["remote", "get-url", firstRemote]));
  if (firstKey) return firstKey;

  const root = git(env, cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return undefined;
  const rel = env.path.relative(env.homedir(), root).split(env.path.sep).join("/");
  return rel && !rel.startsWith("..") && rel !== "." ? `local:~/${rel}` : `local:${root}`;
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

export function scopeFromArgs(args: string[], allowSession = false): SkillScope {
  const allowed = allowSession ? ["--global", "--repo", "--session"] : ["--global", "--repo"];
  const scopes = args.filter((arg) => allowed.includes(arg));
  const scope = scopes[0];
  if (scopes.length !== 1 || scope === undefined) {
    throw new Error(
      `Specify exactly one scope: ${allowSession ? "--global, --repo, or --session" : "--global or --repo"}.`,
    );
  }
  return scope.slice(2) as SkillScope;
}

export function configLocation(
  env: SkillEnvironment,
  scope: SkillScope,
  cwd: string,
  agentDir: string,
): { path?: string; key?: string } {
  if (scope === "global") return { path: env.path.join(agentDir, "skills.json") };
  if (scope === "repo") {
    const key = resolveRepoKey(env, cwd);
    if (!key) throw new Error("Repository scope requires a git repository.");
    return { path: env.path.join(agentDir, "repo-skills.json"), key };
  }
  return {};
}

export function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.startsWith(".") || value.startsWith("~");
}

function normalizeSkillSource(
  env: SkillEnvironment,
  source: string | undefined,
  options: { cwd: string },
): string | undefined {
  if (!source) return undefined;
  return looksLikePath(source) ? env.resolvePath(source, options.cwd, { trim: true }) : source;
}

export function updatePersistedSkill(
  env: SkillEnvironment,
  action: "add" | "remove",
  source: string,
  scope: SkillScope,
  options: { cwd: string; agentDir: string },
): boolean {
  const location = configLocation(env, scope, options.cwd, options.agentDir);
  if (location.path === undefined) throw new Error(`Scope ${scope} has no persisted configuration.`);

  const config = readJson(env, location.path);
  const existing = location.key === undefined ? config : config[location.key];
  const target: JsonRecord = location.key === undefined ? config : isObjectRecord(existing) ? existing : {};

  const enabled = enabledEntries(target);
  const matched = enabled.some((entry) => normalizeSkillSource(env, sourceOf(entry), options) === source);
  if (action === "remove" && !matched) return false;

  target.enabled =
    action === "add"
      ? matched
        ? enabled
        : [...enabled, source]
      : enabled.filter((entry) => normalizeSkillSource(env, sourceOf(entry), options) !== source);

  if (location.key !== undefined) config[location.key] = target;
  writeJson(env, location.path, config);
  return true;
}

export function getActiveSkillEntries(
  env: SkillEnvironment,
  { cwd, agentDir, strict = false, onWarn }: ActiveSkillEntriesOptions,
): ActiveSkillEntry[] {
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

  for (const source of enabledEntries(safeRead(env.path.join(agentDir, "skills.json")))) {
    const value = sourceOf(source);
    if (value) entries.push({ scope: "global", source: value });
  }

  const key = resolveRepoKey(env, cwd);
  if (key) {
    const config = safeRead(env.path.join(agentDir, "repo-skills.json"));
    for (const source of enabledEntries(config[key])) {
      const value = sourceOf(source);
      if (value) entries.push({ scope: "repo", source: value });
    }
  }
  return entries;
}

function getProjectAgentSkillDirs(env: SkillEnvironment, cwd: string): string[] {
  const dirs: string[] = [];
  const repoRoot = git(env, cwd, ["rev-parse", "--show-toplevel"]);
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
  { cwd, agentDir, settingsManager }: { cwd: string; agentDir: string; settingsManager?: SettingsManagerLike },
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

  const resolved = await env.resolvePackageResources({ cwd, agentDir, settingsManager: manager });
  const addResolvedSkills = (resources: ResolvedSkillResource[]): void => {
    const paths = resources.filter((resource) => resource.enabled).map((resource) => resource.path);
    addSkills(env.loadSkills({ cwd, agentDir, skillPaths: paths, includeDefaults: false }).skills);
  };

  addResolvedSkills(resolved.skills.filter((resource) => resource.metadata.origin === "package"));
  addResolvedSkills(
    resolved.skills.filter(
      (resource) => resource.metadata.origin === "top-level" && resource.metadata.source === "local",
    ),
  );

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function resolveSkillSource(
  env: SkillEnvironment,
  source: string,
  options: { cwd: string; agentDir: string; settingsManager?: SettingsManagerLike },
): Promise<string | undefined> {
  const normalized = normalizeSkillSource(env, source, options);
  if (!normalized) return undefined;
  if (looksLikePath(source)) return env.fs.existsSync(normalized) ? normalized : undefined;
  return (await getSkillCatalog(env, options)).find((skill) => skill.name === normalized)?.filePath;
}

function commandName(allowSession = false): string {
  return allowSession ? "/skills" : "pi skills";
}

export function usage(allowSession = false): string[] {
  const command = commandName(allowSession);
  const scopes = `--global|--repo${allowSession ? "|--session" : ""}`;
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
  const entries = getActiveSkillEntries(env, { ...options, strict: true });
  return {
    exitCode: 0,
    lines: entries.length
      ? ["Active skills:", ...entries.map((entry) => `  ${entry.scope}: ${entry.source}`)]
      : ["Skills: none"],
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

async function runMutationCommand(
  env: SkillEnvironment,
  command: "add" | "remove",
  rest: string[],
  surface: string,
  options: SkillCommandOptions,
): Promise<SkillCommandResult> {
  const scopeList = `--global|--repo${options.allowSession ? "|--session" : ""}`;
  const source = rest.find((arg) => !arg.startsWith("--"));
  if (!source) throw new Error(`Usage: ${surface} ${command} <skill-or-path> ${scopeList}`);

  const scope = scopeFromArgs(rest, options.allowSession);
  if (rest.length !== 2 || rest.some((arg) => ![source, `--${scope}`].includes(arg))) {
    throw new Error(`Usage: ${surface} ${command} <skill-or-path> ${scopeList}`);
  }

  const target = normalizeSkillSource(env, source, options);
  if (!target) throw new Error(`Skill source is invalid: ${source}`);
  if (command === "add" && !(await resolveSkillSource(env, source, options))) {
    throw new Error(`Skill not found in the catalog or at an existing path: ${source}`);
  }

  if (scope === "session") return { exitCode: 0, lines: [], session: { action: command, source: target } };

  if (!updatePersistedSkill(env, command, target, scope, options)) {
    throw new Error(`Skill is not enabled for ${scope} scope: ${source}`);
  }
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
  resolveResourcePath: (path: string) => string;
};

/**
 * Resolves the skills that are explicitly active for this session into concrete paths.
 *
 * Entries are either paths, which must exist, or catalog names, which are looked up by name. The catalog is
 * built at most once per call: every caller resolves a whole entry list in one pass, so a longer-lived cache
 * would only need invalidating without ever being reused.
 */
export async function resolveActiveSkillPaths(
  env: SkillEnvironment,
  context: ActiveSkillPathsContext,
): Promise<{ paths: string[]; diagnostics: SkillDiagnostic[] }> {
  const { cwd, agentDir, settingsManager, resolveResourcePath } = context;
  const paths: string[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  const entries = getActiveSkillEntries(env, {
    cwd,
    agentDir,
    onWarn: (message) => diagnostics.push({ type: "warning", message }),
  });

  let catalogPathsByName: Map<string, string> | undefined;
  const findCatalogSkillPath = async (name: string): Promise<string | undefined> => {
    catalogPathsByName ??= new Map(
      (await getSkillCatalog(env, { cwd, agentDir, ...(settingsManager ? { settingsManager } : {}) })).map((skill) => [
        skill.name,
        skill.filePath,
      ]),
    );
    return catalogPathsByName.get(name);
  };

  for (const entry of entries) {
    const source = sourceOf(entry);
    if (!source) continue;

    const normalized = looksLikePath(source) ? resolveResourcePath(source) : source;
    const resolved = looksLikePath(source)
      ? env.fs.existsSync(normalized)
        ? normalized
        : undefined
      : await findCatalogSkillPath(normalized);

    if (resolved) {
      paths.push(resolved);
    } else {
      diagnostics.push({ type: "warning", message: "Active skill could not be resolved", path: source });
    }
  }

  return { paths, diagnostics };
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
  const { cwd, agentDir, settingsManager, resolveResourcePath } = context;

  if (looksLikePath(source)) {
    const normalized = resolveResourcePath(source);
    return { normalized, resolved: env.fs.existsSync(normalized) ? normalized : undefined };
  }

  const catalog = await getSkillCatalog(env, {
    cwd,
    agentDir,
    ...(settingsManager ? { settingsManager } : {}),
  });
  return { normalized: source, resolved: catalog.find((skill) => skill.name === source)?.filePath };
}
