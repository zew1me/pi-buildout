export type SynopsisEntry = {
  kind: "user" | "assistant" | "tool" | "compaction" | "branch_summary";
  text?: string;
  toolName?: string;
  path?: string;
  isError?: boolean;
  stopReason?: string;
  readFiles?: readonly string[];
  modifiedFiles?: readonly string[];
};

export type RepositoryMetadata = {
  root: string;
  head?: string;
  upstream?: string;
  dirty: boolean;
  changedFiles: readonly string[];
  languageBuckets: readonly string[];
};

export type SynopsisInput = {
  sessionId: string;
  cwd: string;
  builder?: { provider: string; modelId: string; vendor?: string; effort: string };
  activeTools: readonly string[];
  contextTokens: number;
  contextWindow: number;
  entries: readonly SynopsisEntry[];
  repository: RepositoryMetadata;
};

export type SessionSynopsis = {
  version: 1;
  sessionId: string;
  workspace: string;
  builder?: SynopsisInput["builder"];
  activeTools: string[];
  context: {
    tokens: number;
    contextWindow: number;
    percent: number;
  };
  repository: {
    root: string;
    head?: string;
    upstream?: string;
    dirty: boolean;
    changedFiles: string[];
    languageBuckets: string[];
  };
  artifactState: {
    readFiles: string[];
    modifiedFiles: string[];
    failedTools: string[];
  };
  priorDecisions: string[];
  recentGoals: string[];
  recentOutcomes: string[];
  lastCompactionSummary?: string;
};

const MAX_SYNOPSIS_BYTES = 8_000;

function cleanText(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  const printable = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? " " : character;
  }).join("");
  const cleaned = printable.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > maximum ? `${cleaned.slice(0, Math.max(0, maximum - 1))}…` : cleaned;
}

function boundedUnique(values: Iterable<string>, maximumItems: number, maximumLength: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = cleanText(value, maximumLength);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= maximumItems) break;
  }
  return result;
}

function decisionLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#\s]+/, "").trim())
    .filter((line) => /^(?:decision|decided|chose|will use|must |do not )/i.test(line));
}

function trimToBudget(synopsis: SessionSynopsis): SessionSynopsis {
  while (Buffer.byteLength(JSON.stringify(synopsis), "utf8") > MAX_SYNOPSIS_BYTES) {
    if (synopsis.recentOutcomes.length > 1) synopsis.recentOutcomes.pop();
    else if (synopsis.recentGoals.length > 1) synopsis.recentGoals.pop();
    else if (synopsis.priorDecisions.length > 1) synopsis.priorDecisions.pop();
    else if (synopsis.artifactState.readFiles.length > 5) synopsis.artifactState.readFiles.pop();
    else if (synopsis.repository.changedFiles.length > 5) synopsis.repository.changedFiles.pop();
    else if (synopsis.lastCompactionSummary && synopsis.lastCompactionSummary.length > 500) {
      synopsis.lastCompactionSummary = `${synopsis.lastCompactionSummary.slice(0, 499)}…`;
    } else break;
  }
  return synopsis;
}

export function buildSessionSynopsis(input: SynopsisInput): SessionSynopsis {
  const reverseEntries = [...input.entries].reverse();
  const recentGoals = boundedUnique(
    reverseEntries.filter((entry) => entry.kind === "user").map((entry) => entry.text ?? ""),
    3,
    360,
  );
  const recentOutcomes = boundedUnique(
    reverseEntries
      .filter((entry) => entry.kind === "assistant")
      .map((entry) => `${entry.stopReason ? `[${entry.stopReason}] ` : ""}${entry.text ?? ""}`),
    2,
    360,
  );
  const summaries = reverseEntries.filter((entry) => entry.kind === "compaction" || entry.kind === "branch_summary");
  const lastCompactionSummary = cleanText(summaries[0]?.text, 1_500);
  const priorDecisions = boundedUnique(
    summaries.flatMap((entry) => decisionLines(entry.text ?? "")),
    8,
    240,
  );
  const readFiles = boundedUnique(
    input.entries.flatMap((entry) => [
      ...(entry.readFiles ?? []),
      ...(entry.toolName === "read" && entry.path ? [entry.path] : []),
    ]),
    40,
    240,
  );
  const modifiedFiles = boundedUnique(
    input.entries.flatMap((entry) => [
      ...(entry.modifiedFiles ?? []),
      ...(["edit", "write"].includes(entry.toolName ?? "") && entry.path ? [entry.path] : []),
    ]),
    40,
    240,
  );
  const failedTools = boundedUnique(
    input.entries.filter((entry) => entry.kind === "tool" && entry.isError).map((entry) => entry.toolName ?? "unknown"),
    10,
    80,
  );
  const contextWindow = Math.max(1, Math.floor(input.contextWindow));
  const tokens = Math.max(0, Math.floor(input.contextTokens));
  const head = cleanText(input.repository.head, 100);
  const upstream = cleanText(input.repository.upstream, 100);
  const synopsis: SessionSynopsis = {
    version: 1,
    sessionId: cleanText(input.sessionId, 100) ?? "unknown",
    workspace: cleanText(input.cwd, 500) ?? ".",
    ...(input.builder ? { builder: { ...input.builder } } : {}),
    activeTools: boundedUnique(input.activeTools, 100, 100).sort(),
    context: {
      tokens,
      contextWindow,
      percent: Math.min(100, Math.round((tokens / contextWindow) * 10_000) / 100),
    },
    repository: {
      root: cleanText(input.repository.root, 500) ?? input.cwd,
      ...(head ? { head } : {}),
      ...(upstream ? { upstream } : {}),
      dirty: input.repository.dirty,
      changedFiles: boundedUnique(input.repository.changedFiles, 50, 240).sort(),
      languageBuckets: boundedUnique(input.repository.languageBuckets, 20, 60).sort(),
    },
    artifactState: { readFiles, modifiedFiles, failedTools },
    priorDecisions,
    recentGoals,
    recentOutcomes,
    ...(lastCompactionSummary ? { lastCompactionSummary } : {}),
  };
  return trimToBudget(synopsis);
}

export function synopsisByteLength(synopsis: SessionSynopsis): number {
  return Buffer.byteLength(JSON.stringify(synopsis), "utf8");
}
