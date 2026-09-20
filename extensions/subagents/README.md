# Subagents

A deliberately small Pi extension for long-lived, isolated child sessions.

## Natural-language use

No slash command or agent profile is required. Ask Pi normally:

```text
Create a subagent to review the authentication changes.
Create a subagent and ask it to implement the migration with gpt-5.6-luna at high effort.
Spy on the subagent, including its token usage and current tool.
Wait up to two minutes for the subagent because this turn needs its result.
Steer that subagent to focus on backward compatibility.
Queue a follow-up asking it to run the integration tests.
Interrupt the subagent, then ask it to investigate the failing test instead.
```

The extension's `subagent` tool supports `create`, `list`, `status`, `wait`, `steer`, `follow_up`, `interrupt`, and
`stop`. Creation is asynchronous and returns a direct-child id. `wait` is explicit and bounded: timing out never stops
the child.

## Context and model selection

Before launch, the extension creates an in-memory copy of the prior context and runs Pi's real `AgentSession.compact()`
path (the SDK equivalent of `/compact`) with task-specific instructions. The current delegation turn is excluded because
its task is supplied separately; this prevents a child from recursively replaying the parent's orchestration request. A
synthetic retained boundary allows even small parent sessions to be compacted. Only that compacted context and the
delegated task are sent into a new child session; the parent session file is never resumed, forked, or replaced by the
child. Context seeding fails open: if compaction fails, the child launches with only its task and a fresh context—never
an unreviewed raw parent transcript.

If either model or effort is omitted, a classifier call sees the task, the compacted context, and the current Pi
session's resolved model scope, including model capabilities, context size, pricing, and any pinned effort. When the
session has no configured scope, all authenticated available models remain eligible. Classifier output is resolved
strictly against that candidate set, so an invented or out-of-scope identifier cannot launch a child.

A nonempty session scope is a hard boundary for explicit requests too: an out-of-scope requested model fails creation
and reports the eligible models rather than acting as an override. If classification fails, fallback uses the requested
model when one was valid, then the active parent model when it is in scope, then the first scoped model. A parent model
outside the scope is therefore never launched silently. Effort precedence is explicit request, scoped effort pin,
classifier choice, then parent effort; every value is clamped to the selected model's supported levels.

Children receive `--models` containing the parent's resolved canonical model references and effort pins. This preserves
the effective scope across recursive delegation. Wildcard patterns are intentionally frozen to their resolved models so
a child with a different catalog cannot widen them. Pi represents both "no scope configured" and a configured scope
whose patterns matched no models as an empty `ctx.scopedModels`; in either case this extension follows Pi and treats the
session as unscoped.

## Cost-efficient tier selection

Routing aims for the cheapest model and effort that clears the task's required intelligence. Within the GPT-5.6 family
capability and cost both rise Luna -> Terra -> Sol, and raising effort on a cheaper model is usually a better trade than
moving to a pricier model at low effort. Trivial and mechanical work stays on the cheapest tier; broad implementation,
subtle debugging, security, and architecture work earn a stronger one.

`gpt-5.4-mini` is deliberately ranked _below_ Luna despite costing about 3.75x more per token. Measured head-to-head it
is dominated on all three axes at once - intelligence index 24 at $0.41 and 261s per task, against Luna's 32 at $0.04
and 98s - so routing prefers Luna whenever both are eligible and reaches for `gpt-5.4-mini` only when no GPT-5.6 model
is in scope. The eval suite bands it as `substandard` rather than cheap for the same reason.

Models outside the reviewed benchmarks fall back to output price as a coarse capability proxy, bounded so an expensive
unknown model cannot outrank the frontier tier.

## Frontier escalation and approval

The frontier tier (GPT-6 Astra) is gated. Escalation is worth requesting in two cases: the task genuinely needs
coding-agent capability above the ceiling tier, or hallucination and factual reliability are a material risk, where
Astra errs roughly half as often. On agentic coding work the premium is modest (~$7.08 against ~$6.24 per task), so the
approval gate rather than cost is the reason to be selective.

Every selection path - explicit request, routing plugin, classifier, and fallback - passes through the same gate, so an
escalation-class model cannot launch unapproved regardless of which path chose it. The gate matches the Astra family by
bare model id across every provider that aliases it, not one provider-qualified identifier.

Approval uses Pi's dialog timeout. Declining, answering nothing within 30 seconds, or running without interactive UI all
fall back to the _ceiling selection_: the strongest non-escalation scoped model at the highest effort it actually
supports. Trigger and fallback share that one reference point, so they cannot disagree. Note that the ceiling is
`gpt-5.6-sol` at `xhigh` rather than `max`, because the GPT-5.6 endpoints reject `max`. Supported effort is treated as a
property of the model rather than the route to it: providers exposing the same model string (`openai`, `openai-codex`,
and gateways) are equivalent and get the same narrowing.

Two cases skip the prompt deliberately. A nested subagent has no human on its RPC channel, so it declines immediately
instead of burning the full timeout. A session scope containing no non-escalation model is itself the authorization,
since there is no lower tier to fall back to. Escalation never widens the session scope: if Astra is not in scope, it is
not reachable, and approval cannot conjure it.

## Pluggable routing

Another extension may take over routing by registering on a well-known global during its own activation:

```js
globalThis[Symbol.for("pi.subagents.router")] = {
  name: "my-router",
  route({ task, context, candidates, parentModel, parentEffort, requestedModel, requestedEffort }) {
    return { model: "openai-codex/gpt-5.6-luna", effort: "high", rationale: "mechanical edit" };
  },
};
```

A registered router is consulted before the built-in classifier. It only _proposes_: its identifier is resolved through
the same strict, scope-constrained path as classifier output, so an unknown or out-of-scope choice falls through to the
classifier rather than widening the scope. Returning `undefined`, throwing, or proposing an unusable model all defer to
the built-in ladder. Omitting `effort` leaves it to the normal precedence chain. A router's choice is still subject to
the escalation gate.

## Routing evaluation

`routing-eval-cases.mjs` holds a corpus abridged from real subagent kickoffs found in local Pi subagent session logs
(`~/.pi/agent/subagents`), spanning fixed-string liveness handshakes through read-only review, cross-layer debugging,
and multi-file implementation. Each case allows a _band_ of defensible tiers rather than one golden answer, because
routing is a judgment call.

`routing-eval.mjs` scores any decision source - the classifier, a routing plugin, or a stub - through the same strict
in-scope resolution the extension itself uses, so an eval pass cannot come from an identifier the real flow would have
rejected. The suite carries negative controls: always-frontier, always-`gpt-5.4-mini`, overspent effort, and
hallucinated identifiers must each fail. A test pins the evaluated prompt to `buildClassifierPrompt`, so the suite
cannot drift onto a private copy of the shipped instructions.

## Isolation and inheritance

- Children run as independent Pi RPC processes in the same working directory.
- Normal Pi discovery remains enabled, so children inherit the skills, extensions, MCP adapters, project instructions,
  and built-in tools available under the parent's trusted working directory.
- The extension itself is explicitly loaded so every child can create its own children.
- Each extension process keeps a private registry containing only its direct children. There is no child-to-parent or
  sibling messaging API.
- Child output is retained privately and enters parent model context only when the parent explicitly calls `status` or
  `wait`.
- `status` reports the transcript tail, active tool, turns, tool calls, queued messages, token usage, cost, context
  utilization, and compaction count when available.
- Parent control uses the child's one-way RPC stdin: `steer`, `follow_up`, `interrupt`, and `stop`.
- Parent/session shutdown terminates its direct children; their own shutdown handlers terminate the next generation.

The default safety bounds are 8 active root children, 2 direct children for every nested session, and 3 generations.
Even full fan-out is therefore bounded to 56 child processes per root tree.

## Direct tool shape

```json
{ "action": "create", "task": "Review the diff", "model": "gpt-5.6-luna", "effort": "high" }
{ "action": "status", "id": "a1b2c3d4e5" }
{ "action": "wait", "id": "a1b2c3d4e5", "timeoutMs": 120000 }
{ "action": "steer", "id": "a1b2c3d4e5", "task": "Focus on data races" }
{ "action": "follow_up", "id": "a1b2c3d4e5", "task": "Then run tests" }
{ "action": "interrupt", "id": "a1b2c3d4e5" }
{ "action": "stop", "id": "a1b2c3d4e5" }
```

## Verification

```bash
node --test extensions/subagents/*.test.mjs
node --test extensions/subagents/routing-eval.test.mjs
pi -e extensions/subagents/index.ts --list-models > /dev/null
```
