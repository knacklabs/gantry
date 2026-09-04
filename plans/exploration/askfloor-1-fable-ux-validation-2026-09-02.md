# ASKFLOOR-1 — Fable 5.1 (high) UX validation, 2026-09-02 (read-only; brief: askfloor-1-fable-ux-validation-brief.md)

## Scenario table (taps today → under spec; guaranteed?)
- S1 PDF sent in Telegram, "summarise this": 3 → **1–2, guaranteed to still ask** — §2 keeps "attachment reads" in the fail-closed list; AC3 hashing is per-attachment so the tap never goes away. Recommended: none; if kept: "Can I read the PDF you just sent (report.pdf)? [Yes] [No]".
- S2 `cd ~/Workdir/repo && ls && git log`: 10 → **0 expected, not guaranteed** — AC4 guarantees routing to the classifier, not the allow; `~/Workdir` never learned as a root, so every distinct command is an LLM round-trip. Copy if asked: "I'd like to look around ~/Workdir/repo (ls, git log). Read-only. [Allow] [Allow this folder from now on] [No]".
- S3 `2>/dev/null` + `find`: 2 → 0 (redirect, guaranteed by parser fix) / 0 (find, via classifier only; on a job it can never be granted).
- S4 write in workspace / delete / npm install / rm -rf: **the spec is silent on FileWrite/Edit** — the most common Claude-Code-auto action has no story. Destructive keeps asking (0040) — fine; no "remember" button on destructive. Copy examples given.
- S5 owner taps: §1 says BOTH Allow-once and Allow-future are learned → "Allow once" silently becomes forever (contradicts 0040/0043 notes: human Allow once never reusable). No inspect/undo surface; rails-bump invalidation is silent. Recommended buttons: **[Allow]** (remembered, default) [Just this once] [No]; re-ask copy: "Asking again — the safety rules were updated since you last allowed this."
- S6 classifier down (AC5): fail-closed guaranteed, but reads outside roots depend on the classifier → an outage turns every `ls` into a tap (storm). Recommended: one notice per conversation ("My safety judge is offline, so I'll check with you more than usual until it's back") + one-line card reason; deterministic read-only proofs must still allow without the classifier.
- S7 scheduled job: **spec contradicts itself** — §1 "learned records never consulted by the autonomous lane" vs AC3 "so a scheduled job stops re-asking every run" (0121: jobId-bearing → no classifier, no memory). One must give.

## Prioritized polish items (smallest wording change)
1. Owner-sent attachments are never a tap — §2: "attachment reads NOT sent by the requester in this conversation". S1 → 0.
2. Fix S7: delete the scheduled-job sentence from AC3, OR amend §1 to "consulted by the autonomous lane as a declared grant" + a 0121 amendment.
3. Button labels match learning — §1: "Allow-once is NOT learned; the learned outcome is the default button, labelled Allow."
4. "This folder" scope on the tap (0040 scopes once/this-folder/standing) — learned as a trusted root; S2 → 0 without LLM round-trips; removes the S6 storm.
5. Inspect/undo — "learned records are listable and revocable by the owner (/permissions → Forget this)".
6. Invalidation copy — a rails-invalidation re-ask states the reason on the card.
7. Silence rule for S6 — one degraded-mode notice per conversation; deterministic read-only proofs still allow without the classifier.
8. Workspace file writes — §2: "FileWrite/Edit inside unprotected workspace scope is judged arg-aware (path), not by identity."
9. Tap budget as acceptance — AC8: S1 = 0, S2 = 0, S3 = 0 taps in auto mode, proven by fixtures replaying the 2026-09-02 log shapes.

## Still un-Claude-Code-like
Reads are an LLM call, not a deterministic yes (root cause: shared rails untouched + roots never learned); "Allow once" that quietly remembers; no /permissions view; no plan for workspace edits; a degraded judge degrades reads too.

## Contradictions (Not-in-scope vs owner expectation)
1. Attachment reads excluded from auto-allow while the complaint is specifically about them.
2. Scheduled jobs: AC3 vs §1/0121.
3. Shared rails untouched → trusted roots stay unlearned → "reads never ask" only via the LLM, not structurally.
4. send_message: no contradiction (already birthright per 0052) — say so plainly to end scope debates.

UX VALIDATION COMPLETE: 9 polish items, 3 contradictions
