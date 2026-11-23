import { complete, validateToolArguments } from "@earendil-works/pi-ai/compat";
import type { Api, Model, Tool } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CLASSIFIER_TOOL_NAME,
  classifyTaskPrimary,
  classifyTaskSecondary,
  isClassifierCancellationError,
} from "./classifier.ts";
import type {
  ClassificationResult,
  ClassifierAttemptObservation,
  ClassifierRequest,
  ClassifierTransport,
  PrimaryClassificationResult,
} from "./classifier.ts";
import { calculateEndpointEffectiveCost, compareEndpointEffectiveCost } from "./core/endpoint-cost.ts";
import type { EndpointEffectiveCostComparable } from "./core/endpoint-cost.ts";
import { TaskFeaturesSchema } from "./core/features.ts";
import { healthVerdict } from "./core/health.ts";
import type { ModelVendor } from "./core/profiles.ts";
import { providerWeightFor } from "./core/provider-weights.ts";
import type { RegistryModelSnapshot } from "./core/routing.ts";
import { canonicalModelId } from "./core/scope.ts";
import type { SessionSynopsis } from "./core/synopsis.ts";
import { requireToolCall } from "./core/tool-choice.ts";

const CLASSIFIER_TOOL: Tool = {
  name: CLASSIFIER_TOOL_NAME,
  description: "Return validated semantic task features. Never select a model or route.",
  parameters: TaskFeaturesSchema,
};

type ClassifierModel = {
  model: Pick<Model<Api>, "provider" | "id">;
  vendor: ModelVendor;
  endpointEffectiveCost?: number;
};

// Logical classifier tiers are resolved only against the operator's scoped registry snapshot.
// Luna remains preferred over Haiku regardless of endpoint cost; the shared endpoint comparator
// orders alternatives serving the same logical model. We do not guess an older Sonnet ID: an exact
// endpoint must canonicalize to one of these validated logical model IDs. GPT-5.6 Luna stays listed
// after GPT-6 Luna because many scoped registries (including every Amazon Bedrock region today) still
// serve only the 5.6 generation; dropping it silently pushed every primary onto Haiku.
// Microsoft's MAI-Code Flash is a Luna-class fast model reached through GitHub Copilot, so it is the
// next primary once every Luna endpoint has failed, ahead of Haiku. Gemini 3.5 Flash Lite is the
// last-resort primary. Every classifier call runs at low reasoning effort regardless of tier.
const PRIMARY_CLASSIFIER_TIERS = [
  "gpt-6-luna",
  "gpt-5.6-luna",
  "mai-code-1.1-flash",
  "claude-haiku-4-5",
  "gemini-3.5-flash-lite",
] as const;

// Microsoft tiers that may reconcile a non-Microsoft primary. Listed after the stronger established
// vendors' tiers, so they are consulted only when those are unreachable.
const MICROSOFT_SECONDARY_CLASSIFIER_TIERS: readonly string[] = ["mai-code-1.1-flash"];

// OpenAI tiers that may reconcile a non-OpenAI primary, in preference order. More than one tier is
// listed so a single rate-limited or unscoped OpenAI model cannot leave the safety latch unresolved.
const OPENAI_SECONDARY_CLASSIFIER_TIERS: readonly string[] = ["gpt-5.6-terra", "gpt-6-luna", "gpt-5.6-luna"];

// First-party Google Gemini tiers, newest Flash first. They give every primary a third independent
// vendor, so one vendor being rate limited cannot by itself leave the safety latch unresolved.
// Open-weight Gemma endpoints are deliberately absent: they are not Gemini, and the registry does not
// attribute them to the `google` vendor.
const GOOGLE_SECONDARY_CLASSIFIER_TIERS: readonly string[] = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-2.5-pro",
  "gemini-3.5-flash-lite",
];

// The key is the primary tier's canonical vendor; each logical secondary tier deliberately belongs
// to a different vendor for independent reconciliation. Endpoint providers do not determine this:
// an Amazon Bedrock endpoint serving Sonnet is still an Anthropic secondary, for example.
//
// Declared as a partial map rather than a total record over ModelVendor, so supporting a new vendor
// does not oblige anyone to invent a secondary tier for it. A primary whose vendor is absent falls
// back to DEFAULT_SECONDARY_CLASSIFIER_TIERS, which preserves the provider-diversity rule because
// resolveSecondary rejects any candidate sharing the primary's vendor.
const SECONDARY_CLASSIFIER_TIERS_BY_PRIMARY_VENDOR: Partial<Record<ModelVendor, readonly string[]>> = {
  openai: ["claude-sonnet-5", ...GOOGLE_SECONDARY_CLASSIFIER_TIERS, ...MICROSOFT_SECONDARY_CLASSIFIER_TIERS],
  anthropic: [
    ...OPENAI_SECONDARY_CLASSIFIER_TIERS,
    ...GOOGLE_SECONDARY_CLASSIFIER_TIERS,
    ...MICROSOFT_SECONDARY_CLASSIFIER_TIERS,
  ],
  google: [...OPENAI_SECONDARY_CLASSIFIER_TIERS, "claude-sonnet-5", ...MICROSOFT_SECONDARY_CLASSIFIER_TIERS],
  // A Microsoft primary uses DEFAULT_SECONDARY_CLASSIFIER_TIERS, which already filters out MAI.
};

// Used when the primary's vendor declares no secondary tier of its own. Both entries are validated
// logical model IDs drawn from the tiers above; vendor diversity is still enforced at selection time
// rather than assumed here, so whichever entry shares the primary's vendor is skipped.
const DEFAULT_SECONDARY_CLASSIFIER_TIERS: readonly string[] = [
  "claude-sonnet-5",
  ...OPENAI_SECONDARY_CLASSIFIER_TIERS,
  ...GOOGLE_SECONDARY_CLASSIFIER_TIERS,
  ...MICROSOFT_SECONDARY_CLASSIFIER_TIERS,
];

function secondaryClassifierTiers(primaryVendor: ModelVendor): readonly string[] {
  return SECONDARY_CLASSIFIER_TIERS_BY_PRIMARY_VENDOR[primaryVendor] ?? DEFAULT_SECONDARY_CLASSIFIER_TIERS;
}

// Any thrown failure (rate limiting, transient 5xx, missing credentials, an unhealthy endpoint,
// etc.) falls through to the next endpoint candidate. Cancellation is the one exception: retrying
// a different endpoint would be wasted and user-surprising work rather than resilience.

function candidateLabel(candidate: ClassifierModel): string {
  return `${candidate.model.provider}/${candidate.model.id}`;
}

function comparable(candidate: ClassifierModel): EndpointEffectiveCostComparable {
  return {
    provider: candidate.model.provider,
    modelId: candidate.model.id,
    ...(candidate.endpointEffectiveCost === undefined
      ? {}
      : { endpointEffectiveCost: candidate.endpointEffectiveCost }),
  };
}

function resolveClassifierTier(registry: readonly RegistryModelSnapshot[], logicalModelId: string): ClassifierModel[] {
  const candidates: ClassifierModel[] = [];
  for (const endpoint of registry) {
    if (!endpoint.available || canonicalModelId(endpoint.modelId) !== logicalModelId) continue;
    // Classification is enforced through a forced tool call, so an endpoint without tool support
    // cannot serve this tier at all. Routing excludes these as `tools_unsupported`; the classifier
    // must not admit one just because it is scoped in and healthy.
    if (!endpoint.toolCapable) continue;
    if (!healthVerdict(endpoint.health).usable) continue;
    let endpointEffectiveCost: number | undefined;
    try {
      endpointEffectiveCost = calculateEndpointEffectiveCost(
        endpoint,
        (endpoint.providerWeight ?? providerWeightFor(endpoint.provider)).weight,
      );
    } catch (error) {
      if (error instanceof RangeError) continue;
      throw error;
    }
    candidates.push({
      model: { provider: endpoint.provider, id: endpoint.modelId },
      vendor: endpoint.vendor,
      ...(endpointEffectiveCost === undefined ? {} : { endpointEffectiveCost }),
    });
  }
  return candidates.sort((left, right) => compareEndpointEffectiveCost(comparable(left), comparable(right)));
}

function resolveClassifierTiers(
  registry: readonly RegistryModelSnapshot[],
  logicalModelIds: readonly string[],
): ClassifierModel[] {
  return logicalModelIds.flatMap((logicalModelId) => resolveClassifierTier(registry, logicalModelId));
}

function selectSecondaryClassifierModels(
  registry: readonly RegistryModelSnapshot[],
  primaryVendor: ModelVendor | undefined,
): ClassifierModel[] {
  if (!primaryVendor) return [];
  return resolveClassifierTiers(registry, secondaryClassifierTiers(primaryVendor)).filter(
    // Independence is enforced here rather than assumed from the tier table, so a vendor that
    // declares no secondary tier of its own still cannot reconcile against itself.
    (candidate) => candidate.vendor !== primaryVendor,
  );
}

export function selectClassifierModels(registry: readonly RegistryModelSnapshot[]): {
  primary: ClassifierModel[];
  secondary: ClassifierModel[];
} {
  const primary = resolveClassifierTiers(registry, PRIMARY_CLASSIFIER_TIERS);
  // The vendor guess only decides which independent secondary tier to search; tier order (Luna
  // before Haiku) means this reflects whichever logical tier has any eligible scoped endpoint.
  return { primary, secondary: selectSecondaryClassifierModels(registry, primary[0]?.vendor) };
}

type CandidateCaller = (candidate: ClassifierModel, request: ClassifierRequest) => Promise<ClassifierTransportResult>;

type ClassifierTransportResult = Awaited<ReturnType<ClassifierTransport>>;

// Pure fallback iterator, deliberately decoupled from the network call so the failover behavior
// (try every candidate in order, stop on first success, only give up once the whole list is
// exhausted) is unit-testable without mocking the underlying provider SDKs.
export function transportFromCandidates(
  candidates: readonly ClassifierModel[],
  call: CandidateCaller,
): ClassifierTransport {
  return async (request) => {
    if (candidates.length === 0) {
      throw new Error(`No configured ${request.stage} classifier from the required vendor`);
    }
    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        return await call(candidate, request);
      } catch (error) {
        if (request.signal?.aborted || isClassifierCancellationError(error)) throw error;
        failures.push(`${candidateLabel(candidate)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`All ${request.stage} classifier candidates failed: ${failures.join(" | ")}`);
  };
}

async function callClassifierModel(
  ctx: ExtensionContext,
  candidate: ClassifierModel,
  request: Pick<ClassifierRequest, "systemPrompt" | "userPrompt" | "signal">,
  tool: Tool = CLASSIFIER_TOOL,
): Promise<ClassifierTransportResult> {
  const model = ctx.modelRegistry.find(candidate.model.provider, candidate.model.id);
  if (!model) throw new Error(`Classifier endpoint disappeared from registry: ${candidateLabel(candidate)}`);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  // `ok: true` is the registry's statement that the request can be authenticated. Providers such as
  // Amazon Bedrock authenticate through an ambient credential chain and legitimately resolve no API
  // key, so requiring one here rejected every Bedrock endpoint before any request was made. This
  // mirrors the agent session's own request path, which also applies a resolved base URL override.
  const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
  const started = performance.now();
  const response = await complete(
    requestModel,
    {
      systemPrompt: request.systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: request.userPrompt }],
          timestamp: Date.now(),
        },
      ],
      tools: [tool],
    },
    {
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
      ...(auth.headers ? { headers: auth.headers } : {}),
      ...(auth.env ? { env: auth.env } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      maxTokens: 4_096,
      maxRetries: 1,
      ...(model.api === "openai-codex-responses" ? { reasoningEffort: "low" } : { reasoning: "low" }),
      onPayload: (payload) => requireToolCall(payload, model.api, tool.name),
    },
  );
  if (response.stopReason === "aborted") {
    const error = new Error(response.errorMessage ?? "Classifier stopped with aborted");
    error.name = "AbortError";
    throw error;
  }
  if (response.stopReason === "error") {
    throw new Error(response.errorMessage ?? "Classifier stopped with error");
  }
  const toolCall = response.content.find((content) => content.type === "toolCall" && content.name === tool.name);
  if (toolCall?.type !== "toolCall") {
    throw new Error(`Classifier did not return the required ${tool.name} tool call`);
  }
  const validatedArguments: unknown = validateToolArguments(tool, toolCall);
  return {
    arguments: validatedArguments,
    provider: candidate.model.provider,
    modelId: candidate.model.id,
    vendor: candidate.vendor,
    latencyMs: Math.round(performance.now() - started),
    usage: {
      input: response.usage.input,
      output: response.usage.output,
      cacheRead: response.usage.cacheRead,
      cacheWrite: response.usage.cacheWrite,
      cost: response.usage.cost.total,
    },
  };
}

/** One schema-validated structured answer from the primary classifier tiers (manager discovery). */
export async function callStructuredWithPi(input: {
  ctx: ExtensionContext;
  registry: readonly RegistryModelSnapshot[];
  tool: Tool;
  systemPrompt: string;
  userPrompt: string;
  signal: AbortSignal;
}): Promise<unknown> {
  const failures: string[] = [];
  for (const candidate of selectClassifierModels(input.registry).primary) {
    try {
      return (await callClassifierModel(input.ctx, candidate, input, input.tool)).arguments;
    } catch (error) {
      if (input.signal.aborted || isClassifierCancellationError(error)) throw error;
      failures.push(`${candidateLabel(candidate)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No ${input.tool.name} candidate succeeded: ${failures.join(" | ") || "none configured"}`);
}

function transportFor(ctx: ExtensionContext, candidates: readonly ClassifierModel[]): ClassifierTransport {
  return transportFromCandidates(candidates, (candidate, request) => callClassifierModel(ctx, candidate, request));
}

export async function classifyTaskWithPi(input: {
  ctx: ExtensionContext;
  registry: readonly RegistryModelSnapshot[];
  prompt: string;
  synopsis: SessionSynopsis;
  signal?: AbortSignal;
  onAttempt?: (observation: ClassifierAttemptObservation) => void;
}): Promise<ClassificationResult> {
  const primary = await classifyTaskPrimaryWithPi(input);
  if (!primary.escalated) return primary;
  return classifyTaskSecondaryWithPi({ ...input, primary });
}

/**
 * Run only the first classifier stage against the scoped Pi model registry.
 *
 * The router uses this on the critical path for fresh-task routing so it can select a provisional
 * model quickly and launch secondary reconciliation only when the primary result escalates. It is a
 * separate function rather than a mode flag on `classifyTaskWithPi` because the return type exposes
 * primary-only metadata that callers must handle before a final reconciled `ClassificationResult`
 * exists.
 */
export async function classifyTaskPrimaryWithPi(input: {
  ctx: ExtensionContext;
  registry: readonly RegistryModelSnapshot[];
  prompt: string;
  synopsis: SessionSynopsis;
  signal?: AbortSignal;
  onAttempt?: (observation: ClassifierAttemptObservation) => void;
}): Promise<PrimaryClassificationResult> {
  const selected = selectClassifierModels(input.registry);
  const primaryVendor = selected.primary[0]?.vendor;
  return classifyTaskPrimary({
    prompt: input.prompt,
    synopsis: input.synopsis,
    primary: transportFor(input.ctx, selected.primary),
    ...(primaryVendor ? { primaryVendor } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onAttempt ? { onAttempt: input.onAttempt } : {}),
  });
}

/**
 * Run the provider-diverse secondary classifier for an already completed primary result.
 *
 * This preserves the same transport and registry selection rules as `classifyTaskWithPi`, but it is
 * callable independently so the router can execute it in the background with its own abort signal,
 * timeout, telemetry purpose, and safe-boundary reconciliation. Keeping the primary and secondary
 * entrypoints distinct makes the async lifecycle explicit in the type system instead of threading a
 * boolean or string mode parameter through one overloaded function.
 */
export async function classifyTaskSecondaryWithPi(input: {
  ctx: ExtensionContext;
  registry: readonly RegistryModelSnapshot[];
  prompt: string;
  synopsis: SessionSynopsis;
  primary: PrimaryClassificationResult;
  signal?: AbortSignal;
  onAttempt?: (observation: ClassifierAttemptObservation) => void;
}): Promise<ClassificationResult> {
  const selected = selectClassifierModels(input.registry);
  const primaryVendor = input.primary.primaryVendor ?? selected.primary[0]?.vendor;
  // Choose the independent tier from the vendor that actually answered. The primary transport falls
  // through Luna to Haiku, so the first-candidate guess can name a vendor that never produced the
  // result, and a secondary chosen from it would share the answering vendor and fail closed.
  const secondary = selectSecondaryClassifierModels(input.registry, primaryVendor);
  const secondaryVendor = secondary[0]?.vendor;
  return classifyTaskSecondary({
    prompt: input.prompt,
    synopsis: input.synopsis,
    primary: input.primary,
    secondary: transportFor(input.ctx, secondary),
    ...(primaryVendor ? { primaryVendor } : {}),
    ...(secondaryVendor ? { secondaryVendor } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onAttempt ? { onAttempt: input.onAttempt } : {}),
  });
}
