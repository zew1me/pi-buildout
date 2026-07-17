# Model-aware router

A task-leased, model-aware routing extension for pi. It classifies semantic task features, applies deterministic
eligibility/ranking policy, selects a versioned model prompt profile, and records an audit trail.

The extension starts in **shadow mode**: it logs and displays the route but does not change the model, effort, or system
prompt. This is intentional.

## Repository contract

The router has no dependency on an untracked design document or local conversation export. Its checked-in authorities
are:

- the [functional specification](../../specs/routing-layer/SPEC.md) and
  [source basis](../../specs/routing-layer/source-basis.md);
- the executable [feature](core/features.ts), [synopsis](core/synopsis.ts), [policy](core/policy.ts), and
  [prompt-profile](core/profiles.ts) contracts;
- the [architecture decisions](../../specs/routing-layer/decisions.md),
  [implementation record](../../specs/routing-layer/implementation-plan.md), and
  [evaluation contract](../../specs/routing-layer/eval.md).

The source-basis document records the historical inputs that were incorporated and links the public provider, benchmark,
Bifrost, and telemetry references. If prose and executable contracts diverge, treat that as a repository bug; do not
reconstruct behavior from the historical export.

## Commands

- `/route` — show the current mode, task lease, model, effort, profile, and attempt.
- `/route shadow|active|off` — change mode for this session.
- `/route reset` — clear the lease; the next user message starts a new task.
- `/route accept|reject` — label the most recent attempt for telemetry maturity.
- `/route fail availability|quality|deterministic_verification` — apply the authorized sequential fallback. Ordinary
  routes never get a third choice.

Planning routes must call `submit_implementation_plan`; the tool validates the PR dependency DAG, acceptance criteria,
rollout, and rollback. A request to start implementation always receives a new lease. High-risk mutating tasks
automatically run a read-only, provider-independent child review before restoring the builder lease.

`PI_ROUTER_MODE=shadow|active|off` controls the initial mode when a session has no persisted router state. The default
is `shadow`.

## Data and telemetry

The lease is persisted as pi custom session entries. Local audit events are appended to:

```text
~/.pi/agent/router-telemetry/events.jsonl
```

Set `PI_ROUTER_TELEMETRY_PATH` to override the JSONL location (useful for isolated tests). When `pi-telemetry-otel` is
installed separately, router spans attach through its global Symbol registries. The router has no additional runtime
dependencies and works without OTel.

## Real Bifrost evaluation

Run `npm run test:eval:real`. The harness prefers already-exported `BIFROST_BASE_URL` plus `BIFROST_VIRTUAL_KEY`, then
fills missing values from the repository-local, gitignored `.env`. Start from `.env.example`; ordinary `npm test`
explicitly skips real-provider calls so local credentials do not make quality checks costly or non-deterministic.

## Safety behavior

- Only user input can trigger classification or a new lease.
- New sessions, post-compaction turns, upstream-ref changes, and forks are hard boundaries.
- Explicit model or effort changes bypass automatic routing until the next task boundary.
- Unknown, unavailable, over-context, unsupported-effort, or unprofiled candidates are excluded.
- The request remains a native user message and is never paraphrased into system policy.
