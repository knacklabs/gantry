# ASKFLOOR-1-T1 TASK grill — round 6 (read-only, adversarial, emit under ~250 words; factory/prompts/griller.md --gate task)

You did NOT author this contract. Round 5 returned 2 blockers + 1 gap + 1 nit. The task `ASKFLOOR-1-T1` in `.factory/stories/ASKFLOOR-1/decomposition.json` and the saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T1.md` were revised:
1. AC3 records the one authoritative order: pre-coordination route analysis → [T3b] exact remembered deny → hard restrictions → reviewed rules → deterministic rails (single base evaluation) → conditional trusted-root handling (only on the rails' out_of_trusted_root ASK; hypothetical rechecks unchanged) → [T3b] remembered allows → classifier-cache read → tail. Stage-order leaf test.
2. The safety leaf is parameterized over first/later operands, predicate values (`-name .env`, `-path '*/.ssh/*'`, `-newer /etc/shadow`), `..`, hidden and secret names, `-H/-L/-follow`, redirect, compound, pipeline; and allows `find .` / `find ./src -name '*.ts'`.
3. "One analysis per IPC permission request"; other coordinator callers pass none.
4. Counts corrected (eleven test files, thirteen leaf tests).

Verify each is closed; hunt anything NEW. OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "CONTRACT SOUND" or the blocker count. No edits.
