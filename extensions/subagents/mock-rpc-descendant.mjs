import { connect } from "node:net";

// A direct, authenticated connection to the test (not inherited from the Pi
// child) reports actual handler readiness and closes on execution termination.
const [port, token] = process.argv.slice(2);
const socket = connect(Number(port), "127.0.0.1");
/** @param {string} type */
const send = (type) => socket.write(`${JSON.stringify({ type, token, pid: process.pid })}\n`);
process.on("SIGTERM", () => send("sigterm"));
socket.on("connect", () => {
  send("ready");
  process.send?.("ready");
});
// Failure-path ownership: closing the test's connection or listener always
// retires this fixture, even if production cleanup missed it. No numeric PID
// from a failed assertion is ever blindly killed by the test.
socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(0));
setInterval(() => {}, 1_000);
