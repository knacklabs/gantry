# Brief — one permission path for scheduled-job runs (design + sizing, READ-ONLY)

Go straight to the code; do NOT read WORKFLOW.md/docs/FACTORY.md/architecture docs (a previous run spent its context there and died before reporting). Read only: decisions 0134 and 0144, plans/assumptions.md A-0060..A-0066, and the source/test files named below. Report early and tersely.

Do not edit files. Produce a design and an exact file list.

## Incident (2026-08-27 16:39Z, run 0798f2bc-8ae7-47aa-9d47-24db019ec871)
A KnackLabs job run asked to run a PIPED command (`curl … | …`). Piped commands cannot become a
persistable rule (decision 0134: the pipe is the authorization boundary; only per-leaf rules exist).
`jobPermissionDurability.attachRequest` therefore returned false (no card row), the host fell back to
the classic chat prompt (`deps.requestPermissionApproval`), and
`apps/core/src/runtime/ipc-permission-classifier-decision.ts:437`
(`if (input.hostJobId) decisionOptions = firstPersistentRule ? ['allow_persistent_rule','cancel'] : ['cancel']`)
left the prompt with ONLY a Cancel button. `gantry.permission_prompts` row 6299a039… shows
rendered_decision_options_json = ["cancel"]. The run is blocked on a question that can only be answered "no".
No log line records that a classic prompt was delivered (the card path logs 'Job permission card delivered').

## Owner decision (Ravi)
"Fix this properly, not narrow — holistic and simple." Buttons for job permissions are exactly Allow / Deny.
GENERIC: this applies to ANY request a job run raises — any tool, any command shape — not only piped RunCommand. The only distinction is whether Allow can persist a rule (`rule`) or applies to this run only (`once`). For a request that cannot be remembered, Allow means "allow for this run" (allow_once). Never a Cancel-only prompt.
Everything provider-neutral (Telegram/Slack/Discord/Teams all render from the shared card projection).

## Target design (validate or improve; prefer deletion)
ONE path for every permission raised by a scheduled-job run:
1. `attachRequest` attaches EVERY job-run request as a need row, including requests with no persistable rule
   (piped/compound-with-pipe, over-length, etc.). The row carries whether Allow can persist a rule
   (`grant: 'rule' | 'once'`), and the card row copy says so plainly (e.g. "Run command: curl … (this run only)").
2. Settlement: Allow on a `once` row replays allow_once to the runner and writes no rule; Allow on a `rule` row
   behaves as today. Deny unchanged.
3. Delete the classic-prompt fallback for job runs: the `input.hostJobId` branch in
   ipc-permission-classifier-decision.ts and any job-specific handling in permission-approval-requester /
   channel prompt code that exists only for that fallback. `setup-pause-permission-prompt.ts` (setup pause,
   run already ended) is a separate path — leave it unless it also reaches the cancel-only shape.
4. Keep the existing delivery log; there should be no second prompt renderer left for job runs.

## Questions to answer precisely
- Where does `attachRequest` decide "no persistable rule → false"? (apps/core/src/app/bootstrap/job-permission-durability-wiring.ts,
  apps/core/src/application/jobs/job-permission-*.ts, domain/job-permission-*.ts). What does the need row store today?
- How is Allow applied on settlement (rule write + IPC decision replay)? Smallest change so a `once` row replays allow_once.
- Does the runner side (apps/core/src/runner/permission-callback.ts in-flight registry, heartbeat) need anything?
- Recovery/reconciler/projection (`job-permission-card-projection.ts`, reconciler, `representedNeeds`): any assumption that every row has a rule?
- Provider renderers (`domain/job-permission-card-actions.ts` rows, telegram/slack/discord/teams card delivery): row copy only?
- Which tests pin the old shapes (unit + integration under apps/core/test) and must change?
- Anything in the classic path that becomes dead once job runs never reach it — list it for deletion.

## Output
1. Root-cause confirmation in 3 lines.
2. The design, in plain language, ≤ 15 lines, choosing the simplest option at each step.
3. Exact file list with one line per file: what changes (add/modify/delete), estimated lines.
4. Risks / invariants to keep (one line each), especially A-0060..A-0066 in plans/assumptions.md and decisions 0134/0144.
5. Tests to add or change (file + leaf test name).
Be concrete; cite file:line.
