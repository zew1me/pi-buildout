/**
 * Pi-facing entry point for opt-in skill management.
 *
 * This file is copied into `packages/coding-agent/src/core/` when the runtime patch is built. It is the only
 * place that names Pi's own modules and Node's built-ins; all logic lives in `skill-management-core.ts`,
 * which this module binds to the real implementations.
 *
 * Every export keeps the signature Pi's call sites use, so the integration patch against upstream files
 * stays a handful of lines.
 */

import { execFileSync } from "node:child_process";
import chalk from "chalk";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createProjectTrustContext } from "../cli/project-trust.ts";
import { CONFIG_DIR_NAME } from "../config.ts";
import { resolveProjectTrusted } from "./project-trust.ts";
import { ProjectTrustStore } from "./trust-manager.ts";
import { resolvePath } from "../utils/paths.ts";
import { DefaultPackageManager } from "./package-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { loadSkills, loadSkillsFromDir } from "./skills.ts";
import * as core from "./skill-management-core.ts";
import type {
  ActiveSkillEntriesOptions,
  ActiveSkillEntry,
  ActiveSkillPathsContext,
  CatalogSkill,
  InteractiveSkillsContext,
  SettingsManagerLike,
  SkillCommandOptions,
  SkillCommandResult,
  SkillDiagnostic,
  SkillEnvironment,
} from "./skill-management-core.ts";

export type {
  ActiveSkillEntriesOptions,
  ActiveSkillEntry,
  ActiveSkillPathsContext,
  CatalogSkill,
  InteractiveSkillsContext,
  SkillCommandOptions,
  SkillCommandResult,
  SkillDiagnostic,
} from "./skill-management-core.ts";

const env: SkillEnvironment = {
  fs: { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync },
  path: { dirname, isAbsolute, join, relative, resolve, sep },
  homedir,
  execFileSync,
  processId: () => process.pid,
  configDirName: CONFIG_DIR_NAME,
  resolvePath,
  loadSkillsFromDir,
  loadSkills,
  createSettingsManager: (cwd, agentDir) => SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
  // The core declares only the narrow `SettingsManagerLike` it calls, but every caller supplies a real
  // SettingsManager: either pi's own, or the one `createSettingsManager` builds just above.
  resolvePackageResources: async ({ cwd, agentDir, settingsManager }) =>
    new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: settingsManager as SettingsManager,
    }).resolve(),
};

/** Re-exported unchanged: a pure string predicate with no environment dependency. */
export const looksLikePath = core.looksLikePath;

/** Re-exported unchanged: reads a configured entry's source with no environment dependency. */
export const sourceOf = core.sourceOf;

export function getActiveSkillEntries(options: ActiveSkillEntriesOptions): ActiveSkillEntry[] {
  return core.getActiveSkillEntries(env, options);
}

export async function getSkillCatalog(options: {
  cwd: string;
  agentDir: string;
  settingsManager?: SettingsManagerLike;
}): Promise<CatalogSkill[]> {
  return core.getSkillCatalog(env, options);
}

export async function runSkillsCommand(args: string[], options: SkillCommandOptions): Promise<SkillCommandResult> {
  return core.runSkillsCommand(env, args, options);
}

/**
 * Resolves the explicitly active skills for a resource loader.
 *
 * `DefaultResourceLoader` calls this instead of carrying the resolution logic itself, which keeps the
 * upstream diff to a single call site.
 */
export async function resolveActiveSkillPaths(
  context: ActiveSkillPathsContext,
): Promise<{ paths: string[]; diagnostics: SkillDiagnostic[] }> {
  return core.resolveActiveSkillPaths(env, context);
}

/**
 * Runs the one-shot `pi skills ...` command and prints its result.
 *
 * Trust resolution lives here rather than in `main.ts` so the upstream entry point only needs to route the
 * subcommand. Catalog-reading subcommands may surface project-local skills, so they resolve project trust
 * first; mutations and `active` do not.
 */
export async function handleSkillsCli(options: {
  args: string[];
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
}): Promise<void> {
  const { args, cwd, agentDir, settingsManager } = options;
  const hasUI = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (args[0] !== undefined && ["list", "search", "add"].includes(args[0])) {
    settingsManager.setProjectTrusted(
      await resolveProjectTrusted({
        cwd,
        trustStore: new ProjectTrustStore(agentDir),
        defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
        projectTrustContext: createProjectTrustContext({
          cwd,
          mode: hasUI ? "interactive" : "print",
          settingsManager,
          hasUI,
        }),
      }),
    );
  }

  const result = await runSkillsCommand(args, { cwd, agentDir, settingsManager });
  const output = result.lines.join("\n");
  if (result.exitCode === 0) {
    if (output) console.log(output);
  } else {
    console.error(chalk.red(output));
    process.exitCode = result.exitCode;
  }
}

/** Runs the interactive `/skills` command. See `skill-management-core.ts` for the behaviour. */
export async function handleSkillsInteractive(text: string, context: InteractiveSkillsContext): Promise<void> {
  return core.handleSkillsInteractive(env, text, context);
}

// The runtime module keeps the full public surface the previous hand-written patch exposed, so repository
// tests and any other consumer can reach the pure helpers directly.
export const normalizeGitRemoteUrl = core.normalizeGitRemoteUrl;
export const scopeFromArgs = core.scopeFromArgs;
export const usage = core.usage;

export function resolveRepoKey(cwd: string): string | undefined {
  return core.resolveRepoKey(env, cwd);
}

export function getSkillCatalogDirs(options: { cwd: string; agentDir: string; projectTrusted?: boolean }): string[] {
  return core.getSkillCatalogDirs(env, options);
}

/**
 * Resolves one skill entry to a concrete file path, for session scope and for callers that need to check a
 * catalog name without loading every active skill.
 */
export async function resolveSkillEntryPath(
  context: ActiveSkillPathsContext,
  source: string,
): Promise<{ normalized: string; resolved: string | undefined }> {
  return core.resolveSkillEntryPath(env, context, source);
}
