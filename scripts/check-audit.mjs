// `npm audit` for this repository's `@earendil-works/pi-*` devDependencies can surface a small,
// dated set of high/critical advisories that live entirely inside a nested `npm-shrinkwrap.json`
// published by `@earendil-works/pi-coding-agent`. A shrinkwrap file is a deliberate npm install
// boundary (see `npm help npm-shrinkwrap-json`): this project's `overrides` field cannot reach
// inside it, and bumping the pinned pi package does not help either — the same vulnerable nested
// versions are still present in the latest version published at the time each entry below was
// recorded. Each entry is scoped to an exact advisory, package, and node path so an unrelated or
// newly reachable instance of the same package/advisory still fails the gate.
//
// Review and prune this allowlist whenever `@earendil-works/pi-*` is upgraded: if `npm audit`
// output for an entry disappears, remove the entry.
import { execFileSync } from "node:child_process";

const ALLOWLIST = [
  {
    package: "brace-expansion",
    advisoryUrl: "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp",
    nodePathPrefix: "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
    recordedAt: "2026-07-20",
    reason:
      "Locked by @earendil-works/pi-coding-agent's published npm-shrinkwrap.json through at least 0.80.10; no override reaches inside a shrinkwrapped subtree.",
  },
  {
    package: "protobufjs",
    advisoryUrl: "https://github.com/advisories/GHSA-j3f2-48v5-ccww",
    nodePathPrefix: "node_modules/@earendil-works/pi-coding-agent/node_modules/protobufjs",
    recordedAt: "2026-07-20",
    reason:
      "Locked by @earendil-works/pi-coding-agent's published npm-shrinkwrap.json through at least 0.80.10; no override reaches inside a shrinkwrapped subtree.",
  },
];

function runAudit() {
  try {
    return execFileSync("npm", ["audit", "--json", "--registry=https://registry.npmjs.org/"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    // `npm audit` exits non-zero whenever it finds any vulnerability; its JSON report is still on stdout.
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout) : undefined;
    if (stdout) return stdout;
    throw error;
  }
}

const report = JSON.parse(runAudit());
const vulnerabilities = Object.values(report.vulnerabilities ?? {});
const blocking = vulnerabilities.filter((entry) => entry.severity === "high" || entry.severity === "critical");

const advisoryUrls = (entry) => (entry.via ?? []).filter((via) => typeof via === "object").map((via) => via.url);

const unexplained = [];
const accepted = [];
for (const entry of blocking) {
  const urls = advisoryUrls(entry);
  const nodes = Array.isArray(entry.nodes) ? entry.nodes : [];
  const match = ALLOWLIST.find(
    (allowed) =>
      allowed.package === entry.name &&
      urls.includes(allowed.advisoryUrl) &&
      nodes.length > 0 &&
      nodes.every((node) => node.startsWith(allowed.nodePathPrefix)),
  );
  if (match) accepted.push({ entry, match });
  else unexplained.push(entry);
}

for (const { match } of accepted) {
  console.log(
    `known upstream-locked advisory accepted: ${match.package} (${match.advisoryUrl}), recorded ${match.recordedAt} — ${match.reason}`,
  );
}

if (unexplained.length > 0) {
  console.error("npm audit found high/critical vulnerabilities that are not on the reviewed allowlist:");
  for (const entry of unexplained) {
    console.error(`- ${entry.name} (${entry.severity}): ${advisoryUrls(entry).join(", ") || "no advisory URL"}`);
    console.error(`  nodes: ${(entry.nodes ?? []).join(", ")}`);
  }
  process.exit(1);
}

const total = report.metadata?.vulnerabilities?.total ?? vulnerabilities.length;
console.log(`npm audit: ${String(total)} total finding(s), ${String(blocking.length)} high/critical, 0 unexplained`);
