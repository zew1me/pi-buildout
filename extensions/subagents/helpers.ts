export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ClassifierDecision = {
  model: string;
  effort: ThinkingLevel;
  rationale?: string;
};

export type ModelLike = {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

/** Keep both the beginning and the newest context when a utility prompt needs a hard bound. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars < 80) return text.slice(0, Math.max(0, maxChars));
  const marker = `\n\n[... ${String(text.length - maxChars)} context characters omitted ...]\n\n`;
  const remaining = Math.max(0, maxChars - marker.length);
  const head = Math.floor(remaining * 0.35);
  return text.slice(0, head) + marker + text.slice(text.length - (remaining - head));
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function firstJsonObject(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = fenced ?? text;
  const start = candidate.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index++) {
    const char = candidate.charAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return candidate.slice(start, index + 1);
  }
  return undefined;
}

export function parseClassifierDecision(text: string): ClassifierDecision | undefined {
  const object = firstJsonObject(text);
  if (!object) return undefined;
  try {
    const parsed = JSON.parse(object) as Record<string, unknown>;
    if (typeof parsed.model !== "string" || !parsed.model.trim()) return undefined;
    if (typeof parsed.effort !== "string" || !THINKING_LEVELS.includes(parsed.effort as ThinkingLevel))
      return undefined;
    return {
      model: parsed.model.trim(),
      effort: parsed.effort as ThinkingLevel,
      ...(typeof parsed.rationale === "string" && parsed.rationale.trim()
        ? { rationale: parsed.rationale.trim() }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function supportedThinkingLevels(model: ModelLike): ThinkingLevel[] {
  if (model.reasoning === false) return ["off"];
  // OpenAI's direct GPT-5.6 endpoint currently rejects `minimal` and `max`
  // even though pi 0.80.6's generated metadata leaves minimal implicit and
  // maps max. Keep routing from selecting values the live API rejects.
  if (model.provider.toLowerCase() === "openai" && /^gpt-5\.6(?:[-.]|$)/i.test(model.id)) {
    return ["off", "low", "medium", "high", "xhigh"];
  }
  const map = model.thinkingLevelMap;
  if (!map) return ["off", "minimal", "low", "medium", "high"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function clampThinkingLevel(requested: ThinkingLevel, model: ModelLike): ThinkingLevel {
  const supported = supportedThinkingLevels(model);
  if (supported.includes(requested)) return requested;
  const requestedIndex = THINKING_LEVELS.indexOf(requested);
  // Match Pi's clamp policy: preserve at least the requested capability by
  // searching upward first, then fall back downward only when necessary.
  for (let index = requestedIndex + 1; index < THINKING_LEVELS.length; index++) {
    const higher = THINKING_LEVELS[index];
    if (higher && supported.includes(higher)) return higher;
  }
  for (let index = requestedIndex - 1; index >= 0; index--) {
    const lower = THINKING_LEVELS[index];
    if (lower && supported.includes(lower)) return lower;
  }
  return "off";
}

function cost(value: number | undefined): string {
  return Number.isFinite(value) ? String(value) : "?";
}

export function formatModelCatalog(models: ModelLike[]): string {
  return models
    .map((model) => {
      const levels = supportedThinkingLevels(model).join("|");
      const prices = model.cost
        ? `input=$${cost(model.cost.input)}/M output=$${cost(model.cost.output)}/M`
        : "pricing=unknown";
      const context = model.contextWindow === undefined ? "?" : String(model.contextWindow);
      return `- ${model.provider}/${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ""}; effort=${levels}; context=${context}; ${prices}`;
    })
    .join("\n");
}

export function boundContextForModel(
  summary: string,
  task: string,
  model: ModelLike,
  absoluteMaxChars = 24_000,
): string {
  if (!summary.trim()) return "";
  const contextWindow = model.contextWindow ?? 128_000;
  // Use at most ~40% of the child window for inherited context, leaving room
  // for its system prompt, task, tools, and actual work. Three characters per
  // token is intentionally conservative for code-heavy context.
  const modelBound = Math.floor(contextWindow * 3 * 0.4) - task.length;
  const maxChars = Math.min(absoluteMaxChars, Math.max(0, modelBound));
  return maxChars < 256 ? "" : truncateMiddle(summary, maxChars);
}

export function excludeCurrentDelegationTurn<T extends { role?: string }>(messages: T[]): T[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return messages.slice(0, index);
  }
  return [...messages];
}

export function appendBoundedTail(current: string, addition: string, maxChars: number): string {
  const combined = current + addition;
  if (combined.length <= maxChars) return combined;
  return combined.slice(combined.length - maxChars);
}
