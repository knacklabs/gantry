# Review brief — lite window Q-0102 (headline lifter reads the raw summary)

Facts (live run add7e178, 2026-08-26 17:02Z): the agent wrote `Outcome: Added 2 new leads …` immediately above its `**Final Job Report**` heading. `execution-notifications.ts` fed `jobOutcomeHeadline` the marker-sliced summary (`selectJobNotificationSummary`, which keeps only text from the last report marker), so the line was discarded and the card had no headline.

Contract for this diff: `jobOutcomeHeadline(input.summary)` on the raw summary; the lifter already takes the LAST `Outcome:` match (Q-0094). No other change; `selectJobNotificationSummary` keeps its other callers. Ignore style.
