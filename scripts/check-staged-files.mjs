import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const MAX_BYTES = 500 * 1024;
const BLOCKED_PATH_PARTS = new Set(["node_modules", ".serena", "router-telemetry"]);
const SECRET_PATTERNS = [
	{ label: "private key", pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
	{ label: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
	{ label: "GitHub personal access token", pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,})\b/ },
	{ label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
];

function stagedPaths() {
	const output = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]);
	return output.toString("utf8").split("\0").filter(Boolean);
}

function stagedContent(path) {
	return execFileSync("git", ["show", `:${path}`], { maxBuffer: MAX_BYTES * 2 });
}

const errors = [];
const paths = stagedPaths();
const caseFolded = new Map();

for (const path of paths) {
	const collision = caseFolded.get(path.toLowerCase());
	if (collision && collision !== path) errors.push(`${path}: case-conflicts with ${collision}`);
	caseFolded.set(path.toLowerCase(), path);

	const parts = path.split("/");
	if (parts.some((part) => BLOCKED_PATH_PARTS.has(part)))
		errors.push(`${path}: generated/local state must not be committed`);
	if (parts.at(-1)?.startsWith(".env") && !path.endsWith(".env.example"))
		errors.push(`${path}: environment files must not be committed`);

	const mode = execFileSync("git", ["ls-files", "--stage", "--", path], { encoding: "utf8" }).split(/\s+/, 1)[0];
	if (mode === "120000") {
		if (!existsSync(path) || !lstatSync(path).isSymbolicLink()) {
			errors.push(`${path}: staged symlink is missing from the working tree`);
			continue;
		}
		const target = resolve(dirname(path), readlinkSync(path));
		if (!existsSync(target)) errors.push(`${path}: symlink target does not exist (${target})`);
		continue;
	}

	let content;
	try {
		content = stagedContent(path);
	} catch (error) {
		errors.push(
			`${path}: could not inspect staged content (${error instanceof Error ? error.message : String(error)})`,
		);
		continue;
	}

	if (content.byteLength > MAX_BYTES) {
		errors.push(`${path}: ${content.byteLength} bytes exceeds the ${MAX_BYTES}-byte limit`);
		continue;
	}

	if (content.includes(0)) continue;
	const text = content.toString("utf8");

	if (/^(?:<{7}|={7}|>{7})(?: |$)/m.test(text)) errors.push(`${path}: contains an unresolved merge marker`);
	for (const { label, pattern } of SECRET_PATTERNS) {
		if (pattern.test(text)) errors.push(`${path}: appears to contain a ${label}`);
	}

	try {
		if (path.endsWith(".json")) JSON.parse(text);
		if (/\.ya?ml$/i.test(path)) parseYaml(text);
	} catch (error) {
		errors.push(`${path}: invalid structured data (${error instanceof Error ? error.message : String(error)})`);
	}
}

try {
	execFileSync("git", ["diff", "--cached", "--check"], { stdio: "pipe" });
} catch (error) {
	const stderr = error && typeof error === "object" && "stdout" in error ? String(error.stdout) : String(error);
	errors.push(`staged diff has whitespace errors:\n${stderr.trim()}`);
}

if (errors.length > 0) {
	console.error(errors.map((error) => `- ${error}`).join("\n"));
	process.exit(1);
}

console.log(`staged-file safety checks passed (${paths.length} files)`);
