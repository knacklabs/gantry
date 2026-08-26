# Review brief — lite window Q-0086 (honest wait copy on scheduled-job permission prompts)

Facts: classic permission prompts print "Reply in Nm" from the interactive timeout, but scheduled-job requests (`request.jobId` set) never expire on that timer — prompt-binding's resolveInteractionSettlementDelayMs returns undefined for jobId requests and the durable row lasts 24h. A live prompt (run fba3fbe7, 2026-08-26) said "Reply in 1m" for a job request; the run itself then hit the job timeout while waiting.

Contract for this diff:
- Prompt parts carry `waitsForDecision` (true when `request.jobId` is set). Every text variant in permission-interaction.ts and the Telegram HTML renderer print "This request stays open until you decide." (attributes the wait to the request, promises nothing about the run) instead of the "Reply in Nm" line when it is true; non-job prompts are unchanged.
- Slack's permission blocks are OUT OF SCOPE for this window (follow-up); do not report their "Reply in" line.
- No change to timers, rows, keyboards, or the durability wiring.

Focus: any remaining "Reply in" emission for job requests on Telegram (batch prompts, amendment prompts, full-view/split variants), and that the new copy is not misleading for a run that will time out at the job limit (it is the prompt that waits, not the run — wording must not promise the run stays alive). Ignore style.
