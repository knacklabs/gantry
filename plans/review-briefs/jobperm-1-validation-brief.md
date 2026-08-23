# Validation brief: adversarially review the JOBPERM-1 design (design-doc review, not code review)

The bundle contains ONE new design document:
`plans/review-briefs/scheduled-job-permission-parity-design.md`.

You are validating a DESIGN, not a diff of code. Judge it as the staff engineer
who has to sign off before implementation. The owner's bar: "simple, best UX,
no compromise — a scheduled job must never lose accuracy because a tool was
blocked; ask the user like chat does, persist on approve, continue the run."

BINDING OWNER RULINGS (judge against these; do NOT re-litigate them):
1. The two "physics limits" in the design are OWNER-ACCEPTED tradeoffs:
   (a) remote-content-execution shapes are reformulation-only (no permanent
   approval), and (b) mid-run-granted unloadable tools land next run with a
   visibly-limited result ("Completed with limits") and a human-initiated
   [Run again now]. Checkpointed continuation and in-session dynamic
   reprojection are OUT of v1 BY OWNER DECISION (JOBPERM-2). Findings that
   demand them are out of scope; findings that the design fails to HONOR
   these rulings (e.g. an automatic rerun sneaking in, or a full-completion
   status on a limited run) are in scope.
2. No Allow-once anywhere in scheduled-job cards (owner ruling).
3. Single-cut implementation: the design's Deletions section is normative —
   flag any place the design would leave the old autonomous permission lane
   alive alongside the new path.
4. Best-effort one-visible-card with click-safety as the hard guarantee is
   the accepted product stance for providers where send identity cannot be
   proven.

Attack it on these axes; report every finding with the design section it hits:

1. SIMPLICITY: is any part over-built? Is there a simpler mechanism already in
   the codebase that achieves the same? Flag anything that adds a new concept
   where an existing one (interactive card, live-rule file, setup-pause wiring,
   run-lease heartbeat) already suffices. Equally: flag anywhere the design
   claims "just reuse X" but X actually can't do the job as claimed — verify
   the cited file:line anchors in the repo (you may read the code).
2. UX COMPLETENESS (user perspective): walk every path a user can experience —
   approve fast, approve after hours, deny, ignore, approve after the run died,
   two tools needing approval in one run, the same tool twice, parallel jobs
   asking at once, Telegram vs Slack vs Discord. Any path with a confusing,
   duplicated, or dead-ended experience is a finding. Especially: can the user
   ever see two live cards for one need? Can an approval ever be silently lost?
3. AGENT PERSPECTIVE: what does the model see while waiting (tool call just
   hangs)? On deny? On resume? Is the guidance text truthful and actionable in
   every branch? Does anything still gaslight the agent (allow-strings as
   denial reasons)?
4. SAFETY / AUTHORITY: does any part widen authority beyond what a human
   explicitly approves? Check the browser pre-approval claim ("the host would
   approve these five names anyway") against the actual coordinator code.
   Check the persistence path can't append requirements without a human
   decision. Check deny stays terminal. Check the pipe boundary and 0106
   (runs can't self-mutate jobs) survive.
5. FAILURE MODES: host restart mid-wait, runner SIGKILL mid-wait, lease-death
   race with a simultaneous approve, duplicate response files, the approval
   arriving after the degrade-to-pause transition, clock skew on the lease
   extension. For each: does the design's mechanism leave the system in a
   consistent, user-recoverable state?
6. SCOPE: is anything in the design unnecessary for the mandate? Is anything
   missing that the mandate requires (accuracy must not degrade because tools
   are unavailable — includes hidden/unprojected tools, not just denied ones)?

Do NOT rubber-stamp. If the design is sound, say so per-axis with the one or
two genuinely weakest points called out. Report concrete findings ranked by
severity; for each, the smallest change to the design that fixes it.
