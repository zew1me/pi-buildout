# Attribution

The subagent extension in [`extensions/subagents`](extensions/subagents) was informed by the two implementations identified by the project owner. The implementation in this repository is original code, but it deliberately carries forward architectural ideas and operational lessons from both projects.

## `nicobailon/pi-subagents`

- Repository: <https://github.com/nicobailon/pi-subagents>
- Local revision reviewed: `315e1eb1482c4ac2d912a8d95aac4287dc7e60ac`
- License declared by its package: MIT

Ideas and lessons used:

- Treat a subagent as a separate Pi process and session rather than an in-process prompt persona.
- Keep asynchronous child work observable through structured state and transcript tails.
- Expose explicit lifecycle controls for status inspection, steering, interruption, and stopping.
- Bound child protocol and diagnostic output so a malformed or noisy child cannot grow parent memory without limit.
- Make recursive delegation safe by scoping child registries and controls to a parent/child tree rather than a global fleet.
- Validate model choices against Pi's live model registry and preserve a clear fallback path.
- Clean up child processes and extension-owned resources during Pi session shutdown/reload.

We intentionally did **not** reproduce its agent profiles, chain/parallel workflow engine, intercom/supervisor channel, watchdog, artifact protocol, slash-command suite, or TUI fleet. This extension stays between that feature-rich design and a one-shot runner.

## `elpapi42/pi-minimal-subagent`

- Repository: <https://github.com/elpapi42/pi-minimal-subagent>
- Local revision reviewed: `4c847a37b7d675470a8c5eb50d736d11ceac910a`
- License declared by its package: MIT

Ideas and lessons used:

- Keep the model-facing surface centered on one small `subagent` tool.
- Let ordinary natural-language requests cause the parent model to delegate; do not require a special slash workflow.
- Launch child Pi with normal extension/resource discovery by default so configured tools and integrations remain available.
- Resolve the Pi executable robustly when Pi is running either as a standalone executable or through Node.
- Use process isolation and propagate shutdown/abort behavior instead of sharing an agent session object.
- Keep task dispatch simple and avoid requiring named role/persona files.

We extended that minimal shape with persistent RPC children, task-targeted context compaction, automatic model/effort classification, direct-child spying and control, and recursive child creation.

## `tintinweb/pi-subagents`

- Repository: <https://github.com/tintinweb/pi-subagents>
- Local revision reviewed: `c161865a0e8ca12f406041c263ea6c2ca35c74d5` (`0.14.1`)
- License: MIT

This package was reviewed after the initial implementation as a source of possible follow-up ideas. The review considered its in-process SDK sessions, background concurrency queue, graceful turn limits, result/steering tools, conversation viewer, context-usage statistics, compact tool-description mode, model-scope guardrail, and resumable sessions.

No tintinweb code was copied or modified, and no tintinweb-specific feature was incorporated in the implementation covered by these commits. The package remains conceptual comparison material pending user review. Major pieces intentionally not adopted include named/default agent types, custom agent frontmatter, proactive completion notifications, FleetView/widget UI, scheduling, event-bus RPC, persistent memory, worktree isolation, skill preloading, and its three-tool Claude Code-compatible surface.

## Pi documentation and examples

- Source: `@earendil-works/pi-coding-agent`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Release reviewed: `0.80.6` (the locally installed Homebrew package)
- License declared by the package: MIT

Ideas and API patterns used:

- Extension tool registration, lifecycle shutdown hooks, resource discovery, and TUI tool rendering.
- SDK `AgentSession.compact()` with custom instructions and in-memory sessions.
- RPC JSONL framing and the `prompt`, `steer`, `follow_up`, `abort`, state, and event protocols.
- Model-registry authentication, fuzzy CLI-equivalent model resolution, thinking-level capability maps, and normal child resource inheritance.
- Pi's bundled subagent and custom-compaction examples as reference implementations for process invocation, output bounds, and compaction setup.

Major pieces intentionally not adopted include Pi's full interactive mode, session-replacement runtime, prompt-template workflows, custom provider implementations, and bundled role-based subagent profiles. No Pi source file or example was copied verbatim; the extension is original code using Pi's published APIs and adapting the documented architectural patterns.
