# ASKFLOOR-1 — UX plan validation (Fable lane) — read-only, no edits, emit under ~900 words

You are validating the USER EXPERIENCE of a permission-classifier redesign for "gantry", a personal AI runtime that chats through Telegram/Slack/Discord/Teams. The owner's complaint (verbatim): "I have been tapping a lot of permissions which are very basic even including the attachment reading which I have sent. The classifier is something important without that we cannot make gantry stable. It should resemble how efficiently your auto classifier works" — i.e. Claude Code's auto mode: reads never ask, the classifier judges unknowns, only genuine risk asks, and a human's decision is learned.

Read ONLY:
1. `docs/specs/askfloor-1-judge-actually-judges.md` (the spec under validation; Behaviour §1–3, the live-evidence block, and the acceptance criteria AC1–AC7)
2. `plans/exploration/askfloor-1-runtime-evidence-2026-09-02.md` (what actually happened in the logs)
3. `plans/exploration/classifier-automode-consolidated.md` (the gap analysis and change set)
4. `docs/decisions/0040-*.md`, `0043-*.md`, `0121-*.md`, `0052-*.md` if present (the constraints the spec must respect — do not propose violating them)

Validate the spec as a PRODUCT/UX plan, not as code. For each scenario below, state (a) how many taps the owner gets today per the evidence, (b) how many under the spec, (c) whether the spec's wording actually guarantees (b) or merely implies it, (d) the exact prompt copy/shape you recommend when a tap IS warranted:
- S1 Owner sends a PDF in Telegram and says "summarise this" (today: 3 taps).
- S2 Agent runs `cd ~/Workdir/some-repo && ls && git log --oneline -3` (today: 1 tap per command, ~10 in 3 min).
- S3 Agent runs a compound read with `2>/dev/null` and a `find` without `-exec`.
- S4 Agent wants to write a file inside the workspace / delete a file / run `npm install` / `rm -rf` (which of these should ask, with what copy).
- S5 Owner taps a decision: what is the DEFAULT button, what is learned, how the owner can see/undo what was learned, and how a learned decision is invalidated when rails change.
- S6 The classifier is down (AC5): what the owner sees, in plain English, and what the agent does.
- S7 A scheduled job (no human present) hits the same cases — what changes.

Then give: (1) a prioritized list of UX polish items (copy, defaults, tap budget per scenario, undo/inspect surface, silence rules) with the smallest spec wording change for each; (2) anything in the spec that would still feel "un-Claude-Code-like" to the owner; (3) any contradiction between the spec's Not-in-scope (shared rails untouched; send_message excluded) and the owner's expectation, stated plainly. End with "UX VALIDATION COMPLETE: <N> polish items, <M> contradictions".
