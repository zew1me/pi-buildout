import { spawn } from "node:child_process";
import readline from "node:readline";

let streaming = false;
let prompts = 0;

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
	if (command.type === "abort") {
		streaming = false;
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
		streaming = true;
		send({ id: command.id, type: "response", command: "prompt", success: true });
		send({ type: "agent_start" });
		setTimeout(() => {
			if (String(command.message).includes("SPAWN_DESCENDANT")) {
				const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
				const text = `descendant:${descendant.pid}`;
				send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
				send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
				send({ type: "turn_end" });
			} else if (String(command.message).includes("FAIL_MODEL")) {
				send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "mock model failure" } });
			} else {
				send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `answer-${prompts}` } });
				send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `answer-${prompts}` }], stopReason: "stop" } });
				send({ type: "turn_end" });
			}
			streaming = false;
			send({ type: "agent_settled" });
		}, 15);
	}
});
