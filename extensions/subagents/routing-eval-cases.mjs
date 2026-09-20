/**
 * Routing evaluation corpus.
 *
 * Every task below is an abridged real subagent kickoff taken from local Pi
 * subagent session logs (`~/.pi/agent/subagents`), so the cases exercise the
 * shapes the classifier actually sees: terse liveness handshakes, read-only
 * review and analysis work, and multi-file implementation against a named
 * issue. Task text is abridged for readability; repository-identifying detail
 * is kept only where it carries the signal the classifier routes on.
 *
 * `allow` lists the tiers a defensible decision may land in, not one golden
 * answer, because routing is a judgment call with a band of reasonable
 * outcomes. `maxEffort` bounds spend for work that cannot justify deep
 * reasoning. Cases are intentionally lenient: the suite is designed to catch
 * policy violations (paying for capability a task cannot use, silently
 * reaching for the frontier tier), not to pin the classifier to one choice.
 */

/** @typedef {"substandard" | "economy" | "standard" | "premium" | "frontier"} RoutingTier */

/**
 * @typedef {object} RoutingEvalCase
 * @property {string} id
 * @property {string} task
 * @property {RoutingTier[]} allow Tiers a defensible decision may select.
 * @property {import("./helpers.ts").ThinkingLevel} [maxEffort] Highest effort this task can justify.
 * @property {boolean} [allowEscalation] Whether the frontier tier is defensible here.
 * @property {string} why Why this case bounds routing the way it does.
 */

/** @type {RoutingEvalCase[]} */
export const ROUTING_EVAL_CASES = [
  {
    id: "handshake-waitok",
    task: "Reply exactly WAITOK without tools",
    allow: ["economy"],
    maxEffort: "low",
    why: "A fixed-string liveness handshake needs no reasoning; anything above the cheapest tier is pure waste.",
  },
  {
    id: "handshake-ready",
    task: "Reply exactly READY without using tools.",
    allow: ["economy"],
    maxEffort: "low",
    why: "Same handshake shape as the logged gpt-4.1-nano/off kickoffs.",
  },
  {
    id: "lookup-config-value",
    task: "Report the configured default thinking level in the repository settings file. Do not edit anything.",
    allow: ["economy"],
    maxEffort: "medium",
    why: "A single-file mechanical lookup is the canonical cheapest-tier task.",
  },
  {
    id: "review-integration-checklist",
    task:
      "Review the repository's Intervals.icu integration and the official Strava docs plus GitHub issue #340. " +
      "Produce a concise implementation checklist and flag Strava-specific pitfalls (OAuth/token refresh, scopes, " +
      "activity mapping, pagination/rate limits, deauth/data deletion, security). Do not edit files.",
    allow: ["economy", "standard"],
    why: "Bounded read-only review over a known integration; the logged run chose Terra at high effort, and Luna at high effort is equally defensible.",
  },
  {
    id: "review-coderabbit-thread",
    task:
      "Analyze CodeRabbit thread PRRT_kwDORtPMQ86S0EJS on PR #371. Create a worktree from origin. The claim is that " +
      "duplicate Intervals/Strava persistence helpers in backend/repos/supabase_repo.py should consolidate. Verify " +
      "the exact duplication, the CPD threshold, readability, and risk. Be adversarial about the claim.",
    allow: ["economy", "standard"],
    why: "Scoped adversarial review of one review thread; logged runs used Luna at medium and high effort.",
  },
  {
    id: "debug-sentry-504",
    task:
      "Read-only review task. Independently inspect the Sentry PYTHON-FASTAPI-10 diagnosis described by the parent: " +
      "postgrest-py surfaces a Supabase gateway 504 as APIError(code='504') during OAuthRepository.upsert_grant, " +
      "leaving browser-token writes unchanged. Determine whether the diagnosis holds and what the correct retry and " +
      "idempotency boundary is.",
    allow: ["standard", "premium"],
    why: "Subtle cross-layer failure semantics; logged runs used gpt-5.4 and Terra at high effort.",
  },
  {
    id: "implement-issue-427",
    task:
      "Implement the production fix for GitHub issue #427 on top of the committed regression tests. Read AGENTS.md, " +
      "issue #427, backend/repos/supabase_repo.py, the new tests, and existing Pydantic omitted-vs-default patterns. " +
      "Change the narrowest production surface and keep the shipped contract intact.",
    allow: ["standard", "premium"],
    why: "Multi-file implementation against an existing contract and regression suite; deserves a stronger tier but not the frontier.",
  },
  {
    id: "audit-auth-security",
    task:
      "Audit the OAuth token refresh and session handling paths across the backend for privilege escalation, token " +
      "leakage, and replay exposure. Report concrete exploitable findings with file and line references.",
    allow: ["standard", "premium"],
    why: "Security review is explicitly called out as deserving a stronger tier and higher effort.",
  },
];

/**
 * Cases asserting that the frontier tier stays gated.
 *
 * These are deliberately hard tasks. Even here the expectation is that routing
 * does not *silently* select the escalation tier: reaching it requires the
 * approval gate, which is what `allowEscalation` models.
 */
/** @type {RoutingEvalCase[]} */
export const ESCALATION_EVAL_CASES = [
  {
    id: "frontier-architecture",
    task:
      "Design and implement a migration from the current single-tenant Supabase schema to a multi-tenant model with " +
      "row-level security, zero downtime, and a reversible rollout across every backend repository.",
    allow: ["standard", "premium", "frontier"],
    allowEscalation: true,
    why: "Broad architecture work is the one shape where escalation is defensible, and only behind approval.",
  },
];
