import { complete, validateToolArguments } from "@earendil-works/pi-ai/compat";
import type { Api, Model, Tool } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_TOOL_NAME, classifyTask } from "./classifier.ts";
import type { ClassificationResult, ClassifierTransport } from "./classifier.ts";
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

// Ordered endpoint candidates for the cheap primary classification pass. Luna is preferred;
// Haiku is the validated cross-vendor availability fallback, not an additional classifier call.
// We do not guess an older Sonnet ID: exact IDs need a live registry entry and validated profile.
const FAST_PRIMARY_IDS = [
  ["openai-codex", "gpt-5.6-luna"],
  ["openai", "gpt-5.6-luna"],
  ["github-copilot", "gpt-5.6-luna"],
  ["anthropic", "claude-haiku-4-5"],
  ["github-copilot", "claude-haiku-4.5"],
] as const;

// The key is the primary model's canonical vendor; each value is deliberately from a
// different vendor for independent reconciliation. Thus the `google` entry contains
// OpenAI models. Multiple rows for one model are endpoint alternatives, not extra calls.
const SECONDARY_IDS_BY_PRIMARY_VENDOR: Record<ModelVendor, readonly (readonly [string, string])[]> = {
  openai: [
    ["anthropic", "claude-sonnet-5"],
    ["github-copilot", "claude-sonnet-5"],
  ],
  anthropic: [
    ["openai-codex", "gpt-5.6-terra"],
    ["openai", "gpt-5.6-terra"],
    ["github-copilot", "gpt-5.6-terra"],
  ],
  google: [
    ["openai-codex", "gpt-5.6-terra"],
    ["openai", "gpt-5.6-terra"],
  ],
};

function findConfiguredModel(
  models: readonly Model<Api>[],
  ids: readonly (readonly [string, string])[],
): ClassifierModel | undefined {
  for (const [provider, modelId] of ids) {
    const model = models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
    const vendor = model ? canonicalVendor(model.provider, model.id) : undefined;
    if (model && vendor) return { model, vendor };
  }
  return undefined;
}

export function selectClassifierModels(models: readonly Model<Api>[]): {
  primary?: ClassifierModel;
  secondary?: ClassifierModel;
} {
  const primary = findConfiguredModel(models, FAST_PRIMARY_IDS);
  const secondary = primary ? findConfiguredModel(models, SECONDARY_IDS_BY_PRIMARY_VENDOR[primary.vendor]) : undefined;
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

function transportFor(ctx: ExtensionContext, selected: ClassifierModel | undefined): ClassifierTransport {
  return async (request) => {
    if (!selected) throw new Error(`No configured ${request.stage} classifier from the required vendor`);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(selected.model);
    if (!auth.ok) throw new Error(auth.error);
    if (!auth.apiKey)
      throw new Error(`No request credential resolved for ${selected.model.provider}/${selected.model.id}`);
    const started = performance.now();
    const response = await complete(
      selected.model,
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
        onPayload: (payload) => requireToolCall(payload, selected.model.api, CLASSIFIER_TOOL_NAME),
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
      provider: selected.model.provider,
      modelId: selected.model.id,
      vendor: selected.vendor,
      latencyMs: Math.round(performance.now() - started),
      usage: {
        input: response.usage.input,
        output: response.usage.output,
        cacheRead: response.usage.cacheRead,
        cacheWrite: response.usage.cacheWrite,
        cost: response.usage.cost.total,
      },
    };
  };
}

export async function classifyTaskWithPi(input: {
  ctx: ExtensionContext;
  prompt: string;
  synopsis: SessionSynopsis;
  signal?: AbortSignal;
}): Promise<ClassificationResult> {
  const models = input.ctx.modelRegistry.getAvailable();
  const selected = selectClassifierModels(models);
  return classifyTask({
    prompt: input.prompt,
    synopsis: input.synopsis,
    primary: transportFor(input.ctx, selected.primary),
    secondary: transportFor(input.ctx, selected.secondary),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
