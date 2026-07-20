import { spawn } from "node:child_process";
import readline from "node:readline";

let streaming = false;
let prompts = 0;
let activeOperation = 0;
let abortFails = false;

/** @param {unknown} value */
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "extension_ui_response") return;
  if (command.type === "get_state") {
    send({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: { isStreaming: streaming, pendingMessageCount: 0, sessionFile: "/tmp/mock-child.jsonl" },
    });
    return;
  }
  if (command.type === "get_session_stats") {
    send({
      id: command.id,
      type: "response",
      command: "get_session_stats",
      success: true,
      data: {
        tokens: { input: 100, output: 25, cacheRead: 50, cacheWrite: 0, total: 175 },
        cost: 0.0123,
        contextUsage: { tokens: 2_000, contextWindow: 100_000, percent: 2 },
      },
    });
    return;
  }
  if (command.type === "abort") {
    if (abortFails) {
      send({ id: command.id, type: "response", command: "abort", success: false, error: "mock abort failure" });
      return;
    }
    streaming = false;
    activeOperation++;
    send({ id: command.id, type: "response", command: "abort", success: true });
    send({ type: "agent_settled" });
    return;
  }
  if (command.type === "steer" || command.type === "follow_up") {
    send({ id: command.id, type: "response", command: command.type, success: true });
    return;
  }
  if (command.type === "prompt") {
    prompts++;
    const promptNumber = prompts;
    const operation = ++activeOperation;
    streaming = true;
    abortFails = String(command.message).includes("ABORT_FAIL");
    send({ id: command.id, type: "response", command: "prompt", success: true });
    send({ type: "agent_start" });
    if (String(command.message).includes("SLOW_WAIT")) {
      send({ type: "tool_execution_start", toolCallId: "slow-tool", toolName: "bash", args: { command: "sleep" } });
    }
    setTimeout(
      () => {
        if (operation !== activeOperation || !streaming) return;
        if (String(command.message).includes("ABORTED_COMPACT")) {
          // An aborted compaction must not count toward the compaction total.
          send({ type: "compaction_end", aborted: true, result: undefined });
        } else if (String(command.message).includes("COMPACT")) {
          send({ type: "compaction_end", aborted: false, result: { tokensBefore: 10_000 } });
        }
        if (String(command.message).includes("SPAWN_DESCENDANT")) {
          const descendant = spawn(
            process.execPath,
            ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
            { stdio: "ignore" },
          );
          const text = `descendant:${descendant.pid}`;
          send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
          send({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
          });
          send({ type: "turn_end" });
        } else if (String(command.message).includes("FAIL_MODEL")) {
          send({
            type: "message_end",
            message: { role: "assistant", content: [], stopReason: "error", errorMessage: "mock model failure" },
          });
        } else {
          send({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: `answer-${promptNumber}` },
          });
          send({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: `answer-${promptNumber}` }],
              stopReason: "stop",
            },
          });
          send({ type: "turn_end" });
        }
        if (String(command.message).includes("SLOW_WAIT")) {
          send({ type: "tool_execution_end", toolCallId: "slow-tool", toolName: "bash", isError: false });
        }
        streaming = false;
        send({ type: "agent_settled" });
      },
      String(command.message).includes("SLOW_WAIT") ? 150 : 15,
    );
  }
});
