# Browser Adapter Guidance

## Local Lessons

- Do not leak raw backend tab indices. Browser tab listings expose stable
  0-based visible tab indices after filtering internal Chrome targets, and
  select/close requests translate those visible indices to backend indices
  inside the adapter. Numeric select/close must fail closed when that mapping
  is missing or stale. Direct driver tab lists must return structured tab
  metadata; unstructured tab text is not trusted UI state.
- Treat Chrome internal targets by both URL and title. Omnibox popups can
  surface with a non-`chrome://` URL but title `Omnibox Popup`.
- `timeout_ms` must reach both budgets: the signed IPC deadline and the direct
  browser action deadline. Keep CDP connection identity stable across
  per-call timeout changes and pass the clamped request timeout to the direct
  action dispatch.
- Tab-set mutations such as tab close and new make any previous
  visible-index mapping stale unless the backend returns a fresh structured
  tab list that replaces the mapping.
- Headed pointer and screenshot actions should foreground the selected page
  immediately before backend dispatch with CDP `Target.activateTarget` plus
  page-level `Page.bringToFront`; target setup done earlier in the request is
  not enough for reliable headed Chrome interaction.
- Browser launch must rely on Chrome launch args, not a launch-time
  resize backend call. Use a nonzero `--window-size`, do not use
  `--remote-debugging-port=0`, and do not add
  `--disable-blink-features=AutomationControlled` because Chrome can show it as
  an unsupported command-line flag in the visible browser.
- Agent-facing browser launch is visible by default and must not expose a
  headless option. Any non-visible mode is an internal test harness detail, not
  a durable setting or browser tool argument.
- Persisted browser-session adoption must reject non-visible Chrome processes.
  Check the owned process command line for `--headless*` before adopting a
  stale CDP session, and relaunch visible Chrome instead.
- Browser usage enforcement must never block status, open, or close; those
  operations are observability and
  cleanup boundaries, not site-driving actions.
- Browser IPC authorization must be checked before usage settings lookup,
  active-tab resolution, backend dispatch, or usage metering. A stale signed
  request after Browser revocation must not consume per-site buckets.
- Browser usage enforcement for URL-less page actions must use the backend's
  current tab list, not the last explicit navigation payload or the
  first CDP target. In-page redirects, cross-site clicks, and multi-tab
  selection can otherwise bypass owner-defined per-site overrides.
- In enforce mode, a backend current-tab URL must normalize to a site before
  metering. Internal or local URLs such as `about:blank`, `chrome://...`, or
  `file://...` must fail closed instead of falling back to stale remembered
  site state.
- Direct browser navigation must not add adapter-level URL gates. Let the
  owner-managed Chrome profile navigate normally; only apply explicit owner
  browser-usage policy outside the direct browser driver.
- Resize viewport ownership belongs to the direct browser page after a page
  target exists. Do not use browser-level CDP
  `Emulation.setDeviceMetricsOverride` for viewport resize.
- Screenshot should use the direct browser page screenshot path, persist the
  image under the run browser artifact root, and return a
  compact file reference without inline base64.
- File upload should accept inline file content and materialize it under the
  run artifact root. Requiring agents to pre-create files there is not usable
  from restricted tool sandboxes.
- Check browser readiness before materializing inline upload files. A timed-out
  or unhealthy browser action must not leave background-created files behind.
  Inline uploads need bounded file count, per-file bytes, total bytes, and plain
  filenames only.
- Inline upload materialization must use collision-safe per-request paths.
  Duplicate filenames in one request, same-name concurrent requests, and
  existing files under `uploads/` must not overwrite or alias each other.
- Keep artifact path policy separate from action argument handling. File
  confinement is Gantry-owned safety policy; direct browser calls should see
  only already-confined absolute paths.
- Text-only backend tab lists are not trusted UI state. Tab projection consumes
  adapter-owned structured metadata only; missing metadata fails closed and
  clears stale visible-index mappings.
- Browser status is profile/session/CDP readiness only. It must not call model
  gateway or credential broker health; MCP and skill env vars come from Gantry
  Credentials rather than the model credential path.
- Browser deadline and artifact timestamp code should use the shared
  datetime helpers (`nowMs`/`nowIso`) instead of direct `Date.now()` or
  `new Date()` current-time reads so runtime timeout behavior stays
  deterministic under fake clocks and future clock injection.
- Browser tool output must be JSON-safe before SDK delivery. Sanitize
  unpaired UTF-16 surrogate code units in snapshots, evaluate results, tab
  metadata, errors, and any nested text returned by the browser adapter while
  preserving valid surrogate pairs such as emoji.
