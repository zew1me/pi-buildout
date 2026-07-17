import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	type ApplyMode,
	cycleApplyMode,
	DESCRIPTIONS,
	THINKING_LEVELS,
	type ThinkingLevel,
	updateDefaultThinkingLevelJson,
} from "./helpers.ts";

export { cycleApplyMode, updateDefaultThinkingLevelJson } from "./helpers.ts";

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

			const reportedLevel = pi.getThinkingLevel();
			const currentLevel = THINKING_LEVELS.includes(reportedLevel as ThinkingLevel)
				? (reportedLevel as ThinkingLevel)
				: undefined;
			let selectedIndex = currentLevel ? THINKING_LEVELS.indexOf(currentLevel) : 0;
			let applyMode: ApplyMode = "default";

			const selected = await ctx.ui.custom<{ level: ThinkingLevel; applyMode: ApplyMode } | null>(
				(tui, theme, _keybindings, done) => {
					const container = new Container();

					return {
						render(width: number): string[] {
							container.clear();
							container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
							container.addChild(
								new Text(theme.fg("accent", theme.bold(`Thinking effort for ${getModelLabel(ctx)}`)), 1, 0),
							);
							container.addChild(new Text("", 0, 0));

							for (const [index, level] of THINKING_LEVELS.entries()) {
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
								const selectedLevel = THINKING_LEVELS[selectedIndex];
								if (selectedLevel) done({ level: selectedLevel, applyMode });
								return;
							}
							if (matchesKey(data, Key.escape)) {
								done(null);
							}
						},
					};
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
