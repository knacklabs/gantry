# Review brief — lite window Q-0115 (Postgres integration tests updated to JOBPERM-1 contracts)

Facts: CI on PR #444 runs the DB-gated integration lane (locally it skipped for lack of a DB URL). Two expectations asserted contracts this branch changed on purpose: the scheduled run prompt now ends with the Outcome paragraph (Q-0093), and an undeclared RunCommand on an autonomous run goes to ask-and-wait and, with no approver route, ends as the terminal `runtime` denial (decision 0144) instead of the `deterministic_rails` deny.

Contract for this diff: test-only; the two assertions follow the new contracts; every other step of both flows unchanged. Ignore style.
