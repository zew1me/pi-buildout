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

/** What {@link handleSkillsInteractive} needs from `InteractiveMode`. */
export type InteractiveSkillsContext = {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
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
 * Runs the interactive `/skills` command.
 *
 * This holds the whole command body so `InteractiveMode` only needs to forward its context. Session scope
 * resolves entries through this module rather than through resource-loader methods, so the loader keeps no
 * skill-specific API of its own.
 */
export async function handleSkillsInteractive(text: string, context: InteractiveSkillsContext): Promise<void> {
  const args = text.slice("/skills".length).trim().split(/\s+/).filter(Boolean);
  if (args.length === 1 && args[0] === "reload") {
    await context.reload();
    return;
  }

  const { cwd, agentDir, settingsManager, additionalSkillPaths, resolveResourcePath } = context;
  const result = await runSkillsCommand(args, { cwd, agentDir, settingsManager, allowSession: true });
  if (result.exitCode !== 0) {
    context.showWarning(result.lines.join("\n"));
    return;
  }

  const session = result.session;
  let lines = result.lines;

  if (session) {
    if (!additionalSkillPaths) {
      context.showError("Session skill activation is unavailable for this resource loader.");
      return;
    }
    const pathContext = { cwd, agentDir, settingsManager, resolveResourcePath };
    const { normalized, resolved } = await core.resolveSkillEntryPath(env, pathContext, session.source);

    if (session.action === "add") {
      if (!resolved) {
        context.showError(`Skill not found in the catalog: ${session.source}`);
        return;
      }
      if (!additionalSkillPaths.includes(resolved)) additionalSkillPaths.push(resolved);
    } else {
      const matches = (path: string): boolean =>
        path === session.source || path === normalized || (resolved !== undefined && path === resolved);
      if (!additionalSkillPaths.some(matches)) {
        context.showError(`Skill is not enabled for this session: ${session.source}`);
        return;
      }
      const retained = additionalSkillPaths.filter((path) => !matches(path));
      additionalSkillPaths.splice(0, additionalSkillPaths.length, ...retained);
    }

    const displayed = session.action === "add" ? resolved : session.source;
    lines = [`${session.action === "add" ? "Enabled" : "Disabled"} ${displayed} for this session.`];
  }

  if (args[0] === "active") {
    const entries = [
      ...(result.activeEntries ?? []).map((entry) => ({ scope: entry.scope as string, source: entry.source })),
      ...(additionalSkillPaths ?? []).map((source) => ({ scope: "session", source })),
    ];
    lines = entries.length
      ? ["Active skills:", ...entries.map((entry) => `  ${entry.scope}: ${entry.source}`)]
      : ["Skills: none"];
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
