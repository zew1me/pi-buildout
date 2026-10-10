// Run npm's dependency audit while narrowly accepting reviewed findings that this repository cannot
// currently remediate. Every accepted direct finding is bound to an exact advisory and complete set
// of installed paths. New advisories, path changes, malformed reports, and audit transport failures
// all fail closed.
//
// Review and prune this allowlist whenever Pi or markdownlint-cli2's glob dependencies are upgraded.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const AUDIT_SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

const ALLOWLIST = [
  {
    package: "brace-expansion",
    advisoryUrl: "https://github.com/advisories/GHSA-qhr7-859c-m2p7",
    nodePaths: ["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"],
    recordedAt: "2026-10-08",
    reason:
      "Pi 0.85.1's published shrinkwrap pins brace-expansion 5.0.9 and ignores root overrides. Other installed copies are patched; Pi remains pinned for the versioned runtime patches.",
  },
  {
    package: "brace-expansion",
    advisoryUrl: "https://github.com/advisories/GHSA-6j4f-fj2g-mc7p",
    nodePaths: ["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"],
    recordedAt: "2026-10-08",
    reason:
      "Pi 0.85.1's published shrinkwrap pins brace-expansion 5.0.9 and ignores root overrides. Other installed copies are patched; Pi remains pinned for the versioned runtime patches.",
  },
  {
    package: "undici",
    advisoryUrl: "https://github.com/advisories/GHSA-rfgv-xxqx-mfg5",
    nodePaths: ["node_modules/@earendil-works/pi-coding-agent/node_modules/undici"],
    recordedAt: "2026-10-08",
    reason:
      "Pi 0.85.1's published shrinkwrap pins undici 8.9.0 and ignores root overrides. Updating Pi requires migrating the versioned runtime patches; CI's Pi tests use local mocks.",
  },
  {
    package: "undici",
    advisoryUrl: "https://github.com/advisories/GHSA-w293-vg96-wgc3",
    nodePaths: ["node_modules/@earendil-works/pi-coding-agent/node_modules/undici"],
    recordedAt: "2026-10-08",
    reason:
      "Pi 0.85.1's published shrinkwrap pins undici 8.9.0 and ignores root overrides. Updating Pi requires migrating the versioned runtime patches; CI's Pi tests use local mocks.",
  },
  {
    package: "braces",
    advisoryUrl: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
    nodePaths: ["node_modules/braces"],
    recordedAt: "2026-10-08",
    reason:
      "No patched braces release is published (latest is 3.0.3). The affected parser consumes glob patterns; markdownlint-cli2 uses repository-controlled patterns in local development and CI.",
  },
];

function runAudit() {
  try {
    return execFileSync("npm", ["audit", "--json", "--registry=https://registry.npmjs.org/"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    // npm audit exits non-zero for findings, but still writes a usable report to stdout.
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    if (stdout) return stdout;
    throw error;
  }
}

const advisoryObjects = (entry) => (entry.via ?? []).filter((via) => typeof via === "object" && via !== null);
const advisoryUrls = (entry) => advisoryObjects(entry).map((via) => via.url);
const sortedNodes = (entry) => (Array.isArray(entry.nodes) ? [...entry.nodes].sort() : []);
const sameStrings = (left, right) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isVulnerabilityEntry([key, entry]) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (key.length === 0 || entry.name !== key || !AUDIT_SEVERITIES.includes(entry.severity)) return false;
  if (
    !Array.isArray(entry.nodes) ||
    entry.nodes.length === 0 ||
    !entry.nodes.every((node) => typeof node === "string" && node.length > 0)
  ) {
    return false;
  }
  if (!Array.isArray(entry.via) || entry.via.length === 0) return false;
  return entry.via.every(
    (via) =>
      (typeof via === "string" && via.length > 0) ||
      (via !== null &&
        typeof via === "object" &&
        typeof via.url === "string" &&
        via.url.length > 0 &&
        AUDIT_SEVERITIES.includes(via.severity)),
  );
}

export function evaluateAudit(report, allowlist = ALLOWLIST) {
  const totals = report?.metadata?.vulnerabilities;
  const entries =
    report?.vulnerabilities && typeof report.vulnerabilities === "object" && !Array.isArray(report.vulnerabilities)
      ? Object.entries(report.vulnerabilities)
      : [];
  const validTotals =
    totals &&
    typeof totals === "object" &&
    AUDIT_SEVERITIES.every((severity) => isNonNegativeInteger(totals[severity])) &&
    isNonNegativeInteger(totals.total);
  const actualTotals = Object.fromEntries(
    AUDIT_SEVERITIES.map((severity) => [severity, entries.filter(([, entry]) => entry?.severity === severity).length]),
  );
  const totalsReconcile =
    validTotals &&
    totals.total === entries.length &&
    totals.total === AUDIT_SEVERITIES.reduce((sum, severity) => sum + totals[severity], 0) &&
    AUDIT_SEVERITIES.every((severity) => totals[severity] === actualTotals[severity]);

  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    report.error ||
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== "object" ||
    Array.isArray(report.vulnerabilities) ||
    !entries.every(isVulnerabilityEntry) ||
    !totalsReconcile
  ) {
    throw new Error("npm audit returned an invalid or unsuccessful report");
  }

  const vulnerabilities = entries.map(([, entry]) => entry);
  const blocking = vulnerabilities.filter((entry) => BLOCKING_SEVERITIES.has(entry.severity));
  const acceptedNames = new Set();
  const acceptedAdvisories = new Map();

  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of blocking) {
      if (acceptedNames.has(entry.name)) continue;

      const direct = advisoryObjects(entry).filter((via) => BLOCKING_SEVERITIES.has(via.severity));
      const sources = (entry.via ?? []).filter((via) => typeof via === "string");
      if (direct.length === 0 && sources.length === 0) continue;

      const nodes = sortedNodes(entry);
      const matches = direct.map((via) =>
        allowlist.find(
          (allowed) =>
            allowed.package === entry.name &&
            allowed.advisoryUrl === via.url &&
            nodes.length > 0 &&
            sameStrings(nodes, [...allowed.nodePaths].sort()),
        ),
      );
      const directAccepted = direct.length === 0 || matches.every(Boolean);
      const sourcesAccepted = sources.length === 0 || sources.every((source) => acceptedNames.has(source));
      if (!directAccepted || !sourcesAccepted) continue;

      acceptedNames.add(entry.name);
      for (const match of matches) {
        if (match) acceptedAdvisories.set(match.advisoryUrl, match);
      }
      changed = true;
    }
  }

  return {
    accepted: blocking.filter((entry) => acceptedNames.has(entry.name)),
    acceptedAdvisories: [...acceptedAdvisories.values()],
    blocking,
    total: report.metadata.vulnerabilities.total,
    unexplained: blocking.filter((entry) => !acceptedNames.has(entry.name)),
  };
}

function main() {
  const result = evaluateAudit(JSON.parse(runAudit()));

  for (const match of result.acceptedAdvisories) {
    console.log(
      `known reviewed advisory accepted: ${match.package} (${match.advisoryUrl}), recorded ${match.recordedAt} — ${match.reason}`,
    );
  }

  if (result.unexplained.length > 0) {
    console.error("npm audit found high/critical vulnerabilities that are not on the reviewed allowlist:");
    for (const entry of result.unexplained) {
      console.error(`- ${entry.name} (${entry.severity}): ${advisoryUrls(entry).join(", ") || "no advisory URL"}`);
      console.error(`  nodes: ${(entry.nodes ?? []).join(", ")}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `npm audit: ${String(result.total)} total finding(s), ${String(result.blocking.length)} high/critical, 0 unexplained`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
