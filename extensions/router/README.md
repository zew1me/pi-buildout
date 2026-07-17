# Model-aware router

A task-leased, model-aware routing extension for pi. It classifies semantic task features, applies
deterministic eligibility/ranking policy, selects a versioned model prompt profile, and records an
audit trail.

The extension starts in **shadow mode**: it logs and displays the route but does not change the model,
effort, or system prompt. This is intentional.

## Commands

- `/route` — show the current mode, task lease, model, effort, profile, and attempt.
- `/route shadow|active|off` — change mode for this session.
- `/route reset` — clear the lease; the next user message starts a new task.
- `/route accept|reject` — label the most recent attempt for telemetry maturity.
- `/route fail availability|quality|deterministic_verification` — apply the authorized sequential
  fallback. Ordinary routes never get a third choice.

`PI_ROUTER_MODE=shadow|active|off` controls the initial mode when a session has no persisted router
state. The default is `shadow`.

## Data and telemetry

The lease is persisted as pi custom session entries. Local audit events are appended to:

```text
~/.pi/agent/router-telemetry/events.jsonl
```

Set `PI_ROUTER_TELEMETRY_PATH` to override the JSONL location (useful for isolated tests). When
`pi-telemetry-otel` is installed separately, router spans attach through its global Symbol registries.
The router has no additional runtime dependencies and works without OTel.

## Safety behavior

- Only user input can trigger classification or a new lease.
- New sessions, post-compaction turns, upstream-ref changes, and forks are hard boundaries.
- Explicit model or effort changes bypass automatic routing until the next task boundary.
- Unknown, unavailable, over-context, unsupported-effort, or unprofiled candidates are excluded.
- The request remains a native user message and is never paraphrased into system policy.
