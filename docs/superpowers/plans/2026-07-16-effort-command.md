# /effort Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global pi `/effort` extension command with a single-screen thinking-level picker and apply-mode toggle.

**Architecture:** Implement as a global extension at `~/.pi/agent/extensions/effort.ts`. Keep settings JSON manipulation
in pure exported helper functions so it can be tested independently with Node's built-in test runner.

**Tech Stack:** TypeScript pi extension API, `@earendil-works/pi-tui` components/key helpers, Node `fs`/`path`, Node
`node:test` for helper tests.

---

## File Structure

- Create: `/Users/nigelstuke/.pi/agent/extensions/effort.ts`
  - Registers `/effort`.
  - Defines thinking-level constants and apply-mode state.
  - Renders the custom selector UI.
  - Calls `pi.setThinkingLevel()`.
  - Persists `defaultThinkingLevel` to global settings when requested.
  - Exports pure helpers for testing.
- Create: `/Users/nigelstuke/.pi/agent/extensions/effort.test.mjs`
  - Tests helper behavior without requiring a running pi session.

## Tasks

### Task 1: Add helper tests first

**Files:**

- Create: `/Users/nigelstuke/.pi/agent/extensions/effort.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cycleApplyMode, updateDefaultThinkingLevelJson } from "./effort.ts";

describe("cycleApplyMode", () => {
  it("toggles from default mode to session-only mode", () => {
    assert.equal(cycleApplyMode("default"), "session");
  });

  it("toggles from session-only mode to default mode", () => {
    assert.equal(cycleApplyMode("session"), "default");
  });
});

describe("updateDefaultThinkingLevelJson", () => {
  it("sets defaultThinkingLevel while preserving existing settings", () => {
    const result = updateDefaultThinkingLevelJson('{"theme":"dark","defaultThinkingLevel":"low"}', "high");
    assert.deepEqual(JSON.parse(result.json), {
      theme: "dark",
      defaultThinkingLevel: "high",
    });
    assert.equal(result.hadParseError, false);
  });

  it("creates settings from an empty file", () => {
    const result = updateDefaultThinkingLevelJson("", "medium");
    assert.deepEqual(JSON.parse(result.json), {
      defaultThinkingLevel: "medium",
    });
    assert.equal(result.hadParseError, false);
  });

  it("recovers from invalid JSON and reports parse error", () => {
    const result = updateDefaultThinkingLevelJson("{not valid json", "minimal");
    assert.deepEqual(JSON.parse(result.json), {
      defaultThinkingLevel: "minimal",
    });
    assert.equal(result.hadParseError, true);
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node --test /Users/nigelstuke/.pi/agent/extensions/effort.test.mjs
```

Expected: FAIL because `./effort.ts` does not exist or does not export the helper functions.

### Task 2: Implement the extension and helpers

**Files:**

- Create: `/Users/nigelstuke/.pi/agent/extensions/effort.ts`

- [ ] **Step 1: Write implementation**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ApplyMode = "default" | "session";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "No extended reasoning",
  minimal: "Small reasoning budget",
  low: "Light reasoning",
  medium: "Balanced reasoning",
  high: "Deep reasoning",
  xhigh: "Very deep reasoning",
  max: "Maximum available reasoning",
};

export function cycleApplyMode(mode: ApplyMode): ApplyMode {
  return mode === "default" ? "session" : "default";
}

export function updateDefaultThinkingLevelJson(
  existingJson: string,
  level: ThinkingLevel,
): { json: string; hadParseError: boolean } {
  const trimmed = existingJson.trim();
  let settings: Record<string, unknown> = {};
  let hadParseError = false;

  if (trimmed.length > 0) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        settings = parsed;
      } else {
        hadParseError = true;
      }
    } catch {
      hadParseError = true;
    }
  }

  settings.defaultThinkingLevel = level;
  return { json: `${JSON.stringify(settings, null, 2)}\n`, hadParseError };
}

function applyModeLabel(mode: ApplyMode): string {
  return mode === "default" ? "Default + current session" : "Current session only";
}

function getModelLabel(ctx: { model: { provider?: string; id?: string } | undefined }): string {
  if (!ctx.model) return "current model";
  return [ctx.model.provider, ctx.model.id].filter(Boolean).join("/") || "current model";
}

function persistDefaultThinkingLevel(level: ThinkingLevel): { settingsPath: string; hadParseError: boolean } {
  const settingsPath = join(getAgentDir(), "settings.json");
  const existing = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";
  const result = updateDefaultThinkingLevelJson(existing, level);

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, result.json, "utf8");

  return { settingsPath, hadParseError: result.hadParseError };
}

export default function effortExtension(pi: ExtensionAPI) {
  pi.registerCommand("effort", {
    description: "Select thinking effort level",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/effort requires TUI mode", "error");
        return;
      }

      const currentLevel = pi.getThinkingLevel() as ThinkingLevel;
      let selectedIndex = Math.max(0, THINKING_LEVELS.indexOf(currentLevel));
      let applyMode: ApplyMode = "default";

      const selected = await ctx.ui.custom<{ level: ThinkingLevel; applyMode: ApplyMode } | null>(
        (tui, theme, _keybindings, done) => {
          const container = new Container();

          const component = {
            render(width: number): string[] {
              container.clear();
              container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
              container.addChild(
                new Text(theme.fg("accent", theme.bold(`Thinking effort for ${getModelLabel(ctx)}`)), 1, 0),
              );
              container.addChild(new Text("", 0, 0));

              for (let index = 0; index < THINKING_LEVELS.length; index++) {
                const level = THINKING_LEVELS[index];
                const isSelected = index === selectedIndex;
                const isCurrent = level === currentLevel;
                const prefix = isSelected ? "> " : "  ";
                const currentMarker = isCurrent ? "     Current" : "";
                const label = `${prefix}${level.padEnd(8)} ${DESCRIPTIONS[level]}${currentMarker}`;
                const styled = isSelected ? theme.fg("accent", label) : label;
                container.addChild(new Text(truncateToWidth(styled, Math.max(1, width - 2)), 1, 0));
              }

              container.addChild(new Text("", 0, 0));
              container.addChild(
                new Text(theme.fg("muted", `Apply: ${applyModeLabel(applyMode)}   (Space/←/→ toggle)`), 1, 0),
              );
              container.addChild(new Text(theme.fg("dim", "↑↓ navigate • Enter apply • Esc cancel"), 1, 0));
              container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
              return container.render(width);
            },
            invalidate(): void {
              container.invalidate();
            },
            handleInput(data: string): void {
              if (matchesKey(data, Key.up)) {
                selectedIndex = Math.max(0, selectedIndex - 1);
                tui.requestRender();
                return;
              }
              if (matchesKey(data, Key.down)) {
                selectedIndex = Math.min(THINKING_LEVELS.length - 1, selectedIndex + 1);
                tui.requestRender();
                return;
              }
              if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.space)) {
                applyMode = cycleApplyMode(applyMode);
                tui.requestRender();
                return;
              }
              if (matchesKey(data, Key.enter)) {
                done({ level: THINKING_LEVELS[selectedIndex], applyMode });
                return;
              }
              if (matchesKey(data, Key.escape)) {
                done(null);
              }
            },
          };

          return component;
        },
        { overlay: true },
      );

      if (!selected) return;

      pi.setThinkingLevel(selected.level);

      if (selected.applyMode === "session") {
        ctx.ui.notify(`Thinking effort set to ${selected.level} for current session`, "info");
        return;
      }

      try {
        const result = persistDefaultThinkingLevel(selected.level);
        if (result.hadParseError) {
          ctx.ui.notify(`Recreated invalid settings JSON at ${result.settingsPath}`, "warning");
        }
        ctx.ui.notify(`Thinking effort set to ${selected.level} and saved as default`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Thinking effort set for current session, but default save failed: ${message}`, "error");
      }
    },
  });
}
```

- [ ] **Step 2: Run tests to verify GREEN**

Run:

```bash
node --test /Users/nigelstuke/.pi/agent/extensions/effort.test.mjs
```

Expected: PASS.

### Task 3: Verify TypeScript/runtime compatibility

**Files:**

- Modify only if verification finds a compile/runtime import issue: `/Users/nigelstuke/.pi/agent/extensions/effort.ts`

- [ ] **Step 1: Run TypeScript syntax/type check**

Run:

```bash
cd /opt/homebrew/Cellar/pi-coding-agent/0.80.6/libexec/lib/node_modules/@earendil-works/pi-coding-agent \
  && npx tsc --noEmit --allowImportingTsExtensions /Users/nigelstuke/.pi/agent/extensions/effort.ts
```

Expected: TypeScript completes without errors, or reports only project-wide unrelated errors. If extension-specific
errors appear, fix them.

- [ ] **Step 2: Run pi reload/manual smoke test**

Run inside an interactive pi session:

```text
/reload
/effort
```

Expected: `/effort` appears and opens the custom selector. Space toggles apply mode; Enter applies; Esc cancels.
