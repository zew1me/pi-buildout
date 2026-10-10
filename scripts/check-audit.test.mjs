import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateAudit } from "./check-audit.mjs";

const braceNodes = ["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"];

function auditReport() {
  return {
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 6, critical: 0, total: 6 } },
    vulnerabilities: {
      "brace-expansion": {
        name: "brace-expansion",
        severity: "high",
        nodes: [...braceNodes],
        via: [
          {
            severity: "high",
            url: "https://github.com/advisories/GHSA-qhr7-859c-m2p7",
          },
          {
            severity: "high",
            url: "https://github.com/advisories/GHSA-6j4f-fj2g-mc7p",
          },
        ],
      },
      undici: {
        name: "undici",
        severity: "high",
        nodes: ["node_modules/@earendil-works/pi-coding-agent/node_modules/undici"],
        via: [
          {
            severity: "high",
            url: "https://github.com/advisories/GHSA-rfgv-xxqx-mfg5",
          },
          {
            severity: "high",
            url: "https://github.com/advisories/GHSA-w293-vg96-wgc3",
          },
        ],
      },
      braces: {
        name: "braces",
        severity: "high",
        nodes: ["node_modules/braces"],
        via: [{ severity: "high", url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm" }],
      },
      micromatch: {
        name: "micromatch",
        severity: "high",
        nodes: ["node_modules/micromatch"],
        via: ["braces"],
      },
      minimatch: {
        name: "minimatch",
        severity: "high",
        nodes: ["node_modules/minimatch"],
        via: ["brace-expansion"],
      },
      eslint: {
        name: "eslint",
        severity: "high",
        nodes: ["node_modules/eslint"],
        via: ["minimatch"],
      },
    },
  };
}

describe("evaluateAudit", () => {
  it("accepts reviewed direct advisories and findings derived only from them", () => {
    const result = evaluateAudit(auditReport());

    assert.equal(result.unexplained.length, 0);
    assert.deepEqual(result.acceptedAdvisories.map(({ advisoryUrl }) => advisoryUrl).sort(), [
      "https://github.com/advisories/GHSA-6j4f-fj2g-mc7p",
      "https://github.com/advisories/GHSA-qhr7-859c-m2p7",
      "https://github.com/advisories/GHSA-rfgv-xxqx-mfg5",
      "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
      "https://github.com/advisories/GHSA-w293-vg96-wgc3",
    ]);
  });

  it("fails closed when npm groups a new advisory with reviewed advisories", () => {
    const report = auditReport();
    report.vulnerabilities["brace-expansion"].via.push({
      severity: "critical",
      url: "https://github.com/advisories/GHSA-unreviewed",
    });

    const result = evaluateAudit(report);

    assert.deepEqual(result.unexplained.map(({ name }) => name).sort(), ["brace-expansion", "eslint", "minimatch"]);
  });

  it("fails closed when a reviewed advisory appears at a different path", () => {
    const report = auditReport();
    report.vulnerabilities["brace-expansion"].nodes.push("node_modules/new-consumer/node_modules/brace-expansion");

    assert.equal(evaluateAudit(report).unexplained.length, 3);
  });

  it("rejects an additional braces install and its derived findings", () => {
    const report = auditReport();
    report.vulnerabilities.braces.nodes.push("node_modules/new-consumer/node_modules/braces");

    assert.deepEqual(
      evaluateAudit(report)
        .unexplained.map(({ name }) => name)
        .sort(),
      ["braces", "micromatch"],
    );
  });

  it("rejects unsuccessful or malformed npm audit reports", () => {
    assert.throws(() => evaluateAudit({ error: { summary: "registry unavailable" } }), /invalid or unsuccessful/);
  });

  it("fails closed when positive totals have missing or malformed vulnerability entries", () => {
    const totals = { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 };

    assert.throws(() => evaluateAudit({ metadata: { vulnerabilities: totals }, vulnerabilities: {} }), /invalid/);
    assert.throws(
      () => evaluateAudit({ metadata: { vulnerabilities: totals }, vulnerabilities: { minimatch: null } }),
      /invalid/,
    );
  });
});
