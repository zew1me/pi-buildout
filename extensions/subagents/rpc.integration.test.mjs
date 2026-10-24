import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ManagedSubagent } from "./rpc.ts";

const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const packageRoot = dirname(dirname(packageEntry));
const piCli = join(packageRoot, "dist", "bundle", "cli.js");
const providerExtension = fileURLToPath(new URL("./rpc.integration-provider.mjs", import.meta.url));
const timeoutMs = 30_000;
const followUpMarker = "FOLLOW_UP_RPC_MARKER";

/** @param {() => boolean} predicate @param {string} label @param {AbortSignal} signal */
async function waitFor(predicate, label, signal) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    signal.throwIfAborted();
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A tiny OpenAI-compatible streaming endpoint so this test needs no credentials or network.
 * `holdNextResponse` keeps one completion in flight so the test can act while Pi is streaming.
 */
function createCompletionServer() {
  /** @type {unknown[]} */
  const requests = [];
  /** @type {(() => void)[]} */
  const held = [];
  let holdNext = false;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(JSON.parse(body));
      if (holdNext) {
        holdNext = false;
        held.push(() => streamAnswer(response));
      } else streamAnswer(response);
    });
  });
  return {
    server,
    requests,
    holdNextResponse: () => {
      holdNext = true;
    },
    releaseHeld: () => {
      for (const respond of held.splice(0)) respond();
    },
  };
}

/** @param {import("node:http").ServerResponse} response */
function streamAnswer(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`);
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "rpc integration answer" } }] })}\n\n`,
  );
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

test(
  "ManagedSubagent speaks Pi's real RPC protocol for prompt, follow-up, state, stats, and shutdown",
  {
    timeout: 90_000,
  },
  async (t) => {
    const installed = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const repository = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    assert.equal(
      installed.version,
      repository.devDependencies["@earendil-works/pi-coding-agent"],
      "the integration test must launch the repository-pinned Pi version",
    );
    t.diagnostic(`Real Pi RPC version: ${installed.version}`);

    const { server, requests, holdNextResponse, releaseHeld } = createCompletionServer();
    /** @type {string | undefined} */
    let tempDir;
    /** @type {ManagedSubagent | undefined} */
    let child;
    // Register before any resource acquisition, including listen/spawn failures.
    t.after(async () => {
      if (child?.snapshot().error) t.diagnostic(child.snapshot().stderr ?? "Child failed without stderr");
      try {
        await child?.stop();
      } finally {
        try {
          if (server.listening) {
            await new Promise((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve(undefined)));
              // A failed assertion can leave a held completion or keep-alive socket.
              server.closeAllConnections();
            });
          }
        } finally {
          if (tempDir) await rm(tempDir, { recursive: true, force: true });
        }
      }
    });
    tempDir = await mkdtemp(join(tmpdir(), "pi-subagent-rpc-integration-"));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(undefined));
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    child = new ManagedSubagent({
      id: "piRpcIT001",
      name: "pi-rpc-integration",
      task: "Return the integration answer",
      model: "rpc-test/integration-model",
      effort: "off",
      contextSummary: "",
      cwd: tempDir,
      command: process.execPath,
      args: [
        piCli,
        "--mode",
        "rpc",
        "--session-dir",
        join(tempDir, "sessions"),
        "--name",
        "rpc-integration",
        "--model",
        "rpc-test/integration-model",
        "--thinking",
        "off",
        "--extension",
        providerExtension,
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-tools",
        "--no-session",
        "--approve",
      ],
      env: {
        ...process.env,
        PI_RPC_TEST_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        PI_RPC_TEST_API_KEY: "integration-test-only",
        PI_OFFLINE: "1",
        // Never read or mutate the developer's settings, auth, trust, or packages.
        PI_CODING_AGENT_DIR: join(tempDir, "agent"),
      },
      classification: "explicit",
    });

    await child.start();
    assert.equal(await child.waitForIdle(timeoutMs, t.signal), true, "initial prompt should settle through Pi RPC");
    await child.refresh();
    let snapshot = child.snapshot();
    assert.equal(snapshot.state, "idle");
    assert.equal(snapshot.lastAssistantText, "rpc integration answer");
    assert.equal(snapshot.error, undefined);
    assert.ok(snapshot.stats, "get_session_stats should return actual Pi session stats");
    assert.equal(requests.length, 1, "Pi should make one request to the local deterministic provider");

    // An idle child is re-prompted with `prompt`. Hold that completion in flight so the next
    // followUp() runs while Pi is streaming and therefore sends the real `follow_up` RPC command.
    holdNextResponse();
    await child.followUp("Run a second deterministic prompt");
    await waitFor(() => requests.length === 2, "Pi to request the second completion", t.signal);
    assert.equal(child.snapshot().state, "running", "the child must be streaming before follow_up");
    await child.followUp(`Queued follow-up ${followUpMarker}`);
    releaseHeld();
    await waitFor(
      () => {
        const current = child?.snapshot();
        return requests.length >= 3 && !!current && current.turns >= 3 && current.state === "idle";
      },
      "the queued follow_up turn to complete",
      t.signal,
    );
    assert.equal(requests.length, 3, "the queued follow_up should produce exactly one more model request");
    assert.match(JSON.stringify(requests[2]), new RegExp(followUpMarker), "follow_up text should reach the model");
    await child.refresh();
    snapshot = child.snapshot();
    assert.equal(snapshot.state, "idle");
    assert.equal(snapshot.pendingMessages, 0, "Pi should report the follow_up queue as drained");
    assert.equal(snapshot.turns, 3);
    assert.equal(snapshot.lastAssistantText, "rpc integration answer");
    assert.equal(snapshot.error, undefined);

    await child.stop();
    assert.equal(child.snapshot().state, "stopped", "stop should close the real Pi RPC process cleanly");
  },
);
