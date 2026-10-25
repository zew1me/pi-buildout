/** @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi */
export default function rpcIntegrationProvider(pi) {
  const baseUrl = process.env.PI_RPC_TEST_BASE_URL;
  if (!baseUrl) throw new Error("PI_RPC_TEST_BASE_URL is required for the subagent RPC integration test.");
  pi.registerProvider("rpc-test", {
    baseUrl,
    apiKey: process.env.PI_RPC_TEST_API_KEY ?? "integration-test-only",
    api: "openai-completions",
    models: [
      {
        id: "integration-model",
        name: "Subagent RPC integration model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_000,
        maxTokens: 256,
      },
    ],
  });
}
