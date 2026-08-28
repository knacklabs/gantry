# Review brief — CHAN-2-T1 (five repeated-guard hoists)

Contract: five behaviour-preserving simplifications from the PR #444 cyclomatic review, one per file, no signature change, existing unit tests unchanged: telegram/message-action-affordances.ts (four dead early returns removed — the code lookup already rejects those kinds); telegram/channel-connect.ts (callback context computed once for the adjacent lt:stop / jp: branches); slack/channel-message-action-handler.ts (channelId/userId hoisted); discord/interactions.ts (component user id computed once); teams/cards.ts (thread fragment computed once before .map()).

Focus: each hoist reads the same values as before (pure property reads, no side effects, no short-circuit change that could alter which branch runs); no logic or text change; no test edited. Report ONLY behaviour defects. Ignore style.
