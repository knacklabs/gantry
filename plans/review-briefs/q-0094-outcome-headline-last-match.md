# Review brief — lite window Q-0094 (outcome headline lifts the last `Outcome:` match)

Facts: Q-0093 placed the `Outcome:` contract at the end of every scheduled run's prompt. Live run 21cfd366 (2026-08-26) honoured it — the final message began with `Outcome:` — but the summary handed to `jobOutcomeHeadline` is every assistant narration chunk of the run concatenated with no separators (`…to row 2037.Outcome: …`), so a first-line-only lifter never sees it.

Contract for this diff:
- `jobOutcomeHeadline(summary)` returns the trimmed text of the LAST `Outcome:` match anywhere in the summary (word boundary, case-insensitive, to end of line); `undefined` when absent or empty.
- The "Final Job Report / Scoring Summary" heading special case is deleted — it existed only to reach a first line and is subsumed by last-match.
- Nothing else changes: `selectJobNotificationSummary` keeps its other callers; renderers unchanged.

BY DESIGN: last match wins over any earlier "Outcome:" in narration — the contract is that the final message carries it. Ignore style.

Rounds: R1 CR line endings — accepted; R2 two markers on one line — accepted (split form); R3 U+2028/U+2029 line separators — REJECTED BY DESIGN: not a realistic shape for model chat output; CR/LF cover every real producer, and the marker split is unaffected.
