# @upstart/pi-skills-patch

Requires Pi 1.0.1 or newer. Ships exact-version patches for Pi 1.0.3, 1.0.4, 1.1.0, 1.3.0, 1.4.0, 1.5.0, and 1.5.2.
Managed installs are located through the launcher's `install/current-version` file; npm bins, Homebrew wrappers, and
npm-backed shims are also supported.

Alpha standalone package for the versioned Pi `/skills` runtime patch. After installing this npm package globally from
the authenticated CodeArtifact registry (`npm install -g @upstart/pi-skills-patch@0.1.0-alpha.3`), run `pi-skills-patch`
to locate the installed `@earendil-works/pi-coding-agent`, verify the exact version and baseline checksums, and apply
the corresponding patch. It refuses unknown/mixed states. Set `PI_PACKAGE_DIR` when Pi cannot be located automatically.
**This modifies the installed Pi package; it does not install extensions.**

The router/OTel bundle is separate: `pi install npm:@upstart/pi-router-otel@0.1.1-alpha.8`. Clear, effort, backlinks,
and subagents have separate à-la-carte packages. See
[release instructions](https://github.com/nigel-upstart/pi-buildout/blob/main/packages/README.md) for all install and
manual release steps.
