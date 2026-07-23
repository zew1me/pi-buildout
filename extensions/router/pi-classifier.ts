import { complete, validateToolArguments } from "@earendil-works/pi-ai/compat";
import type { Api, Model, Tool } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_TOOL_NAME, classifyTask } from "./classifier.ts";
import type { ClassificationResult, ClassifierRequest, ClassifierTransport } from "./classifier.ts";
import { TaskFeaturesSchema } from "./core/features.ts";
import type { ModelVendor } from "./core/profiles.ts";
import { canonicalVendor } from "./core/routing.ts";
import type { SessionSynopsis } from "./core/synopsis.ts";
import { requireToolCall } from "./core/tool-choice.ts";

const CLASSIFIER_TOOL: Tool = {
  name: CLASSIFIER_TOOL_NAME,
  description: "Return validated semantic task features. Never select a model or route.",
  parameters: TaskFeaturesSchema,
};

type ClassifierModel = {
  model: Model<Api>;
  vendor: ModelVendor;
};

// Ordered endpoint candidates for the cheap primary classification pass. Luna is preferred across
// every configured endpoint (including direct Amazon Bedrock); Haiku is the validated cross-vendor
// availability fallback tier, tried only once every Luna endpoint has failed, not an extra call.
// We do not guess an older Sonnet ID: exact IDs need a live registry entry and validated profile.
//
// Amazon Bedrock nomenclature differs from the vendor-native APIs: OpenAI models keep the bare
// "openai.<model>" form, while Anthropic models are dated release IDs ("anthropic.claude-haiku-
// 4-5-20251001-v1:0") and are also published behind cross-region inference profile IDs prefixed
// with a region code, e.g. "us.anthropic.claude-haiku-4-5-20251001-v1:0".
const FAST_PRIMARY_IDS = [
  ["openai-codex", "gpt-5.6-luna"],
  ["openai", "gpt-5.6-luna"],
  ["github-copilot", "gpt-5.6-luna"],
  ["amazon-bedrock", "openai.gpt-5.6-luna"],
  ["anthropic", "claude-haiku-4-5"],
  ["github-copilot", "claude-haiku-4.5"],
  ["amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0"],
  ["amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0"],
] as const;

// The key is the primary tier's canonical vendor; each value is deliberately from a different
// vendor for independent reconciliation. Thus the `google` entry contains OpenAI models. Multiple
// rows for one model are endpoint alternatives (including Amazon Bedrock), not extra calls.
const SECONDARY_IDS_BY_PRIMARY_VENDOR: Record<ModelVendor, readonly (readonly [string, string])[]> = {
  openai: [
    ["anthropic", "claude-sonnet-5"],
    ["github-copilot", "claude-sonnet-5"],
    ["amazon-bedrock", "anthropic.claude-sonnet-5"],
    ["amazon-bedrock", "us.anthropic.claude-sonnet-5"],
  ],
  anthropic: [
    ["openai-codex", "gpt-5.6-terra"],
    ["openai", "gpt-5.6-terra"],
    ["github-copilot", "gpt-5.6-terra"],
    ["amazon-bedrock", "openai.gpt-5.6-terra"],
  ],
  google: [
    ["openai-codex", "gpt-5.6-terra"],
    ["openai", "gpt-5.6-terra"],
    ["amazon-bedrock", "openai.gpt-5.6-terra"],
  ],
};

// Any thrown failure (rate limiting, transient 5xx, missing credentials, an unhealthy endpoint,
// etc.) falls through to the next endpoint candidate. An aborted request is the one exception:
// it means the caller cancelled the work, so retrying a different endpoint would be wasted and
// user-surprising work rather than resilience.
function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function candidateLabel(candidate: ClassifierModel): string {
  return `${candidate.model.provider}/${candidate.model.id}`;
}

function findConfiguredModels(
  models: readonly Model<Api>[],
  ids: readonly (readonly [string, string])[],
): ClassifierModel[] {
  const seen = new Set<string>();
  const found: ClassifierModel[] = [];
  for (const [provider, modelId] of ids) {
    const key = `${provider}/${modelId}`;
    if (seen.has(key)) continue;
    const model = models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
    const vendor = model ? canonicalVendor(model.provider, model.id) : undefined;
    if (model && vendor) {
      found.push({ model, vendor });
      seen.add(key);
    }
  }
  return found;
}

export function selectClassifierModels(models: readonly Model<Api>[]): {
  primary: ClassifierModel[];
  secondary: ClassifierModel[];
} {
  const primary = findConfiguredModels(models, FAST_PRIMARY_IDS);
  // The vendor guess only decides which independent secondary tier to search; tier order (Luna
  // before Haiku) already means this reflects whichever tier has any configured endpoint at all,
  // regardless of which specific endpoint within that tier ends up answering at call time.
  const primaryVendorGuess = primary[0]?.vendor;
  const secondary = primaryVendorGuess
    ? findConfiguredModels(models, SECONDARY_IDS_BY_PRIMARY_VENDOR[primaryVendorGuess])
    : [];
  return { primary, secondary };
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
        if (isAbortError(error)) throw error;
        failures.push(`${candidateLabel(candidate)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`All ${request.stage} classifier candidates failed: ${failures.join(" | ")}`);
  };
}

async function callClassifierModel(
  ctx: ExtensionContext,
  candidate: ClassifierModel,
  request: ClassifierRequest,
): Promise<ClassifierTransportResult> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate.model);
  if (!auth.ok) throw new Error(auth.error);
  if (!auth.apiKey)
    throw new Error(`No request credential resolved for ${candidate.model.provider}/${candidate.model.id}`);
  const started = performance.now();
  const response = await complete(
    candidate.model,
    {
      systemPrompt: request.systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: request.userPrompt }],
          timestamp: Date.now(),
        },
      ],
      tools: [CLASSIFIER_TOOL],
    },
    {
      apiKey: auth.apiKey,
      ...(auth.headers ? { headers: auth.headers } : {}),
      ...(auth.env ? { env: auth.env } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      maxTokens: 4_096,
      maxRetries: 1,
      reasoning: "low",
      onPayload: (payload) => requireToolCall(payload, candidate.model.api, CLASSIFIER_TOOL_NAME),
    },
  );
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? `Classifier stopped with ${response.stopReason}`);
  }
  const toolCall = response.content.find(
    (content) => content.type === "toolCall" && content.name === CLASSIFIER_TOOL_NAME,
  );
  if (toolCall?.type !== "toolCall") {
    throw new Error("Classifier did not return the required report_task_features tool call");
  }
  const validatedArguments: unknown = validateToolArguments(CLASSIFIER_TOOL, toolCall);
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

function transportFor(ctx: ExtensionContext, candidates: readonly ClassifierModel[]): ClassifierTransport {
  return transportFromCandidates(candidates, (candidate, request) => callClassifierModel(ctx, candidate, request));
}

export async function classifyTaskWithPi(input: {
  ctx: ExtensionContext;
  prompt: string;
  synopsis: SessionSynopsis;
  signal?: AbortSignal;
}): Promise<ClassificationResult> {
  const models = input.ctx.modelRegistry.getAvailable();
  const selected = selectClassifierModels(models);
  const primaryVendor = selected.primary[0]?.vendor;
  const secondaryVendor = selected.secondary[0]?.vendor;
  return classifyTask({
    prompt: input.prompt,
    synopsis: input.synopsis,
    primary: transportFor(input.ctx, selected.primary),
    secondary: transportFor(input.ctx, selected.secondary),
    ...(primaryVendor ? { primaryVendor } : {}),
    ...(secondaryVendor ? { secondaryVendor } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
