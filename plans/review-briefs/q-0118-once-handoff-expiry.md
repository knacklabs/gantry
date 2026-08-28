# Review brief — lite window Q-0118 (once needs already in handoff states settle as expired)

Facts: branch autoreview P2 — a `once` need persisted as `handoff_pending`/`handed_off` by the T1-only deployment (before T2's expiry sweep) was abandoned by T2's guards: stuck or still decisionable. No such rows exist in production, but the recovery is required for correctness.

Contract for this diff: the reconciler settles a once need found in `handoff_pending` or `handed_off` as `cancelled` + `expiredAt` (helper `expireHandoff`), delivering no responses, writing no rule, touching no rerun barriers, and revising the card (expired copy, non-decisionable). The candidate query includes `handed_off` rows ONLY when `grant = 'once'`, so dormant rule needs are not rescanned. Unit test 'expires a once need already handed off before the expiry sweep existed'.

Focus: rule needs in handed_off remain untouched (never expired); no double-transition when the sweep and expireHandoff both see the row; reconciler stays under 700 lines. Report ONLY behaviour defects. Ignore style.
