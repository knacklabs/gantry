# Make gantry permissions behave like Claude Code auto mode + classifier — gap hunt & proposals (read-only, no edits, TIGHT)

GOAL. The owner wants gantry's agent permission UX to work like Claude Code's auto mode: a competent classifier judges every UNKNOWN action on its own risk and only escalates the genuinely risky ones — asks are rare, harmless actions flow, and human decisions are learned so they are not re-asked. Audit the current gantry flow against that target, find the gaps, and propose concrete, minimal changes. Combine with the owner-side findings already gathered (below) — do not re-derive those; extend them.

CURRENT FLOW (verified — anchor your read here, keep it narrow):
- `runtime/permission-decision-coordinator.ts`: 3 layers — deterministic rails (hard deny/allow floors, run every time) -> durable reviewed-rule/grant match (fast-path) -> fall through to classifier.
- `runtime/permission-classifier.ts`: `consultPermissionClassifier` (LLM risk verdict low|medium|high -> allow|allow|ask); a static short-circuit `gantryToolDefaultRisk` runs BEFORE the LLM.
- `application/permissions/gantry-tool-risk.ts`: static buckets return high for gantry-native tools (browser_*, scheduler/admin/send-message, authority-changing, destructive) and low for read/display; returns undefined for shell tools (RunCommand/Bash) so those reach the LLM classifier.
- `shared/family-rule-synthesis.ts` + `shared/bash-command-parser.ts`: durable-grant shape gates — runner shims (npx/uvx/pnpx, npm exec, pnpm dlx…) and pipes/interpreters/meta/stateful/relative-paths get NO durable grant.
- Decision memory / promotion: `permission-classifier.ts` promotion counters + `domain/permission-effect-key.ts`.
- Spec for in-flight calibration work: `docs/specs/askfloor-1-judge-actually-judges.md` (ASKFLOOR-1).

FINDINGS ALREADY IN HAND (extend, don't repeat):
1. Runner shims re-ask forever (no durable grant) — proposed fix: package-pinned families `npx <pkg> *` instead of no-grant.
2. Excluded shapes drop the "Allow for future" affordance silently with no explanation/alternative.
3. Stale/settled setup+permission cards don't retract like the chat permission card (lifecycle).
4. Coarse static-high buckets (e.g. all `browser_*` = high, all send-message = high) force asks that arg-level judgment could auto-allow.

QUESTIONS (answer each with file:line evidence + a concrete minimal proposal):
1. **Where does gantry force-ask when it could auto-judge?** Enumerate the paths that ask WITHOUT consulting the LLM classifier's risk judgment (static high buckets, always-ask shapes, undefined->ask fallbacks). For each: is the ask justified by real unbounded risk, or is it a coarse default an arg-level classifier verdict could safely lower? Propose the smallest change (arg-level risk input, narrower bucket, or route-to-classifier).
2. **Where does it fail to LEARN (re-ask what a human already decided)?** Beyond shims — do promotion counters / decision memory actually suppress repeat asks for the same effect, and are they keyed so a human "ask once" outcome informs future identical requests? Any effect-key mismatch that defeats learning?
3. **Is the risk judgment independent of stored permission, end to end?** Confirm (or refute) that an unknown command with no grant is judged on its own risk and auto-allowed when low/medium — and find any place where "no stored grant" degrades to "ask" regardless of risk.
4. **Shim/package granularity** — validate the `npx <pkg> *` pinned-family proposal against the rails and the durable validator: is it safe (bounded to one package, rails still inspect the exact command), and what is the smallest implementation seam (parser identity = `<shim> <pkg>`, synthesis, durable-validator predicate)?
5. **Anything else that diverges from the auto-mode ideal** — over-asking, non-durable safe repeats, missing arg-level calibration, classifier not consulted where it should be.

OUTPUT: numbered findings — gap (one sentence), file:line, why it diverges from the auto-mode ideal, concrete minimal proposal, and whether it belongs in ASKFLOOR-1, CARDSIMPLE-2, or a new story. End with a one-paragraph synthesis of the recommended change set, ordered by UX impact. No edits.
