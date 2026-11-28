# Pi 1.6.0 `/skills` patch

This patch makes skill activation opt-in for `@earendil-works/pi-coding-agent@1.6.0`. It uses the shared
[TypeScript overlay](../../pi-overlay) and a [version-specific integration patch](../../pi-overlay/versions/1.6.0/integration.patch).
Pi 1.6.0 changed the model-resolver import next to the CLI hook; the skill-management logic and CLI/RPC wrappers
are unchanged from 1.5.2.

The [upstream manifest](../../pi-overlay/versions/1.6.0/upstream.json) pins the source release and npm package.
The builder compares the unmodified source build with the published runtime, enforces the 48-line integration budget,
and verifies the patched files against `patched.sha256`. The installer checks `baseline.sha256` and `baseline.absent`
before applying the patch to a clean package. It can also migrate the original 1.6.0 patch from repository commit
`18417b6`, before `--directory` support, using the `pre-directory-scope` checksum and upgrade patch. Do not apply these
artifacts to another Pi version.

```bash
npm run patches:build -- --version 1.6.0
npm run patches:check -- --version 1.6.0
```

To test against a clean Pi 1.6.0 installation without modifying it:

```bash
PI_SKILLS_TEST_VERSION=1.6.0 PI_SKILLS_TEST_PACKAGE_DIR=/path/to/clean/pi-package \
  node --test scripts/skills-catalog.test.mjs
```
