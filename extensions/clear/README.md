# `/clear`

Starts a replacement pi session, discarding the current conversation context. The new session includes a disclosure of current-directory `AGENTS.md` and `CLAUDE.md` files, active skills, and active tools.

The command uses pi's `newSession()` API, so it is safe for session persistence and extension lifecycle handling.

## Install

Run `scripts/install-extensions.sh` from the repository root, then use `/reload` in pi.

## Test

```bash
node --test extensions/clear/index.test.mjs
```
