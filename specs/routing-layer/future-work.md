# Routing layer — tracked future work

These items are intentionally deferred from the MVP. They are documented here so the current implementation stays small
without turning known limitations into accidental policy.

## FW1 — Endpoint circuit breakers and active health recovery

**Status:** deferred; design and implement before routing is enabled for unattended production workloads.

The current fallback state machine reacts to an availability failure within one task lease and then moves to the next
authorized exact choice. It does not retain endpoint health across leases.

Add a per-endpoint circuit breaker that:

- opens after a bounded combination of timeouts, transport failures, rate limits, and poor-quality outcomes;
- fails fast instead of waiting repeatedly on an endpoint already believed unhealthy;
- uses bounded, low-cost background probes to move from open to half-open and then healthy;
- keeps health state separate from task quality telemetry and records every state transition;
- prevents probe traffic from carrying repository or user content;
- preserves the existing exact-ID, provider-diversity, and bounded-fallback policy;
- has deterministic clock/probe tests, restart behavior, and operator controls.

Before implementation, specify timeout ownership between pi, the provider transport, and the router so cancellation does
not leave a slow agent running after the lease has moved on.

## FW2 — Workflow-specific horizon semantics

**Status:** deferred; revisit when the corpus contains enough non-coding planning and operations examples.

The classifier currently uses one bounded `horizon` enum. Its PR-oriented middle values are natural for software
implementation but less clear for research, advisory, incident, and non-coding tool workflows. Do not add a second axis
until it improves measured routing accuracy.

Evaluate either:

1. documenting a workflow-to-horizon interpretation table while retaining one schema field; or
2. replacing the field with a discriminated workflow-specific horizon schema.

Any change must preserve strict schema validation, update all classifier prompts and corpus fixtures, include a
migration for persisted leases, and demonstrate better archetype accuracy without increasing hard-policy violations.
