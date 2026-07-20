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

If either model or effort is omitted, a classifier call sees the task, the compacted context, and all authenticated
models (including capabilities, context size, and pricing). Its choice is validated against Pi's model registry. If
classification fails, missing values inherit the parent model and effort. Explicit user choices are never silently
replaced; invalid or unauthenticated explicit models fail creation.

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
pi -e extensions/subagents/index.ts --list-models > /dev/null
```
