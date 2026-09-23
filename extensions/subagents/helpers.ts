export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ClassifierDecision = {
  model: string;
  effort: ThinkingLevel;
  rationale?: string;
};

export type ParsedModelRequest = {
  reference: string;
  effort?: ThinkingLevel;
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

export type ScopedModelLike = {
  model: ModelLike;
  thinkingLevel?: ThinkingLevel;
};

export type ChildArgsOptions = {
  sessionDir: string;
  name: string;
  model: ModelLike;
  effort: ThinkingLevel;
  modelScope?: string;
  extensionPaths: readonly string[];
  approve: boolean;
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

export function parseModelRequest(request: string): ParsedModelRequest {
  const trimmed = request.trim();
  const separator = trimmed.lastIndexOf(":");
  if (separator <= 0) return { reference: trimmed };
  const suffix = trimmed.slice(separator + 1);
  if (!THINKING_LEVELS.includes(suffix as ThinkingLevel)) return { reference: trimmed };
  return { reference: trimmed.slice(0, separator), effort: suffix as ThinkingLevel };
}

function modelRef(model: ModelLike): string {
  return `${model.provider}/${model.id}`;
}

function modelsMatch(left: ModelLike | undefined, right: ModelLike | undefined): boolean {
  if (!left || !right) return false;
  return left.provider === right.provider && left.id === right.id;
}

export function routingCandidates<T extends ModelLike>(
  scopedModels: readonly (ScopedModelLike & { model: T })[],
  availableModels: readonly T[],
): { candidates: T[]; scoped: boolean } {
  if (scopedModels.length > 0) {
    return { candidates: scopedModels.map((entry) => entry.model), scoped: true };
  }
  return { candidates: [...availableModels], scoped: false };
}

export function scopedThinkingLevel(
  model: ModelLike,
  scopedModels: readonly ScopedModelLike[],
): ThinkingLevel | undefined {
  return scopedModels.find((entry) => modelsMatch(entry.model, model))?.thinkingLevel;
}

export function scopeFallbackModel<T extends ModelLike>(
  parentModel: T | undefined,
  scopedModels: readonly (ScopedModelLike & { model: T })[],
): { model: T; substitutedParent: boolean } | undefined {
  if (scopedModels.length === 0) {
    return parentModel ? { model: parentModel, substitutedParent: false } : undefined;
  }
  const scopedParent = scopedModels.find((entry) => modelsMatch(entry.model, parentModel));
  if (scopedParent) return { model: scopedParent.model, substitutedParent: false };
  const first = scopedModels[0];
  return first ? { model: first.model, substitutedParent: Boolean(parentModel) } : undefined;
}

export function findRequestedModel(
  request: string,
  models: ModelLike[],
  preferredProvider?: string,
): { model?: ModelLike; error?: string } {
  const { reference } = parseModelRequest(request);
  if (!reference) return { error: "Model request is empty." };
  const providerSeparator = reference.indexOf("/");
  if (providerSeparator > 0) {
    const provider = reference.slice(0, providerSeparator);
    const id = reference.slice(providerSeparator + 1);
    const model = models.find((candidate) => candidate.provider === provider && candidate.id === id);
    return model ? { model } : { error: `Model '${reference}' was not found.` };
  }
  const exact = models.filter((candidate) => candidate.id === reference);
  const onlyExact = exact[0];
  if (exact.length === 1 && onlyExact) return { model: onlyExact };
  const preferred = exact.find((candidate) => candidate.provider === preferredProvider);
  if (preferred) return { model: preferred };
  if (exact.length > 1) {
    return {
      error: `Model '${reference}' is ambiguous; use a provider-qualified model: ${exact.map(modelRef).join(", ")}.`,
    };
  }
  return { error: `Model '${reference}' was not found.` };
}

export function resolveCandidateModel(
  request: string,
  models: ModelLike[],
  preferredProvider: string | undefined,
  scopeConstrained: boolean,
): { model?: ModelLike; error?: string } {
  const result = findRequestedModel(request, models, preferredProvider);
  if (result.model || !scopeConstrained) return result;
  const scope = models.length > 0 ? models.map(modelRef).join(", ") : "(none)";
  return {
    error: `Model '${request}' is outside this session's model scope. Scoped models: ${scope}.`,
  };
}

export function serializeModelScope(
  scopedModels: readonly ScopedModelLike[],
  selectedModel: ModelLike,
): string | undefined {
  if (scopedModels.length === 0) return undefined;
  const selectedRef = modelRef(selectedModel);
  if (selectedRef.includes(",")) {
    throw new Error(`Selected model '${selectedRef}' cannot be propagated through Pi's comma-delimited --models flag.`);
  }

  const patterns: string[] = [];
  const included = new Set<string>();
  for (const entry of scopedModels) {
    const reference = modelRef(entry.model);
    if (reference.includes(",") || included.has(reference)) continue;
    included.add(reference);
    patterns.push(entry.thinkingLevel ? `${reference}:${entry.thinkingLevel}` : reference);
  }
  if (!included.has(selectedRef)) patterns.push(selectedRef);
  return patterns.join(",");
}

export function resolveRoutedEffort(
  model: ModelLike,
  scopedModels: readonly ScopedModelLike[],
  parentEffort: ThinkingLevel,
  classifierEffort?: ThinkingLevel,
  explicitEffort?: ThinkingLevel,
): ThinkingLevel {
  const requested = explicitEffort ?? scopedThinkingLevel(model, scopedModels) ?? classifierEffort ?? parentEffort;
  return clampThinkingLevel(requested, model);
}

/**
 * Identifier fragment for the escalation-class frontier family (GPT-6 Astra).
 *
 * Matched against the bare model id across every provider, because the shipped
 * catalog exposes Astra through openai, openrouter, azure-openai-responses,
 * github-copilot, openai-codex, opencode, and vercel-ai-gateway. Keying the gate
 * on one provider-qualified id would let an in-scope alias route unapproved.
 */
const ESCALATION_ID_PATTERN = /(?:^|[^a-z0-9])astra(?:[^a-z0-9]|$)/i;

/** Whether a model is frontier/escalation class and therefore needs explicit user approval. */
export function isEscalationClassModel(model: ModelLike): boolean {
  return ESCALATION_ID_PATTERN.test(model.id);
}

/**
 * Relative routing strength of the families this extension routes over.
 *
 * Ordering is taken from Artificial Analysis' Intelligence Index for the GPT-5.6
 * family (Luna < Terra < Sol) with Astra above Sol. GPT-6 Sol edges GPT-5.6 Sol
 * on the Coding Agent Index at half the token rate; the Luna versions share a
 * rank because GPT-6 Luna regresses slightly on agentic coding even though it
 * is cheaper. `gpt-5.4-mini` is ranked
 * *below* Luna despite costing ~3.75x more per token: measured head-to-head it is
 * Pareto-dominated, scoring index 24 at $0.41 and 261s per task against Luna's 32
 * at $0.04 and 98s. Cost alone would therefore rank it backwards, which is why
 * this table is explicit rather than derived from `model.cost`.
 */
const FAMILY_RANKS: readonly { pattern: RegExp; rank: number }[] = [
  { pattern: ESCALATION_ID_PATTERN, rank: 90 },
  { pattern: /(?:^|[^a-z0-9])gpt-6-sol(?:[^a-z0-9]|$)/i, rank: 61 },
  { pattern: /(?:^|[^a-z0-9])sol(?:[^a-z0-9]|$)/i, rank: 60 },
  { pattern: /(?:^|[^a-z0-9])terra(?:[^a-z0-9]|$)/i, rank: 50 },
  { pattern: /(?:^|[^a-z0-9])luna(?:[^a-z0-9]|$)/i, rank: 40 },
  { pattern: /gpt-5\.4-mini/i, rank: 30 },
];

/**
 * Rank a model for ceiling selection. Known families use the measured ordering
 * above; anything else falls back to output price as a coarse capability proxy,
 * bounded so an expensive unknown model cannot outrank the frontier tier.
 */
export function modelStrengthRank(model: ModelLike): number {
  const known = FAMILY_RANKS.find((entry) => entry.pattern.test(model.id));
  if (known) return known.rank;
  const output = model.cost?.output;
  return Number.isFinite(output) ? Math.min(45, Number(output)) : 0;
}

/**
 * Pick a cheap model to run the routing classification itself.
 *
 * Classification is a short, structured judgment call, so paying the active
 * model's rate for it is waste when the session is scoped to something cheaper:
 * a scope whose active model is Sol at max effort should still classify on
 * Luna at low effort.
 *
 * Selection is by output price rather than by `modelStrengthRank`, because the
 * cheapest *rank* would pick `gpt-5.4-mini`, which is both pricier and weaker
 * than Luna. Escalation-class models are never used for classification. The
 * caller falls back to the active model when this returns nothing or when the
 * chosen model has no configured auth -- letting the active model classify is a
 * perfectly acceptable outcome, just not the preferred one.
 */
export function classifierModel<T extends ModelLike>(
  candidates: readonly T[],
): { model: T; effort: ThinkingLevel } | undefined {
  let best: T | undefined;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (isEscalationClassModel(candidate)) continue;
    const output = candidate.cost?.output;
    const cost = Number.isFinite(output) ? Number(output) : Number.POSITIVE_INFINITY;
    if (!best || cost < bestCost || (cost === bestCost && modelStrengthRank(candidate) > modelStrengthRank(best))) {
      best = candidate;
      bestCost = cost;
    }
  }
  return best ? { model: best, effort: clampThinkingLevel("low", best) } : undefined;
}

/**
 * The strongest non-escalation candidate and the highest effort it actually supports.
 *
 * This is both the escalation trigger's reference point and its decline/timeout
 * fallback, so the two can never disagree. For GPT-5.6 Sol this resolves to
 * `xhigh` because the endpoint rejects `max`; GPT-6 Sol supports `max` when
 * its catalog metadata advertises it and wins over GPT-5.6 Sol in a mixed scope.
 */
export function routingCeiling<T extends ModelLike>(
  candidates: readonly T[],
): { model: T; effort: ThinkingLevel } | undefined {
  let best: T | undefined;
  for (const candidate of candidates) {
    if (isEscalationClassModel(candidate)) continue;
    if (
      !best ||
      modelStrengthRank(candidate) > modelStrengthRank(best) ||
      (modelStrengthRank(candidate) === modelStrengthRank(best) &&
        (candidate.cost?.output ?? Infinity) < (best.cost?.output ?? Infinity))
    )
      best = candidate;
  }
  return best ? { model: best, effort: clampThinkingLevel("max", best) } : undefined;
}

/**
 * Environment variable that turns the opinionated routing layer off.
 *
 * The cost ladder, the model rankings, and the frontier approval gate encode
 * one person's judgment about which model suits which task. That opinion should
 * not be mandatory, so setting this to `off`, `0`, `false`, `no`, or `disabled`
 * reverts routing to plain capability-and-cost classification with no tier
 * nudges and no escalation prompt. The session model scope is a separate,
 * independent boundary and stays enforced either way.
 */
export const ROUTING_HINTS_ENV = "PI_SUBAGENT_ROUTING_HINTS";

const DISABLED_VALUES = new Set(["off", "0", "false", "no", "disabled"]);

/** Whether the opinionated routing ladder and escalation gate are active. */
export function routingHintsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[ROUTING_HINTS_ENV]?.trim().toLowerCase();
  if (!value) return true;
  return !DISABLED_VALUES.has(value);
}

/**
 * Build the routing classifier prompt.
 *
 * Extracted so the routing evaluation suite scores the exact instructions the
 * extension ships rather than a drifting copy of them.
 */
export function buildClassifierPrompt(options: {
  task: string;
  contextSummary: string;
  catalog: string;
  fixedChoice?: string;
  /** Include the opinionated cost ladder. Disabled routing sends no tier nudges. */
  includeLadder?: boolean;
}): string {
  const ladder = options.includeLadder === false ? "" : `${ROUTING_LADDER_GUIDANCE}\n\n`;
  return `Classify the difficulty and complexity of a delegated coding-agent task, then choose the best session-eligible model and reasoning effort from the exact catalog below. Return a model identifier from the catalog verbatim; do not invent or modify identifiers. Scope effort pins override your effort choice. Balance capability, reliability, context needs, latency, and cost. Hard architecture, debugging, security, or broad implementation work generally deserves a stronger model and higher effort; simple lookups, classifications, and mechanical edits do not.

${ladder}${options.fixedChoice ? `The user fixed ${options.fixedChoice}; preserve those values and classify only what is missing. ` : ""}Return one JSON object only: {"model":"provider/id","effort":"off|minimal|low|medium|high|xhigh|max","rationale":"one short sentence"}.

Task:
${options.task}

Task-targeted context the child will receive:
${options.contextSummary}

Session-eligible models:
${options.catalog}`;
}

export type EscalationGateDecision =
  { action: "allow"; reason?: string } | { action: "prompt" } | { action: "decline"; reason: string };

/**
 * Decide how an escalation-class selection must be handled, independently of any UI.
 *
 * Kept pure so the trigger's edge cases stay verifiable: a nested child has no
 * human on its RPC channel and must not burn the approval timeout, a
 * non-interactive session cannot answer at all, and a scope with no
 * non-escalation model is itself the authorization because there is nothing to
 * fall back to.
 */
export function escalationGate(options: {
  escalation: boolean;
  hasCeiling: boolean;
  depth: number;
  hasUI: boolean;
}): EscalationGateDecision {
  if (!options.escalation) return { action: "allow" };
  if (!options.hasCeiling) return { action: "allow", reason: "no non-escalation model is in scope" };
  if (options.depth > 0) return { action: "decline", reason: "is not available to a nested subagent" };
  if (!options.hasUI) return { action: "decline", reason: "needs approval and this session has no interactive UI" };
  return { action: "prompt" };
}

/** Cost-efficiency guidance appended to the routing classifier prompt. */
export const ROUTING_LADDER_GUIDANCE = `Choose the cheapest model and effort that clears the task's required intelligence; do not buy capability the task does not need. Treat model and effort as one combined choice rather than choosing a family first.
- Trivial, mechanical, classification, or lookup work: Luna at low or medium effort.
- Ordinary implementation, focused debugging, or review: Luna at high effort.
- Work that needs more reasoning but still fits the cheapest family: Luna at xhigh effort.
- Never choose Terra at low or medium effort; prefer Luna high.
- Never choose Terra at high effort; prefer Luna xhigh.
- Never choose Terra at xhigh effort; prefer Sol medium.
- Terra is eligible only at max effort and only for a task-specific measured strength. If max is absent from Terra's catalog entry, do not choose Terra.
- Prefer Luna xhigh over Sol low. When Luna xhigh is insufficient, move to Sol medium, then Sol high or xhigh as needed.
- In a mixed eligible scope, prefer GPT-6 Luna ($0.10 input/$0.50 output per million tokens) to GPT-5.6 Luna ($0.20/$1.20) for cheap work, and GPT-6 Sol ($2/$10) to GPT-5.6 Sol ($4/$20) for demanding agentic coding. These are comparative hints, not licenses to pick an out-of-scope model. GPT-6 Luna's Coding Agent Index is slightly lower (41 vs 43 at max), so GPT-5.6 Luna remains defensible when that measured difference matters; the versions are not universally capability-equivalent.
- Prefer Luna over gpt-5.4-mini whenever both are eligible: measured head-to-head, gpt-5.4-mini is dominated on intelligence, cost, and latency. Route to gpt-5.4-mini only when no Luna model is eligible.

The frontier escalation tier (GPT-6 Astra) requires separate user approval. Astra still costs $10 input/$50 output per million tokens, not less than before; it is 5x GPT-6 Sol's token rate. Low or medium effort does not bypass approval or make Astra automatically cost-effective. Request escalation only when an eligible Sol configuration is materially insufficient or when factual reliability / hallucination risk specifically justifies Astra for this task and user approval. Do not request escalation merely because the task is broad or expensive.

Scope and difficulty are separate. "Focused", "read-only", an existing regression test, or a narrow expected diff reduces work volume but does not by itself make the reasoning ordinary. Use Sol medium when the task's core deliverable requires resolving ambiguous, high-consequence semantics: cross-layer failure behavior; retry and idempotency boundaries; security exploitability or authorization; externally shipped contracts; serialization or omitted-versus-default behavior; or production changes where a locally plausible answer can silently lose or corrupt data. Existing tests reduce implementation uncertainty, but they do not remove semantic difficulty.

Apply that rule to the task's required judgment, not to incidental nouns. A bounded checklist or review that merely enumerates known OAuth, security, pagination, or integration concerns remains Luna high or xhigh. A review that must decide an ambiguous failure boundary or produce concrete exploitable security findings is Sol medium. Ordinary contract-preserving implementation with a clear local solution remains Luna high or xhigh; resolving subtle omitted-versus-default or compatibility semantics is Sol medium.

Artificial Analysis' general Intelligence Index is a comparative benchmark score where higher is better. It is not a percentage, probability, or score out of 100, and differences must not be assumed linear. The following approximate score / benchmark-cost-per-task observations describe GPT-5.6, not GPT-6:
- Luna: low 33 / $0.04; medium 38 / $0.05; high 46 / $0.09; xhigh 49 / $0.13.
- Terra: low 40 / $0.10; medium 46 / $0.13; high 49 / $0.24; xhigh 52 / $0.34; max 55 / $0.57.
- Sol: low 49 / $0.20; medium 54 / $0.32; high 56 / $0.45; xhigh 58 / $0.68; max 59 / $1.03.
These benchmark costs are not the live token prices in the catalog. They support the efficient-frontier preferences above; they are not hard thresholds. Dimension-specific benchmark charts may justify Terra max for a particular task only when Terra max is eligible and the relevant alternatives were actually evaluated on that dimension. A missing model or effort means "not evaluated", not "worse".

On the separate Coding Agent Index, Astra max is about 62 at $7.08 per benchmark task; GPT-6 Sol max scores about 57 at $2.99 per task. This makes Astra roughly 2.4x the benchmark task cost, not a modest premium over today's Sol. These are comparative scores, not percentages or a linear scale. Low/medium Astra may be worth asking about when its specific reliability/capability is needed, but do not infer its task cost from max-effort data or silently launch it.`;

/**
 * Well-known global key another extension assigns to take over subagent routing.
 *
 * Pi 0.85.1 exposes no first-party inter-extension channel (`ExtensionAPI` offers
 * only event subscription plus register* surfaces), so a routing plugin registers
 * by assignment during its own activation:
 *
 *   globalThis[Symbol.for("pi.subagents.router")] = { name, route };
 *
 * A router only *proposes*: its decision is resolved against the session scope
 * through the same strict path as classifier output, and an out-of-scope or
 * unknown identifier falls through to the built-in ladder. Registering a router
 * therefore cannot widen the session's model scope.
 */
export const SUBAGENT_ROUTER_KEY = Symbol.for("pi.subagents.router");

export type SubagentRoutingRequest = {
  task: string;
  context: string;
  candidates: readonly ModelLike[];
  scopeConstrained: boolean;
  parentModel?: ModelLike;
  parentEffort: ThinkingLevel;
  requestedModel?: string;
  requestedEffort?: ThinkingLevel;
};

/**
 * Apply model precedence to a routing plugin's proposal.
 *
 * An explicitly requested model always wins over a router's choice, matching
 * both the classifier path and the `subagent` tool schema's promise to preserve
 * a model the user asked for. A router may still choose the effort for that
 * model. Without this, registering a plugin would silently override explicit
 * requests, because `routeSelection` only returns early for an explicit model
 * when an effort or a scoped pin accompanies it.
 */
export function routedModelChoice<T extends ModelLike>(requestedModel: T | undefined, proposedModel: T): T {
  return requestedModel ?? proposedModel;
}

/** A router may pin only the model and leave effort to the normal precedence chain. */
export type RouterDecision = {
  model: string;
  effort?: ThinkingLevel;
  rationale?: string;
};

export type SubagentRouter = {
  name?: string;
  route: (request: SubagentRoutingRequest) => Promise<RouterDecision | undefined> | RouterDecision | undefined;
};

/** Read a registered routing plugin, ignoring anything that does not match the contract. */
export function readRegisteredRouter(scope: object = globalThis): SubagentRouter | undefined {
  const value = (scope as Record<symbol, unknown>)[SUBAGENT_ROUTER_KEY];
  if (!value || typeof value !== "object") return undefined;
  const { route, name } = value as { route?: unknown; name?: unknown };
  if (typeof route !== "function") return undefined;
  return {
    ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
    route: route as SubagentRouter["route"],
  };
}

/** Validate a routing plugin's decision without trusting its shape. */
export function parseRouterDecision(value: unknown): RouterDecision | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { model, effort, rationale } = value as { model?: unknown; effort?: unknown; rationale?: unknown };
  if (typeof model !== "string" || !model.trim()) return undefined;
  if (effort !== undefined && (typeof effort !== "string" || !THINKING_LEVELS.includes(effort as ThinkingLevel))) {
    return undefined;
  }
  return {
    model: model.trim(),
    ...(effort ? { effort: effort as ThinkingLevel } : {}),
    ...(typeof rationale === "string" && rationale.trim() ? { rationale: rationale.trim() } : {}),
  };
}

export function buildChildArgs(options: ChildArgsOptions): string[] {
  const args = [
    "--mode",
    "rpc",
    "--session-dir",
    options.sessionDir,
    "--name",
    options.name,
    "--model",
    modelRef(options.model),
  ];
  if (options.modelScope) args.push("--models", options.modelScope);
  args.push("--thinking", options.effort);
  for (const path of options.extensionPaths) args.push("--extension", path);
  args.push(options.approve ? "--approve" : "--no-approve");
  return args;
}

export function supportedThinkingLevels(model: ModelLike): ThinkingLevel[] {
  if (model.reasoning === false) return ["off"];
  // The GPT-5.6 endpoints currently reject `minimal` and `max` even though
  // pi's generated metadata leaves minimal implicit and maps max. This is a
  // property of the model, not of the route to it: providers exposing the same
  // model string (openai, openai-codex, and gateways) are equivalent, so the
  // narrowing is keyed on the model id alone rather than one provider.
  if (/(?:^|\/)gpt-5\.6(?:[-.]|$)/i.test(model.id)) {
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

export function formatModelCatalog(models: ModelLike[], scopedModels: readonly ScopedModelLike[] = []): string {
  return models
    .map((model) => {
      const levels = supportedThinkingLevels(model).join("|");
      const pin = scopedThinkingLevel(model, scopedModels);
      const prices = model.cost
        ? `input=$${cost(model.cost.input)}/M output=$${cost(model.cost.output)}/M`
        : "pricing=unknown";
      const context = model.contextWindow === undefined ? "?" : String(model.contextWindow);
      return `- ${model.provider}/${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ""}; effort=${levels}${pin ? `; effort-pin=${pin}` : ""}; context=${context}; ${prices}`;
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

function unsafeTerminalCodePoint(codePoint: number): boolean {
  if (codePoint <= 0x1f) return codePoint !== 0x09 && codePoint !== 0x0a;
  if (codePoint >= 0x7f && codePoint <= 0x9f) return true;

  const directionalFormatting =
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069);
  if (directionalFormatting) return true;

  const privateUse = (codePoint >= 0xe000 && codePoint <= 0xf8ff) || (codePoint >= 0xf0000 && codePoint <= 0x10fffd);
  const invalidScalar = codePoint >= 0xd800 && codePoint <= 0xdfff;
  const nonCharacter =
    (codePoint >= 0xfdd0 && codePoint <= 0xfdef) || (codePoint & 0xffff) === 0xfffe || (codePoint & 0xffff) === 0xffff;
  return privateUse || invalidScalar || nonCharacter;
}

/** Escape untrusted child text for terminal display without changing the model-facing result. */
export function safeTerminalText(value: string): string {
  let safe = "";
  for (const character of value.replaceAll("\r\n", "\n")) {
    const codePoint = character.codePointAt(0) ?? 0;
    safe += unsafeTerminalCodePoint(codePoint)
      ? `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`
      : character;
  }
  return safe;
}
