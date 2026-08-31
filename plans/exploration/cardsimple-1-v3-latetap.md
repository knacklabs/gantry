# CARDSIMPLE-1 validation pass 3 of 4 — late-tap flow and handoff fanout (read-only, no edits)

Scope ONLY this question; keep reading tight. The draft spec `docs/specs/cardsimple-1-one-permission-surface.md` says: a tap on a permission card whose requesting run already ended records the grant, replies with one receipt line plus a Run now button, never auto-reruns, and never fans out handoff triggers per dead prior run.

Live bug 2026-08-31 to explain: ONE Allow tap on job `card-check-2` created THREE forever-pending `job_triggers` rows with requested_by kind `job_permission_handoff`, one per dead priorRunId (c20dd132, adab8dd8, 835e23e4). Find: (a) the fanout site that creates one handoff trigger per prior run; (b) why they stay pending forever (nothing dispatches them); (c) where — or whether — a tap whose run already ended is detected today. Cite file:line for each.

Output: numbered findings — claim, file:line, severity (blocker | design-gap | nit), smallest spec amendment. Nothing else.
