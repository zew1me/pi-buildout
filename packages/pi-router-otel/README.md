# @upstart/pi-router-otel

Alpha Pi package for the router and its vendored OTel companion. `pi install npm:@upstart/pi-router-otel@0.1.1-alpha.8`
loads both extensions with their runtime dependencies. The independent clear, effort, backlinks, and subagents
extensions are separate à-la-carte packages. It does **not** apply the separate `/skills` runtime patch.

OTel is **on by default** and exports traces, metrics, and logs to `https://corp-otel-staging-1.upstart.com` using
`http/protobuf`, GenAI span names, `pi-coding-agent` as the service, and **full prompt/tool content capture**. Review
this before installation. Set `PI_OTEL_DISABLED=1` (or `otel.enabled=false` in Pi settings) to disable export, or
override individual OTel settings. If `npm:pi-otel` is installed separately, remove it first to avoid duplicate
instrumentation.

The fork retains its Apache-2.0 license in `dist/extensions/otel/LICENSE`; attribution is in `dist/ATTRIBUTION.md`. For
release steps and independent patch-package installation see
[release instructions](https://github.com/nigel-upstart/pi-buildout/blob/main/packages/README.md).
