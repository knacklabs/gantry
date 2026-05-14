# Browser Capability Boundary

## Context

MyClaw launches a local Chrome session for agent use. The previous split let
the host launch the browser while the runner-side MyClaw MCP tool performed an
additional loopback CDP health check. That made local browser readiness depend
on the child runner's provider credential environment. In particular, provider
proxy variables affected Node loopback HTTP calls when `NODE_USE_ENV_PROXY`
was enabled.

The reference browser implementation keeps lifecycle/status ownership in a
browser module and layers action routes on top. MyClaw should adopt that
responsibility boundary without importing a separate browser action stack.

## Decision

MyClaw's host runtime owns browser lifecycle and CDP readiness. The browser
capability is responsible for profile metadata, launch, close, status, CDP
health checks, stale-session recovery, active-session reuse, and shutdown
cleanup.

The end-to-end runtime flow is documented in
[browser-capability.md](../architecture/browser-capability.md).

When canonical `Browser` is selected, MyClaw MCP exposes projected
MyClaw-owned browser tools:

- `browser_status`
- `browser_open`
- `browser_inspect`
- `browser_act`
- `browser_close`

The runner-side MCP tool implementation is a signed IPC client. It does not
open direct CDP HTTP connections and does not decide browser health.

Browser open, inspect, and act operations are concrete runtime projections of
the one durable `Browser` capability. The host may use a package-managed browser
backend internally, but private backend names and concrete browser subtool names
are not persisted as durable authority. Durable settings and database bindings
store only `Browser`; gateway tool names are audited runtime facts.

The default local user experience is visible Chrome with the persistent
`myclaw` profile. Agent-facing browser tools do not expose a headless launch
option; non-visible modes are internal test harness details only and must not
become durable settings or model-facing tool choices.

Local provider proxy environment may be used only for model credential
transport to the Claude SDK process, with SDK subprocess env scrubbing enabled.
Tool, browser, and MCP proxy credentials require explicit capability
projections. Loopback browser traffic still receives explicit `NO_PROXY` and
`no_proxy` entries for `127.0.0.1`, `localhost`, and `::1`.

## Consequences

- Browser health bugs are diagnosed in the host browser capability, not in the
  runner MCP tool layer.
- MyClaw presents one stable durable capability even if the private backend or
  projected tool surface changes.
- Future browser action features must be added as projected tools under the
  canonical `Browser` capability boundary.
- Historical migration files can retain old names, but active host execution
  code should use run/process terminology rather than container terminology.
