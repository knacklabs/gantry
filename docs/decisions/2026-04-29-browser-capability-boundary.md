# Browser Capability Boundary

## Context

MyClaw launches a local Chrome session for agent use. The previous split let
the host launch the browser while the runner-side MyClaw MCP tool performed an
additional loopback CDP health check. That made local browser readiness depend
on the child runner's provider credential environment. In particular, provider
proxy variables can affect Node loopback HTTP calls when `NODE_USE_ENV_PROXY`
is enabled.

OpenClaw's browser implementation keeps lifecycle/status ownership in a browser
module and layers action routes on top. MyClaw should adopt that responsibility
boundary without importing OpenClaw's browser action stack.

## Decision

MyClaw's host runtime owns browser lifecycle and CDP readiness. The browser
capability is responsible for profile metadata, launch, close, status, CDP
health checks, stale-session recovery, active-session reuse, and shutdown
cleanup.

The end-to-end runtime flow is documented in
[browser-capability.md](../architecture/browser-capability.md).

MyClaw MCP exposes only lifecycle tools:

- `browser_profile_list`
- `browser_launch`
- `browser_status`
- `browser_close`

The runner-side MCP tool implementation is a signed IPC client. It does not
open direct CDP HTTP connections and does not decide browser health.

Browser actions such as click, type, navigate, snapshot, screenshot, and DOM
interaction remain owned by the runtime-installed `agent-browser` skill or
provider-native tooling. MyClaw does not add those action tools to its lifecycle
MCP surface. For the local Claude runtime, MyClaw installs `agent-browser` into
the generated per-run Claude config, registers the package-managed
`agent_browser` action MCP server through a host-owned browser run wiring
module, and projects the CDP endpoint into the child runner environment so that
action capability can attach.

The default local user experience is headed Chrome with the persistent `myclaw`
profile. Headless mode is opt-in for tests, CI, doctor checks, or other
non-interactive checks.

Provider proxy environment can still be passed to provider SDK execution.
Loopback browser traffic must bypass those proxies with explicit
`NO_PROXY`/`no_proxy` entries for `127.0.0.1`, `localhost`, and `::1`.

## Consequences

- Browser health bugs are diagnosed in the host browser capability, not in the
  runner MCP tool layer.
- MyClaw does not duplicate browser automation actions already provided by
  `agent-browser` or provider-native tools.
- Future browser action features must either integrate an existing browser
  tool/skill or add a separate browser-action adapter behind this boundary.
- Historical migration files can retain old names, but active host execution
  code should use run/process terminology rather than container terminology.
