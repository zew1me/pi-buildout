type Environment = Readonly<Record<string, string | undefined>>;

type BifrostEvalEnvironment = {
  baseUrl?: string;
  virtualKey?: string;
};

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

/** Resolves only the two supported BIFROST_* settings, with exported values winning per field. */
export function resolveBifrostEvalEnvironment(exported: Environment, dotenv: Environment): BifrostEvalEnvironment {
  const baseUrl = nonEmpty(exported.BIFROST_BASE_URL) ?? nonEmpty(dotenv.BIFROST_BASE_URL);
  const virtualKey = nonEmpty(exported.BIFROST_VIRTUAL_KEY) ?? nonEmpty(dotenv.BIFROST_VIRTUAL_KEY);
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(virtualKey ? { virtualKey } : {}),
  };
}
