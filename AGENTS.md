# Pi Buildout 

Monorepo of pi tooling to modify vanilla pi.

## Before making changes

Install the repository's Lefthook configuration as Git hooks before modifying tracked files:

```bash
lefthook install
```

The pre-push hook runs the same full quality suite as CI. Run it directly when needed:

```bash
./scripts/test.sh
```
