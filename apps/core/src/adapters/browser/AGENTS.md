# Browser Adapter Guidance

## Local Lessons

- Do not leak raw backend tab indices. Browser tab listings expose stable
  0-based visible tab indices after filtering internal Chrome targets, and
  select/close requests translate those visible indices to backend indices
  inside the adapter. Numeric select/close must fail closed when that mapping
  is missing or stale. Backend-specific output compatibility, such as
  Playwright MCP markdown tab lists, belongs in a clearly named provider
  compatibility helper before the neutral tab projection consumes it.
- Treat Chrome internal targets by both URL and title. Omnibox popups can
  surface with a non-`chrome://` URL but title `Omnibox Popup`.
- `timeout_ms` must reach both budgets: the signed IPC/backend call timeout and
  the private Playwright MCP action budget. Keep backend process identity
  stable across per-call timeout changes; use a stable backend max/default
  action timeout and pass the clamped request timeout to `callTool`. The
  runner-facing browser MCP tools should default omitted `timeout_ms` to the
  same max/default budget so the signed IPC deadline cannot cut off the backend
  before Playwright's retry loop finishes.
- Tab-set mutations such as `browser_tabs` close and new make any previous
  visible-index mapping stale unless the backend returns a fresh structured
  tab list that replaces the mapping.
- Headed pointer and screenshot actions should foreground the selected page
  immediately before backend dispatch with CDP `Target.activateTarget` plus
  page-level `Page.bringToFront`; target setup done earlier in the request is
  not enough for reliable headed Chrome interaction.
- Headed Chrome launch must include an explicit nonzero window size. A 0x0
  inner viewport makes Playwright report every target outside the viewport and
  causes click, hover, and screenshot failures downstream.
- Headed `browser_resize` should resize the visible Chrome window with CDP
  `Browser.setWindowBounds` and force `windowState: normal` with the requested
  bounds. Keep headless and emulated resize behavior backend-native.
- `browser_file_upload` should accept inline file content and materialize it
  under the run artifact root. Requiring agents to pre-create files there is
  not usable from restricted tool sandboxes.
- Keep artifact path policy separate from provider argument compatibility.
  File confinement is MyClaw-owned safety policy; Playwright MCP field-shape
  enrichment is backend projection.
- Browser deadline and artifact timestamp code should use the shared
  datetime helpers (`nowMs`/`nowIso`) instead of direct `Date.now()` or
  `new Date()` current-time reads so runtime timeout behavior stays
  deterministic under fake clocks and future clock injection.
