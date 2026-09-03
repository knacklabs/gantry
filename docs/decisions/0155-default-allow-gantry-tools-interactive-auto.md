---
status: proposed
confirmed_by: ""
date: 2026-09-03
stories: [ASKFLOOR-1]
---

# Gantry-native tools auto-allow by default in interactive auto; only a closed high-risk list asks

## Context
`gantryToolDefaultRisk` (`application/permissions/gantry-tool-risk.ts:98`) short-circuits gantry-native tools with static buckets hard-coded to HIGH — every `send_message`, every `browser_*` mutation, scheduler and admin mutations, `file`, and every unmapped tool — so those tools always ask in auto mode and the classifier never judges them. That conservative posture dates from #212 / decision 0043 ("risk in classification, deterministic facts in rails") when the classifier was new. The live evidence of 2026-09-02 (ten taps in three minutes on reads; three taps to read an attachment) and the owner's bar ("behave like Claude Code auto mode") led the owner to rule on 2026-09-03: "auto-allow most of the gantry tools by default, including the browser; focus on simplification; unless high risk, auto allow the tools", and to name the high-risk set.

## Decision
In the interactive auto lane every gantry-native tool is LOW by default and auto-allows with typed provenance — all `browser_*` actions (status, inspect, navigate, click, type, press, select, evaluate, upload, dialogs, tabs, screenshot, wait), `file` list/read (entry protection enforced host-side), scheduler and admin READS, attachment tools. Only a CLOSED high-risk list stays HIGH and asks: (1) `send_message` to a destination that is not one of the agent's own registered channels (decision 0052 keeps own-channel messages birthright); (2) destructive or protected writes — delete/overwrite outside the agent workspace, or any protected or secret destination (`file` write/promote_scratch, native Write/Edit, judged by prospective-write containment); (3) scheduler mutations (create/update/delete jobs); (4) admin mutations (settings, permissions, agents; the authority-changing, dispatcher, delegation and decision-actor buckets are admin mutations). Anything the table cannot classify — unmapped tools, malformed shapes — is `ambiguous` and goes to the classifier; nothing is forced HIGH by identity any more. The posture is ONE small typed risk table with an exhaustive per-tool test. It applies to interactive auto only: the shared deterministic rails, ask mode, auto_strict and scheduled jobs (0121) are untouched.

## Consequences
- Re-calibrates 0043's static buckets (and the #212 posture) from "ask unless proven safe" to "allow unless on the high-risk list"; 0043's split — deterministic facts in rails, risk in classification — is preserved because the table is a deterministic fact and ambiguity still goes to the classifier.
- The closed browser verb matrix and per-argument `file` risk planned earlier are dropped; simpler code, one table to review.
- Browser payments and credential entry are NOT on the high-risk list by owner choice; if that proves wrong the list grows by one row and a test, never by reverting the posture.
- Every auto-allow is visible: typed provenance on the decision, the audit trail, and `/permissions` (decision 0154) show what allowed and why.
- Doors closed: no widening of the shared rails; no change to ask, auto_strict or job semantics; the high-risk list is closed and reviewed, not heuristic.
