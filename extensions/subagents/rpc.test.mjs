import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildKickoffPrompt, ManagedSubagent } from "./rpc.ts";

const mockPath = fileURLToPath(new URL("./mock-rpc-child.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("fresh kickoff omits the context wrapper when compaction is unavailable", () => {
	assert.equal(buildKickoffPrompt("Do the task", ""), "Task:\nDo the task");
	assert.match(buildKickoffPrompt("Do the task", "seed"), /<context>\nseed\n<\/context>/);
});

test("managed child starts, streams a bounded transcript, accepts more work, and stops", async (t) => {
	const child = new ManagedSubagent({
		id: "child123",
		name: "test-child",
		task: "do the task",
		model: "test/model",
		effort: "high",
		contextSummary: "relevant parent context",
		cwd: process.cwd(),
		command: process.execPath,
		args: [mockPath],
		env: { ...process.env },
		classification: "classified",
		classificationRationale: "test choice",
	});
	t.after(async () => child.stop());

	await child.start();
	assert.ok(["running", "idle"].includes(child.snapshot().state));
	await sleep(40);
	await child.refresh();
	let snapshot = child.snapshot();
	assert.equal(snapshot.state, "idle");
	assert.equal(snapshot.sessionFile, "/tmp/mock-child.jsonl");
	assert.equal(snapshot.lastAssistantText, "answer-1");
	assert.match(snapshot.transcriptTail, /answer-1/);

	await child.followUp("do one more thing");
	await sleep(40);
	snapshot = child.snapshot();
	assert.equal(snapshot.lastAssistantText, "answer-2");
	assert.equal(snapshot.turns, 2);

	await child.interrupt();
	assert.equal(child.snapshot().state, "idle");
	const stop = child.stop();
	const lateFollowUp = child.followUp("must not restart");
	await stop;
	await assert.rejects(lateFollowUp, /stopped.*cannot accept messages/);
	await child.stop();
	assert.equal(child.snapshot().state, "stopped");
});

test("stop terminates descendant processes, not only the Pi child", async (t) => {
	const child = new ManagedSubagent({
		id: "tree123",
		name: "tree-child",
		task: "SPAWN_DESCENDANT",
		model: "test/model",
		effort: "off",
		contextSummary: "",
		cwd: process.cwd(),
		command: process.execPath,
		args: [mockPath],
		env: { ...process.env },
		classification: "explicit",
	});
	t.after(async () => child.stop());
	await child.start();
	await sleep(60);
	const match = child.snapshot().transcriptTail.match(/descendant:(\d+)/);
	assert.ok(match);
	const descendantPid = Number(match[1]);
	process.kill(descendantPid, 0);
	await sleep(300); // let the descendant install its SIGTERM handler
	await child.stop();
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			process.kill(descendantPid, 0);
			await sleep(25);
		} catch (error) {
			assert.equal(error.code, "ESRCH");
			return;
		}
	}
	assert.fail(`descendant process ${descendantPid} survived stop`);
});

test("managed child preserves terminal model failures after agent_settled", async (t) => {
	const child = new ManagedSubagent({
		id: "failure123",
		name: "failing-child",
		task: "FAIL_MODEL",
		model: "test/model",
		effort: "low",
		contextSummary: "context",
		cwd: process.cwd(),
		command: process.execPath,
		args: [mockPath],
		env: { ...process.env },
		classification: "explicit",
	});
	t.after(async () => child.stop());
	await child.start();
	await sleep(40);
	const snapshot = child.snapshot();
	assert.equal(snapshot.state, "failed");
	assert.equal(snapshot.error, "mock model failure");
});
