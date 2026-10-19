import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionPackages = {
  clear: "clear",
  effort: "effort",
  "markdown-backlinks": "markdown-backlinks",
  subagents: "subagents",
};

const kind = process.argv[2];
if (kind !== "skills-patch" && !Object.hasOwn(extensionPackages, kind)) {
  throw new Error("Unknown Pi release package");
}

const destination = join(root, "packages", `pi-${kind}`, "dist");
await rm(destination, { recursive: true, force: true });

async function copy(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: false });
}

async function copyExtensionRuntime(extension) {
  const base = join(root, "extensions", extension);

  async function walk(relative = "") {
    for (const entry of await readdir(join(base, relative), { withFileTypes: true })) {
      const child = join(relative, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.isFile() || !child.endsWith(".ts") || child.includes(".test.")) continue;
      await copy(join(base, child), join(destination, "extensions", extension, child));
    }
  }

  await walk();
}

if (kind === "skills-patch") {
  const installer = join(destination, "scripts", "install-extensions.sh");
  await copy(join(root, "scripts", "install-extensions.sh"), installer);
  await chmod(installer, 0o755);

  for (const entry of await readdir(join(root, "patches"), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("pi-")) continue;
    for (const file of await readdir(join(root, "patches", entry.name), { withFileTypes: true })) {
      if (!file.isFile() || !/(?:\.(?:patch|sha256|absent)|-absent)$/u.test(file.name)) continue;
      await copy(join(root, "patches", entry.name, file.name), join(destination, "patches", entry.name, file.name));
    }
  }
} else {
  await copyExtensionRuntime(extensionPackages[kind]);
}

await copy(join(root, "ATTRIBUTION.md"), join(destination, "ATTRIBUTION.md"));
await copy(join(root, "LICENSE"), join(destination, "LICENSE"));
