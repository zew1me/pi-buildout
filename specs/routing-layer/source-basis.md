# Routing layer — source basis and authority

This document replaces the routing documents' former references to an unspecified “external spec.” The original design
input was a local 2026-07-16 conversation export. It is not required to build, run, test, review, or maintain the
router; the material needed by this repository is restated in local documents and executable contracts below.

## Repository authorities

Use these checked-in sources rather than the original export:

1. [`SPEC.md`](SPEC.md) is the functional authority for intended behavior.
2. [`features.ts`](../../extensions/router/core/features.ts), [`synopsis.ts`](../../extensions/router/core/synopsis.ts),
   [`policy.ts`](../../extensions/router/core/policy.ts), and [`profiles.ts`](../../extensions/router/core/profiles.ts)
   are the executable data contracts and policy snapshot.
3. [`decisions.md`](decisions.md) records architecture choices; [`implementation-plan.md`](implementation-plan.md) and
   [`implementation-decisions.md`](implementation-decisions.md) record delivery and simplification decisions.
4. [`eval.md`](eval.md), the checked-in [golden corpus](../../extensions/router/eval/corpus/routes.json), and
   [`eval-results-2026-07-17.md`](eval-results-2026-07-17.md) define and record evaluation.

A difference between `SPEC.md` and an executable contract is a repository defect to resolve, not a reason to consult the
historical export. The source material below is provenance and background evidence, never runtime policy.

## Material incorporated from the design export

| Historical artifact                                  | Material retained in this repository                                                                                                                | Local authority                                                                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model-Aware Prompt Routing Specification             | Context-aware task leases, semantic classifier axes, deterministic prompt compilation, provider-aware ordering, and model-family prompt profiles    | [`SPEC.md`](SPEC.md), [`features.ts`](../../extensions/router/core/features.ts), and [`profiles.ts`](../../extensions/router/core/profiles.ts)                             |
| Coding-Agent Model Router Implementation Plan        | Two-attempt ordinary fallback, sequential non-builder review, deterministic verification priority, exact-ID/profile eligibility, and separate plans | [`SPEC.md`](SPEC.md), [`fallback.ts`](../../extensions/router/core/fallback.ts), and [`planning.ts`](../../extensions/router/core/planning.ts)                             |
| LLM Model Selection for Coding-Agent Harnesses guide | Bootstrap route priors, 70% context headroom, robust cost-to-done ranking, cache-aware boundaries, and percentile telemetry                         | [`policy.ts`](../../extensions/router/core/policy.ts), [`routing.ts`](../../extensions/router/core/routing.ts), and [`telemetry.ts`](../../extensions/router/telemetry.ts) |
| Python reference-router package                      | No executable contract was imported; it was an illustrative prototype with assumptions that conflict with the implemented TypeScript router         | [`decisions.md`](decisions.md)                                                                                                                                             |

The historical feature examples used snake_case fields and included fields that the implementation can derive from
trusted harness state. The repository's concrete, camelCase `TaskFeatures` object is documented in `SPEC.md` and
validated by `TaskFeaturesSchema`; it is intentionally not a byte-for-byte copy of that example.

## Public background references

These links were retained from the design export so model/profile and cache claims have inspectable external context.
They are background evidence only. Provider availability, exact model IDs, context limits, controls, and prices must be
resolved from pi's live `ModelRegistry` and the configured endpoint.

### Prompt profiles

- OpenAI:
  [GPT-5.3-Codex prompting practices](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.3-codex#gpt-5.3-codex-prompting-best-practices),
  [GPT-5.5 prompting](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5#gpt-5.5-prompting), and
  [GPT-5.6 prompting practices](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6#prompting-best-practices).
- Anthropic:
  [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices),
  [Claude Sonnet 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5),
  [Claude Opus 4.8](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8),
  and
  [Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5).
- Google:
  [Gemini 3 prompting guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/gemini-3-prompting-guide)
  and [Gemini prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies).

### Context caching and effort

- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and
  [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching) and
  [Gemini thinking controls](https://ai.google.dev/gemini-api/docs/generate-content/thinking)

### Catalogs, benchmarks, and integrations

- [OpenAI model catalog](https://developers.openai.com/api/docs/models),
  [Anthropic model overview](https://docs.anthropic.com/en/docs/about-claude/models/overview), and
  [Google Gemini model catalog](https://ai.google.dev/gemini-api/docs/models)
- [SWE-bench](https://github.com/SWE-bench/swe-bench.github.io),
  [LiveCodeBench](https://livecodebench.github.io/leaderboard_v5.html), and
  [Terminal-Bench](https://github.com/laude-institute/terminal-bench)
- [Bifrost](https://github.com/maximhq/bifrost), used by the opt-in real-provider evaluation, and the optional
  [`pi-telemetry-otel` package](https://www.npmjs.com/package/pi-telemetry-otel)
