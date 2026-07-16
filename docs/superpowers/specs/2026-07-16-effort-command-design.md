# /effort Command Design

## Goal
Add a `/effort` command to pi that opens a navigable menu for selecting the current thinking level, with a toggle to apply the selection either to the current session only or to both the current session and the global default.

## Approach
Implement this as a global pi extension in `~/.pi/agent/extensions/effort.ts` rather than modifying pi internals. Pi already exposes extension hooks for slash commands, custom TUI components, current thinking-level access, and runtime thinking-level updates.

## UI Behavior
`/effort` opens a single-screen TUI menu:

```text
Thinking effort for <provider>/<model>

  off
  minimal
  low
> medium     Current
  high
  xhigh
  max

Apply: Default + current session   (Space/←/→ to toggle)
↑↓ navigate • Enter apply • Esc cancel
```

Keyboard behavior:
- Up/down changes the highlighted thinking level.
- Space, left, or right toggles apply mode.
- Enter applies the highlighted thinking level and exits.
- Escape cancels without changing anything.

Default apply mode is `Default + current session`.

## Data Flow
When the user applies a level:
1. The extension calls `pi.setThinkingLevel(level)` to update the active pi runtime. Pi handles model-specific clamping.
2. If apply mode is `Default + current session`, the extension updates `~/.pi/agent/settings.json`, setting `defaultThinkingLevel` to the selected level while preserving all other settings.
3. The extension shows a notification summarizing what changed.

## Error Handling
- If `/effort` is invoked outside TUI mode, show an error notification.
- If `settings.json` cannot be read or parsed, treat it as `{}` but preserve the failure as a warning notification before writing.
- If writing `settings.json` fails, keep the runtime change and show an error notification.
- If no current model is available, show `current model` in the title rather than failing.

## Testing
Unit-test pure helpers for:
- Cycling apply modes.
- Producing a settings JSON string that preserves existing keys and sets `defaultThinkingLevel`.
- Handling empty or invalid settings JSON.

Manually verify in pi:
- `/reload` loads the extension.
- `/effort` opens the menu.
- Enter applies the selected effort.
- Space toggles between default and current-session-only modes.
- Default mode writes `~/.pi/agent/settings.json`.
