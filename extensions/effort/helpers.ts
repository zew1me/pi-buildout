export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ApplyMode = "default" | "session";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "No extended reasoning",
  minimal: "Small reasoning budget",
  low: "Light reasoning",
  medium: "Balanced reasoning",
  high: "Deep reasoning",
  xhigh: "Very deep reasoning",
  max: "Maximum available reasoning",
};

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
