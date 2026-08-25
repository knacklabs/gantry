# Review brief — quickfix Q-0074 (JOBPERM-1 incident: living-card revision loop)

Incident: after deploying the JOBPERM-1 branch, the KnackLabs job-permission card (need state `handed_off`) was edited on Telegram every ~6s for 16 hours — 10,115 revisions of ONE message. Each reconciler tick minted an identical "edit" revision.

Root cause: `reviseLivingCard` guards no-op revisions with `JSON.stringify(last.rows) === JSON.stringify(visible)`. `last.rows` is read back from Postgres JSONB, which normalizes key order; `visible` is a fresh literal. Never equal → new revision every tick. In-memory test fakes used `structuredClone` (order-preserving), so unit tests could not see it.

Contract for this diff:
- Comparison is key-order-insensitive (`util.isDeepStrictEqual`).
- Test fakes persist state through a JSONB-faithful round trip (`jsonbRoundTrip`: sorted keys, undefined dropped) so the entire jobperm suite exercises persisted shapes.
- A delivered revision whose rows are unchanged mints no new revision on any number of reconcile ticks.

Focus: other comparisons/equality checks in the job-permission modules that assume source key order or `undefined` presence after persistence; anything in the JSONB round trip that could hide a real change (e.g. dropped `undefined` masking a state transition). Ignore style.
