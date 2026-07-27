# `/effort`

Provides a TUI picker for pi's thinking level. Passing an exact supported level (for example, `/effort medium`) applies
it immediately to the current session without opening the picker. The picker can apply a selection only to the current
session or also update the global `defaultThinkingLevel` setting. Unknown arguments show a warning before opening the
picker.

With pi 0.82.0 and newer, the picker uses the current model's `reasoning` and provider-verified `thinkingLevelMap`
metadata, so unsupported effort levels are hidden and cannot be selected. A direct `/effort <level>` argument naming an
unsupported level is rejected with an error instead of being applied. Older pi versions retain the historical full list.

## Install

Run `scripts/install-extensions.sh` from the repository root, then use `/reload` in pi.

## Test

```bash
node --test extensions/effort/index.test.mjs
```
