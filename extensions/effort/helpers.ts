export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ApplyMode = "default" | "session";

export type ModelThinkingCapabilities = {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const VERIFIED_THINKING_LEVELS_VERSION = { major: 0, minor: 82, patch: 0 } as const;

export function supportsVerifiedThinkingLevels(piVersion: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(piVersion);
  if (!match) return false;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major !== VERIFIED_THINKING_LEVELS_VERSION.major) return major > VERIFIED_THINKING_LEVELS_VERSION.major;
  if (minor !== VERIFIED_THINKING_LEVELS_VERSION.minor) return minor > VERIFIED_THINKING_LEVELS_VERSION.minor;
  return patch >= VERIFIED_THINKING_LEVELS_VERSION.patch;
}

/**
 * Return the levels Pi can safely offer for the current model.
 *
 * Pi versions before 0.82.0 did not have provider-verified effort metadata in
 * their generated catalogs, so keep the historical picker unchanged there.
 * The filtering below mirrors pi-ai's getSupportedThinkingLevels semantics:
 * null explicitly disables a level, while missing xhigh/max metadata means the
 * model has not declared support for those levels.
 */
export function getThinkingLevelsForModel(
  piVersion: string,
  model: ModelThinkingCapabilities | undefined,
): ThinkingLevel[] {
  if (!supportsVerifiedThinkingLevels(piVersion) || !model) return THINKING_LEVELS;
  if (!model.reasoning) return ["off"];

  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export const DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "No extended reasoning",
  minimal: "Small reasoning budget",
  low: "Light reasoning",
  medium: "Balanced reasoning",
  high: "Deep reasoning",
  xhigh: "Very deep reasoning",
  max: "Maximum available reasoning",
};

export type ThinkingLevelArgument =
  { kind: "missing" } | { kind: "level"; level: ThinkingLevel } | { kind: "unknown"; value: string };

export function parseThinkingLevelArgument(argument: string): ThinkingLevelArgument {
  if (argument.length === 0) return { kind: "missing" };

  const level = THINKING_LEVELS.find((candidate) => candidate === argument);
  return level ? { kind: "level", level } : { kind: "unknown", value: argument };
}

export function cycleApplyMode(mode: ApplyMode): ApplyMode {
  return mode === "default" ? "session" : "default";
}

export function updateDefaultThinkingLevelJson(
  existingJson: string,
  level: ThinkingLevel,
): { json: string; hadParseError: boolean } {
  const trimmed = existingJson.trim();
  let settings: Record<string, unknown> = {};
  let hadParseError = false;

  if (trimmed.length > 0) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      } else {
        hadParseError = true;
      }
    } catch {
      hadParseError = true;
    }
  }

  settings.defaultThinkingLevel = level;
  return { json: `${JSON.stringify(settings, null, 2)}\n`, hadParseError };
}
