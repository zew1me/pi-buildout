import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildKickoffPrompt, ManagedSubagent, parseSessionStats } from "./rpc.ts";

const mockPath = fileURLToPath(new URL("./mock-rpc-child.mjs", import.meta.url));
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("fresh kickoff omits the context wrapper when compaction is unavailable", () => {
  assert.equal(buildKickoffPrompt("Do the task", ""), "Task:\nDo the task");
  assert.match(buildKickoffPrompt("Do the task", "seed"), /<context>\nseed\n<\/context>/);
});

test("session stats parser validates and normalizes RPC data", () => {
  assert.equal(parseSessionStats(null), undefined);
  assert.deepEqual(
    parseSessionStats({
      tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
      cost: 0.25,
      contextUsage: { tokens: null, contextWindow: 8_000, percent: null },
    }),
    {
      tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
      cost: 0.25,
      contextUsage: { tokens: null, contextWindow: 8_000, percent: null },
    },
  );
});

test("managed child starts, streams a bounded transcript, accepts more work, and stops", async (t) => {
  const child = new ManagedSubagent({
    id: "child123",
    name: "test-child",
    task: "COMPACT do the task",
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
  assert.equal(await child.waitForIdle(500), true);
  await child.refresh();
  let snapshot = child.snapshot();
  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.sessionFile, "/tmp/mock-child.jsonl");
  assert.equal(snapshot.lastAssistantText, "answer-1");
  assert.match(snapshot.transcriptTail, /answer-1/);
  assert.equal(snapshot.compactions, 1);
  assert.equal(snapshot.stats?.tokens.total, 175);
  assert.equal(snapshot.stats?.contextUsage?.percent, 2);

  await child.followUp("do one more thing");
  await sleep(40);
  snapshot = child.snapshot();
  assert.equal(snapshot.lastAssistantText, "answer-2");
  assert.equal(snapshot.turns, 2);

  const stop = child.stop();
  const lateFollowUp = child.followUp("must not restart");
  await stop;
  await assert.rejects(lateFollowUp, /stopped.*cannot accept messages/);
  await child.stop();
  assert.equal(child.snapshot().state, "stopped");
});

test("RPC timeouts include child diagnostics and stderr", async (t) => {
  const child = new ManagedSubagent({
    id: "timeout123",
    name: "timeout-child",
    task: "do the task",
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

  const testOnlyChild =
    /** @type {{ request: (command: Record<string, unknown>, timeoutMs: number) => Promise<unknown> }} */ (
      /** @type {unknown} */ (child)
    );
  await assert.rejects(testOnlyChild.request({ type: "timeout" }, 100), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /RPC timeout/);
    assert.match(error.message, /child=timeout123/);
    assert.match(error.message, /pid=\d+/);
    assert.match(error.message, /model=test\/model/);
    assert.match(error.message, /exitCode=pending/);
    assert.match(error.message, /signal=none/);
    assert.match(error.message, /mock timeout diagnostic/);
    return true;
  });
});

test("synchronous RPC write failures include diagnostics and retire the pending request", async (t) => {
  const child = new ManagedSubagent({
    id: "write123",
    name: "write-failure-child",
    task: "do the task",
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

  const testOnlyChild =
    /** @type {{
     * request: (command: Record<string, unknown>, timeoutMs: number) => Promise<unknown>,
     * proc: import("node:child_process").ChildProcessWithoutNullStreams,
     * pending: Map<string, unknown>
     * }} */ (/** @type {unknown} */ (child));
  for (const failure of [new Error("mock synchronous write failure"), "mock non-Error write failure"]) {
    const write = t.mock.method(testOnlyChild.proc.stdin, "write", () => {
      throw failure;
    });
    try {
      await assert.rejects(testOnlyChild.request({ type: "get_state" }, 1_000), (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /RPC write failure for "get_state"/);
        assert.match(error.message, /mock .*write failure/);
        assert.match(error.message, /child=write123/);
        assert.match(error.message, /pid=\d+/);
        assert.match(error.message, /model=test\/model/);
        assert.match(error.message, /exitCode=pending/);
        assert.match(error.message, /signal=none/);
        return true;
      });
      assert.equal(testOnlyChild.pending.size, 0, "a failed write must not leave a request waiting for timeout");
    } finally {
      write.mock.restore();
    }
  }
  await child.refresh();
  assert.equal(child.snapshot().error, undefined, "a write failure alone must not fail the child");
});

test("unexpected child exits include process diagnostics and stderr", async (t) => {
  const child = new ManagedSubagent({
    id: "exit123",
    name: "exit-child",
    task: "EXIT_UNEXPECTED",
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

  await assert.rejects(child.start(), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /process closed unexpectedly/);
    assert.match(error.message, /child=exit123/);
    assert.match(error.message, /pid=\d+/);
    assert.match(error.message, /model=test\/model/);
    assert.match(error.message, /exitCode=17/);
    assert.match(error.message, /signal=none/);
    assert.match(error.message, /mock child fatal diagnostic/);
    return true;
  });
  assert.match(child.snapshot().error ?? "", /process closed unexpectedly/);
  assert.match(child.snapshot().stderr ?? "", /mock child fatal diagnostic/);
});

test("signal-terminated child exits do not report a pending exit code", async (t) => {
  const child = new ManagedSubagent({
    id: "signal123",
    name: "signal-child",
    task: "SIGNAL_UNEXPECTED",
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

  await assert.rejects(child.start(), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /process closed unexpectedly/);
    assert.match(error.message, /exitCode=none/);
    assert.match(error.message, /signal=SIGKILL/);
    assert.doesNotMatch(error.message, /exitCode=pending/);
    assert.match(error.message, /mock child signal diagnostic/);
    return true;
  });
});

test("managed child accepts Pi-sized image event lines above four MiB", async (t) => {
  const child = new ManagedSubagent({
    id: "large123",
    name: "large-line-child",
    task: "LARGE_RPC_LINE",
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
  assert.equal(await child.waitForIdle(2_000), true);
  const snapshot = child.snapshot();
  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.lastAssistantText, "large response accepted");
  assert.equal(snapshot.transcriptTail.length, 120_000);
  assert.match(snapshot.transcriptTail, /^x+$/);
  assert.equal(snapshot.error, undefined);
});

test("interrupt aborts an active child without accepting its delayed answer", async (t) => {
  const child = new ManagedSubagent({
    id: "interrupt1",
    name: "interrupt-child",
    task: "SLOW_WAIT",
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
  assert.equal(child.snapshot().state, "running");
  await child.interrupt();
  assert.equal(await child.waitForIdle(500), true);
  assert.equal(child.snapshot().state, "idle");
  await sleep(200);
  assert.equal(child.snapshot().lastAssistantText, undefined);
  assert.doesNotMatch(child.snapshot().transcriptTail, /answer-/);
});

test("wait times out without stopping the child", async (t) => {
  const child = new ManagedSubagent({
    id: "slow123",
    name: "slow-child",
    task: "SLOW_WAIT",
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
  assert.equal(await child.waitForIdle(10), false);
  assert.equal(child.snapshot().state, "running");
  assert.equal(child.snapshot().currentTool?.name, "bash");
  assert.equal(await child.waitForIdle(500), true);
  assert.equal(child.snapshot().lastAssistantText, "answer-1");
  assert.equal(child.snapshot().currentTool, undefined);
});

test("failed interrupt restores the child's prior state", async (t) => {
  const child = new ManagedSubagent({
    id: "abortfail1",
    name: "abort-failure-child",
    task: "SLOW_WAIT ABORT_FAIL",
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
  await assert.rejects(child.interrupt(), /mock abort failure/);
  assert.equal(child.snapshot().state, "running");
});

test("aborted compaction is not counted, and wait on a settled child returns at once", async (t) => {
  const child = new ManagedSubagent({
    id: "abort123",
    name: "abort-child",
    task: "ABORTED_COMPACT do the task",
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
  assert.equal(await child.waitForIdle(500), true);
  assert.equal(child.snapshot().compactions, 0);
  // A child that has already settled resolves the next wait synchronously.
  const before = Date.now();
  assert.equal(await child.waitForIdle(5_000), true);
  assert.ok(Date.now() - before < 200);
});

test("cleanup liveness probes distinguish absence from permission errors", (t) => {
  const probe = /** @type {{ pidIsAlive: (pid: number) => boolean }} */ (
    /** @type {unknown} */ (ManagedSubagent.prototype)
  );
  for (const code of ["ESRCH", "EPERM", "EACCES"]) {
    const mock = t.mock.method(process, "kill", () => {
      throw Object.assign(new Error(code), { code });
    });
    assert.equal(probe.pidIsAlive(-123), code !== "ESRCH", code);
    mock.mock.restore();
  }
});

/** @param {() => boolean} predicate @param {number} timeoutMs @param {string} message */
async function waitUntil(predicate, timeoutMs, message) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, message);
    await sleep(25);
  }
}

// The second regression exercises an owned Unix process group. Windows has no
// such group; its normal-stop test below instead exercises taskkill /T cleanup.
for (const crashBeforeTreeSample of process.platform === "win32" ? [false] : [false, true]) {
  const title = crashBeforeTreeSample
    ? "stop escalates an owned group even when the root exits before its descendants are sampled"
    : "stop terminates descendant processes, not only the Pi child";
  test(title, { timeout: 45_000 }, async () => {
    const token = randomUUID();
    const sockets = new Set();
    let descendantPid = 0;
    let descendantClosed = false;
    let sigterms = 0;
    const server = createServer((socket) => {
      sockets.add(socket);
      const lines = readline.createInterface({ input: socket });
      lines.on("line", (line) => {
        const event = JSON.parse(line);
        if (event.token !== token) return;
        if (event.type === "ready") {
          descendantPid = event.pid;
          socket.once("close", () => {
            descendantClosed = true;
          });
        }
        if (event.type === "sigterm") sigterms++;
      });
      socket.on("error", () => {});
    });
    let child;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      child = new ManagedSubagent({
        id: "tree123",
        name: "tree-child",
        task: "SPAWN_DESCENDANT",
        model: "test/model",
        effort: "off",
        contextSummary: "",
        cwd: process.cwd(),
        command: process.execPath,
        args: [mockPath],
        env: { ...process.env, PI_TEST_DESCENDANT_PORT: String(address.port), PI_TEST_DESCENDANT_TOKEN: token },
        classification: "explicit",
      });
      const testOnlyChild =
        /** @type {{ stopTreeMonitor?: () => void, proc: import("node:child_process").ChildProcess }} */ (
          /** @type {unknown} */ (child)
        );
      // Model a delayed/failed lifetime sample deterministically, without load
      // generators or changing production deadlines. The root's exit reparents
      // the descendant before the shutdown snapshot can find it by ancestry.
      if (crashBeforeTreeSample) testOnlyChild.stopTreeMonitor?.();
      await child.start();
      await waitUntil(() => descendantPid > 0, 10_000, "descendant did not install its SIGTERM handler");
      assert.equal(descendantClosed, false);
      process.kill(descendantPid, 0); // Access errors must fail, not imply death.
      assert.equal(await child.waitForIdle(10_000), true);
      const marker = child.snapshot().transcriptTail.match(/descendant:(\d+)/);
      assert.ok(marker);
      assert.equal(Number(marker[1]), descendantPid);
      if (crashBeforeTreeSample) {
        const exited = once(testOnlyChild.proc, "exit");
        assert.equal(testOnlyChild.proc.kill("SIGKILL"), true);
        await exited;
      }
      await child.stop();
      // This socket belongs directly to the descendant, not the root. Its EOF
      // proves execution terminated even if the OS has not reaped a zombie yet;
      // unlike kill(pid, 0), it does not confuse a zombie with a live process.
      await waitUntil(
        () => descendantClosed,
        5_000,
        `live descendant ${descendantPid} retained its connection after stop`,
      );
      // Windows taskkill has no POSIX signal-handler/escalation semantics. On
      // Unix the ready handler ignores TERM, so EOF also proves forced cleanup.
      if (process.platform !== "win32") assert.ok(sigterms > 0, "descendant never handled SIGTERM");
      assert.equal(child.snapshot().state, "stopped");
    } finally {
      try {
        await child?.stop();
      } finally {
        // Even readiness/assertion failures retire every owned fixture: existing
        // connections exit on EOF; late connects fail once the listener closes.
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve(undefined))));
      }
    }
  });
}

test("managed child treats an empty output-limit response as a failure", async (t) => {
  const child = new ManagedSubagent({
    id: "length123",
    name: "length-child",
    task: "EMPTY_LENGTH",
    model: "test/model",
    effort: "low",
    contextSummary: "",
    cwd: process.cwd(),
    command: process.execPath,
    args: [mockPath],
    env: { ...process.env },
    classification: "explicit",
  });
  t.after(async () => child.stop());

  await child.start();
  assert.equal(await child.waitForIdle(2_000), true);
  const snapshot = child.snapshot();
  assert.equal(snapshot.state, "failed");
  assert.equal(snapshot.error, "Child model exhausted its output token limit without producing text.");
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
