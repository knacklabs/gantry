# ASKFLOOR-1 REQUIREMENTS grill — cold read of the amended spec (read-only, adversarial, emit under ~600 words, do NOT explore beyond the listed files)

You did NOT author this. Interrogate `docs/specs/askfloor-1-judge-actually-judges.md` (re-saved 2026-09-02 with live runtime evidence) against the code and the recorded decisions.

Read ONLY:
1. `docs/specs/askfloor-1-judge-actually-judges.md`
2. `plans/exploration/askfloor-1-runtime-evidence-2026-09-02.md`
3. `plans/exploration/classifier-automode-consolidated.md`
4. `apps/core/src/shared/permission-trusted-paths.ts`, `apps/core/src/shared/bash-command-parser.ts` (:30-40 meta-executors, :560-590)
5. the auto-mode judge entry point and the static force-ask buckets (locate by `permission_mode`/`auto` + `classifier` in `apps/core/src/application/permissions/**` and `apps/core/src/runtime/permissions/**` — read only what you need to answer 1-5)
6. decisions `0040`, `0043`, `0121`, `0052`, `0124` (docs/decisions/)

Hunt, each with file:line + verdict:
1. ROUTING: does the spec's "a deterministic-gate refusal in auto mode is routed to the classifier with the refusal as context" have a real seam (where does the refusal currently become `ask`?), and can it be done WITHOUT widening the shared rails consulted by ask/autonomous lanes (the standing constraint)? Name the smallest seam.
2. LEARNING (AC3): what is the durable store today (`gantry.permission_decision_memory` holds only classifier_verdict rows), what key (exact effect-hash + rails version) the spec demands, and whether "the learning path must be the default outcome of an owner decision" conflicts with any decision (0040/0043) or with the `allow_once` semantics of the current prompt (`decisionMode`).
3. ARG-AWARE (AC4): for `mcp__gantry__file`, `RunCommand` reads, `find` without `-exec`, `2>/dev/null` — is the required behaviour precise enough to implement and test, and does any of it contradict 0121 (no classifier on autonomous runs) or 0043 (calibration)?
4. FAIL-CLOSED (AC5): is "ask with explicit provenance" consistent with the scheduled-job (no human) lane?
5. INVARIANCE (AC6): are the listed invariants the right ones, and is any of them already violated by the proposed routing in (1)?

OUTPUT: numbered findings — claim, file:line, class (correctness|scope|contract-gap|decision-conflict), severity (blocker|gap|nit), smallest fix. Then a verbatim list of OWNER-LEVEL questions (things only the owner can decide, e.g. the default tap, tap budget, what "read" means for gantry-native tools). End with "SPEC SOUND" or the blocker count. No edits.
