import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadSkillsFromDir } from "./skills.js";

function readJson(path) {
    if (!existsSync(path))
        return {};
    try {
        const value = JSON.parse(readFileSync(path, "utf-8"));
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }
    catch (error) {
        throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function writeJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tempPath, path);
}
function git(cwd, args) {
    try {
        return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
    catch {
        return undefined;
    }
}
export function normalizeGitRemoteUrl(rawUrl) {
    if (!rawUrl)
        return undefined;
    let url = rawUrl.trim().replace(/^git\+/, "");
    if (!url)
        return undefined;
    const scpLike = url.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
    if (scpLike && !url.includes("://")) {
        const repoPath = scpLike[2].replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
        return repoPath ? `${scpLike[1].toLowerCase()}:${repoPath}` : undefined;
    }
    try {
        const parsed = new URL(url);
        const repoPath = parsed.pathname.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
        return parsed.hostname && repoPath ? `${parsed.hostname.toLowerCase()}:${repoPath}` : undefined;
    }
    catch {
        return undefined;
    }
}
export function resolveRepoKey(cwd) {
    for (const remote of ["upstream", "origin"]) {
        const key = normalizeGitRemoteUrl(git(cwd, ["remote", "get-url", remote]));
        if (key)
            return key;
    }
    const firstRemote = git(cwd, ["remote"])?.split(/\r?\n/).map((name) => name.trim()).find(Boolean);
    const firstKey = firstRemote && normalizeGitRemoteUrl(git(cwd, ["remote", "get-url", firstRemote]));
    if (firstKey)
        return firstKey;
    const root = git(cwd, ["rev-parse", "--show-toplevel"]);
    if (!root)
        return undefined;
    const rel = relative(homedir(), root).split(sep).join("/");
    return rel && !rel.startsWith("..") && rel !== "." ? `local:~/${rel}` : `local:${root}`;
}
function sourceOf(entry) {
    if (typeof entry === "string")
        return entry;
    return entry && typeof entry === "object" ? entry.source ?? entry.path ?? entry.name : undefined;
}
function enabledEntries(value) {
    return Array.isArray(value?.enabled) ? value.enabled : [];
}
function scopeFromArgs(args) {
    const scopes = args.filter((arg) => arg === "--global" || arg === "--repo" || arg === "--session");
    if (scopes.length !== 1 || new Set(scopes).size !== 1)
        throw new Error("Specify exactly one scope: --global, --repo, or --session.");
    return scopes[0].slice(2);
}
function configLocation(scope, cwd, agentDir) {
    if (scope === "global")
        return { path: join(agentDir, "skills.json") };
    if (scope === "repo") {
        const key = resolveRepoKey(cwd);
        if (!key)
            throw new Error("Repository scope requires a git repository.");
        return { path: join(agentDir, "repo-skills.json"), key };
    }
    return {};
}
function updatePersistedSkill(action, source, scope, options) {
    const location = configLocation(scope, options.cwd, options.agentDir);
    const config = readJson(location.path);
    const target = location.key ? (config[location.key] && typeof config[location.key] === "object" ? config[location.key] : {}) : config;
    const enabled = enabledEntries(target);
    const next = action === "add"
        ? (enabled.some((entry) => sourceOf(entry) === source) ? enabled : [...enabled, source])
        : enabled.filter((entry) => sourceOf(entry) !== source);
    target.enabled = next;
    if (location.key)
        config[location.key] = target;
    writeJson(location.path, config);
}
export function getActiveSkillEntries({ cwd, agentDir }) {
    const entries = [];
    for (const source of enabledEntries(readJson(join(agentDir, "skills.json")))) {
        const value = sourceOf(source);
        if (value)
            entries.push({ scope: "global", source: value });
    }
    const key = resolveRepoKey(cwd);
    if (key) {
        const config = readJson(join(agentDir, "repo-skills.json"));
        for (const source of enabledEntries(config[key])) {
            const value = sourceOf(source);
            if (value)
                entries.push({ scope: "repo", source: value });
        }
    }
    return entries;
}
export function getProjectAgentSkillDirs(cwd) {
    const dirs = [];
    const repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]);
    const stopAt = repoRoot ? resolve(repoRoot) : undefined;
    let current = resolve(cwd);
    while (true) {
        dirs.push(join(current, ".agents", "skills"));
        if (current === stopAt)
            break;
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return dirs;
}
export function getSkillCatalog({ cwd, agentDir }) {
    const dirs = [join(agentDir, "skills"), join(homedir(), ".agents", "skills"), join(cwd, ".pi", "skills"), ...getProjectAgentSkillDirs(cwd)];
    const found = new Map();
    for (const dir of dirs) {
        for (const skill of loadSkillsFromDir({ dir, source: "path" }).skills) {
            if (!found.has(skill.name))
                found.set(skill.name, skill);
        }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function usage() {
    return [
        "Usage: pi skills <active|list|search|add|remove>",
        "  pi skills active",
        "  pi skills list",
        "  pi skills search <query>",
        "  pi skills add <skill-or-path> --global|--repo",
        "  pi skills remove <skill-or-path> --global|--repo",
    ];
}
export function runSkillsCommand(args, options) {
    try {
        const [command, ...rest] = args;
        if (command === "active") {
            const entries = getActiveSkillEntries(options);
            return { exitCode: 0, lines: entries.length ? ["Active skills:", ...entries.map((entry) => `  ${entry.scope}: ${entry.source}`)] : ["Skills: none"] };
        }
        if (command === "list" || command === "search") {
            const query = command === "search" ? rest.join(" ").trim().toLowerCase() : "";
            if (command === "search" && !query)
                throw new Error("Usage: pi skills search <query>");
            const skills = getSkillCatalog(options).filter((skill) => !query || `${skill.name} ${skill.description}`.toLowerCase().includes(query));
            return { exitCode: 0, lines: skills.length ? skills.map((skill) => `${skill.name}\t${skill.description}`) : [query ? "No matching skills." : "No catalog skills found."] };
        }
        if (command === "add" || command === "remove") {
            const source = rest.find((arg) => !arg.startsWith("--"));
            const scope = scopeFromArgs(rest);
            if (!source || rest.some((arg) => ![source, `--${scope}`].includes(arg)))
                throw new Error(`Usage: pi skills ${command} <skill-or-path> --global|--repo${options.allowSession ? "|--session" : ""}`);
            if (scope === "session") {
                if (!options.allowSession)
                    throw new Error("Session scope is available only from interactive /skills commands.");
                return { exitCode: 0, lines: [], session: { action: command, source } };
            }
            updatePersistedSkill(command, source, scope, options);
            return { exitCode: 0, lines: [`${command === "add" ? "Enabled" : "Disabled"} ${source} for ${scope} scope.`] };
        }
        return { exitCode: 1, lines: usage() };
    }
    catch (error) {
        return { exitCode: 1, lines: [error instanceof Error ? error.message : String(error)] };
    }
}
