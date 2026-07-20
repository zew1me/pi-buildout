import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ENV = "PI_SIMPLE_SUBAGENT_AUTH_PROVIDER";
const API_KEY_ENV = "PI_SIMPLE_SUBAGENT_API_KEY";

/**
 * Invocation-private bridge for runtime-only parent credentials (for example
 * `pi --api-key ...`). The child process receives the secret in its environment,
 * never in argv, and applies it only to the selected provider. Normal persisted
 * auth continues to work unchanged.
 */
export default function subagentAuthBridge(pi: ExtensionAPI) {
  const provider = process.env[PROVIDER_ENV]?.trim();
  const apiKey = process.env[API_KEY_ENV];
  Reflect.deleteProperty(process.env, PROVIDER_ENV);
  Reflect.deleteProperty(process.env, API_KEY_ENV);
  if (!provider || !apiKey || /[\0\r\n]/.test(provider)) return;
  pi.registerProvider(provider, { apiKey });
}
