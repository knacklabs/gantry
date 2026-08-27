# Review brief — lite window Q-0091 (outcome headline contract, all jobs, all providers)

Owner direction: a user should get the OUTCOME first. Today the notice leads with tool tallies and a narration excerpt (the tail of the agent's stream) because StructuredJobResult.headline is never set and selectJobNotificationSummary only recognises 'Final Job Report' markers.

Contract for this diff:
- Prompt guidance for scheduled runs (the existing 'one final outcome report' bullet) now states the generic contract: final message begins with `Outcome: <one sentence>`.
- `jobOutcomeHeadline(summary)` extracts exactly that line (case-insensitive prefix) from the section selectJobNotificationSummary already selects; it skips a leading report heading ONLY for the same marker set that picker uses (`Final Job Report`, `Final Report`, `Scoring Summary`, `Score Summary`, with or without `#` prefixes — see status-formatting.ts markers list) — this is not a new heuristic, do not report it as one. No contract line, no headline, today's behavior.
- The headline is set on the structured result (headline-only result allowed) so every native renderer prints it first; the text variant shows it right after the header and drops the duplicate compacted summary.
- Memory-dreaming system jobs keep their deliberately compact terminal text (compactMemoryDreamingTerminalMessage) BY DESIGN — owner rule 'no status clutter in chat' (recorded in Q-0083) — their native renderers still receive the headline; do not propose routing them through the headline-aware formatter.
- After a recognized report heading, the first NON-EMPTY line is the outcome candidate (blank lines skipped, nothing else).
- Nothing job-specific, nothing provider-specific; no change to delivery paths.

Focus: headline length bound (160) and escaping through the existing renderers; the prompt bullet must not contradict 'quiet until terminal'; a headline containing markdown/HTML metacharacters must not break the Telegram HTML render (it goes through escapeTelegramHtml) or the text ladder. Ignore style.
