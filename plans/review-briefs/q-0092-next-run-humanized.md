# Review brief — lite window Q-0092 (native terminal view shows a human-readable next run)

Facts: the first live run on the native renderers printed `Next run: 2026-08-26T12:35:00.000Z` — the view received the raw ISO string while the text path humanizes it via Intl.DateTimeFormat.

Contract for this diff:
- `formatJobNextRunAt` (exported from status-formatting.ts) is the single humanizer; `nextRunLabel` reuses it; the view's `nextRunAt` is the humanized string (omitted when the date is invalid).
- Provider renderers are untouched; every provider prints the same friendly time.

Focus: locale/timezone comes from the runtime process (same as the text path today) — do not propose per-user timezone plumbing here; invalid dates omit the line rather than printing 'Invalid Date'. Ignore style.
