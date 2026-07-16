# Goal: Action-Based Auto-Permission (single cut, no backward compat)

Replaces the forgeable "who-triggered → silently auto-allow" trust model — and the
five trust holes it produced (r12/r13 + the run-origin/lease/responseKeyId rebuild) —
with a model that needs **no run-identity anchor at all**: auto mode judges the
**action**, not the requester. Corrected 2026-07-13 after a codex plan review (findings
folded in below; the review is the reason silent-allow is deterministically gated, not
pure-LLM).

## Objective

In `permission_mode: auto`, a gray-zone tool call is silently allowed ONLY when it is
**provably read-only, non-secret, and within an approved source/capability boundary**;
everything else **asks** (interactive → prompt, approvable **only by a control
approver**) or **denies** (unattended). Repeated admin approvals reach a durable
`tool_rule` via the "Allow for future" button already on every prompt. No silent
auto-allow is based on requester identity, so nothing forgeable is trusted.

Single cut: rip out the old classifier trust logic and the entire run-origin
trust-anchor effort. No dual path, no compatibility shim, no flag beyond the existing
`permission_mode: ask | auto`.

## Locked decisions (grill + codex review, 2026-07-13)

1. **Silent-allow requires DETERMINISTIC read-only proof — not LLM judgment alone.**
   The classifier only sees the tool name + sanitized input *before* execution
   (`apps/core/src/runtime/permission-classifier.ts:347-351`), so it cannot know what a
   read will return, and the bash parser is explicitly "not a safety parser"
   (`apps/core/src/shared/bash-command-parser.ts:105-110`). Silent-allow therefore
   requires ALL of:
   - **Bash/RunCommand:** parser-proven simple read shape against an allowlist of known
     read commands; **ask** on shell metacharacters, command substitution, redirects,
     pipes to writers, `eval`/`sh`/`source`/`sudo`/`xargs`/`env`, stateful commands
     (`export`/`set`/…), unknown executables, protected paths, or anything the parser
     cannot prove safe (`apps/core/src/shared/bash-command-parser.ts:17-48`,
     `apps/core/src/shared/tool-execution-policy-service.ts:490-502`).
   - **Third-party MCP:** use tool annotations/metadata as *untrusted hints only*
     (`apps/core/src/application/mcp/mcp-tool-inventory.ts:241-258`); silent-allow only
     when a read-only annotation / reviewed action metadata is present, else **ask**.
     Add reviewed action metadata to the MCP capability binding if annotations are
     insufficient.
   - **Not secret/credential-exposing** (env dumps, `.env`, key/token/credential files,
     `printenv`, `cat ~/.ssh/*` → ask), and
   - **Within an approved source/capability boundary** — keep `approvedCapabilityIds`
     as a deterministic guard (do NOT drop it); ambient local CLI/account access must
     not become silent read authority just because the family is classifier-eligible
     (`apps/core/src/application/permissions/permission-classifier.ts:15-20`).
   The LLM classifier adds judgment ON TOP of this deterministic floor; it can move a
   deterministically-allowable read to `ask`, but never override the floor to allow.
2. **Judged on the action, not the requester.** Drop every "who triggered" input:
   `attended`, turn-intent-as-trust, `trustedRequester`, `trustedRunId` recovery,
   `resolvePermissionAuthority`'s message-scan, and the run-origin table/spawn-recording.
   **Keep `responseKeyId`** — it is still needed for IPC response signing/routing
   (`apps/core/src/runtime/ipc-auth.ts:189-214`); remove only the responseKeyId-derived
   *trust* (`trustedRunIdForResponseKey`, `ipc-auth.ts:217-229`; recovery in
   `ipc.ts:571-607`). Verdict space stays `allow | ask` (never deny).
3. **Ask → admin-only approval.** Channel handlers already gate approval to control
   approvers (verified: Telegram/Slack/Teams/Discord, `channel-wiring-approver.ts:9-32`,
   `conversation-administration-service.ts:113-159`). Add a guard/test that the
   non-channel decision helpers `resolveDurablePermissionInteractionByRequestId`
   (`apps/core/src/application/interactions/pending-interaction-durability.ts:296-376`)
   and `processPermissionInteractionIpcBatchWithDecision`
   (`apps/core/src/runtime/ipc-interaction-processing.ts:581-592`) cannot be reached as
   an unauthorized approval surface. Unattended ask → deny
   (`ipc-permission-classifier-decision.ts:130-136`).
4. **Flywheel = the existing "Allow for future" button (corrected).** The scheduled
   "make permanent?" offer only fires after a *classifier* allow
   (`permission-classifier.ts:375-396`), so with the new model it will NOT be driven by
   admin approvals. The durable path is instead the `allow_persistent_rule` ("Allow for
   future") option already present on every prompt that has a persistent suggestion
   (`apps/core/src/channels/permission-interaction.ts:90-99`); the admin taps it to make
   a mutation permanent. (Optional follow-up, not required: make
   `recordHumanPermissionPromotionSignal` schedule the threshold offer after N human
   approvals and change the copy from "auto-allowed" to "approved" —
   `permission-classifier.ts:438-459`, `permission-promotion.ts:66-83`.)
5. **Deterministic tiers unchanged.** Pre-checks, `tool_rules`, locked presets, hard
   always-ask families run first; scheduled jobs run their intended mutations via
   granted autonomous rules BEFORE the classifier
   (`tool-permission-gate.ts:418-425`, `tool-gate-core.ts:266-292`), so deny-on-
   unattended-mutation only hits truly-unexpected gray-zone.
6. **Single cut / no backward compat.** Remove superseded machinery outright.

## Stages

### Stage A — Remove the run-origin + who-triggered trust machinery
Complete removal set (codex-verified — the earlier list was incomplete):
- Run-origin table/repo/wiring: `run_permission_origin` schema
  (`apps/core/src/adapters/storage/postgres/schema/worker-coordination.ts:136-150`),
  migration `0100` + `apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json` + `apps/core/src/adapters/storage/postgres/schema/migrations/meta/0100_snapshot.json`,
  `RunPermissionOriginRepository` port + Postgres repo, its construction in
  `apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts:114-147,1744-1749`,
  wiring in `apps/core/src/app/index.ts:279-280`,
  `apps/core/src/app/bootstrap/runtime-app.ts`,
  `apps/core/src/app/bootstrap/runtime-services.ts`.
- Spawn-recording: `apps/core/src/runtime/group-agent-runner.ts`,
  `apps/core/src/jobs/execution.ts`, and the threaded types in
  `apps/core/src/jobs/types.ts:32,67-69`,
  `apps/core/src/runtime/group-processing-types.ts:42,200-202`.
- Trust recovery: `trustedRunIdForResponseKey` (`apps/core/src/runtime/ipc-auth.ts:217-229`),
  its recovery/threading in `apps/core/src/runtime/ipc.ts:571-607`,
  `apps/core/src/runtime/ipc-interaction-processing.ts`, the `ipcAuthRunId` spawn
  threading in `apps/core/src/runtime/agent-spawn.ts`, and the `trustedRunId`/`attended`/
  `resolvePermissionAuthority` logic in
  `apps/core/src/runtime/ipc-permission-classifier-decision.ts`. **Keep `responseKeyId`
  and its signing/routing path.**
- Tests: the run-permission-origin postgres integration test (deleted in Stage A),
  and the origin assertions in `apps/core/test/unit/runtime/group-processing.test.ts`,
  `apps/core/test/unit/jobs/execution.test.ts`.
- Drop the stashed WIP (`git stash drop`).
- **Migration:** this checkout's dev DB likely applied `0100` (runtime ran on this
  branch), so add a **drop migration** for `run_permission_origin` rather than deleting
  `0100` in place; keep the journal linear.

### Stage B — Action-based classifier + decision
- `apps/core/src/runtime/permission-classifier.ts`: replace the attended/approver-intent
  system prompt with a read-vs-mutate/secret judge that operates ABOVE the deterministic
  floor (Locked 1). Keep the schema-enforced verdict on both provider lanes, the
  identifiers-not-secrets clause, treat-input-as-untrusted. Keep `approvedCapabilityIds`
  as a deterministic capability-boundary input (reframed as boundary, not "operator
  intent"). Remove `attended` from prompt+payload+audit.
- Add the deterministic read-only gate (Locked 1) as a pre-LLM check: Bash parser-proven
  allowlist + MCP annotation/reviewed-metadata; if not provably read-only+non-secret
  +in-boundary → `ask` without consulting the LLM (or consult but floor the verdict to
  ask). Prefer extending the existing shell/policy parsers over new heuristics.
- `apps/core/src/runtime/ipc-permission-classifier-decision.ts`: in `permission_mode:
  auto`, consult for eligible gray-zone families (third-party MCP + Bash/RunCommand)
  with NO requester gating. `allow` → `allow_once`/`decidedBy: auto_classifier`; `ask` →
  prompt if interactive, deny-with-reason if unattended. Latest inbound message is
  best-effort context only (never a trust input). Keep the `permission.classifier_decision`
  audit event; **remove `attended`; set its `runId` from a non-trust source** (the run's
  own id if available, else omit — do NOT source it from `trustedRunId`).

### Stage C — Docs + offline eval
- Update `docs/architecture/capability-management.md`; supersede
  `docs/architecture/auto-permission-interactive-trust-design.md` and
  `docs/architecture/auto-permission-run-origin-trust-goal-prompt.md`.
- Offline haiku eval (scratchpad harness, real gateway calls, nothing executed):
  provable read → allow; write/send/delete/spend → ask; secret read
  (`cat ~/.ssh/id_rsa`, `printenv`, `.env`) → ask; adversarial (command substitution,
  pipe-to-writer, chained mutate behind a read, injection comment, unknown exec) → ask;
  MCP without a read-only annotation → ask.

## Acceptance criteria
1. Auto mode: a provably-read-only non-secret in-boundary call runs with no prompt; a
   write/send/delete/spend call, a secret read, a non-provable shell shape, and an MCP
   call lacking a read-only signal all prompt; the prompt is approvable only by a
   control approver.
2. No code path uses `attended`, `trustedRunId`, `resolvePermissionAuthority`, or a
   run-origin record for the decision (grep-clean); `responseKeyId` signing still works.
3. Unattended gray-zone mutation → denied; unattended provable read → allowed.
4. Deterministic read-only gate blocks command substitution / redirects / unknown
   executables / secret reads from silent-allow (unit-tested).
5. Offline eval passes; focused units + typecheck + architecture + task-completion gates
   green; drop-migration applies cleanly.

## Execution (workflow rules for the fresh session)
- **Codex does code exploration** (read-only investigation) before implementing.
- **Codex effort: `--effort high` for implementation AND exploration; `--thinking xhigh`
  for autoreview.** (Codified in `.claude/skills/gantry-goal-pipeline/SKILL.md`.)
- **Autoreview per stage on the LOCAL uncommitted diff before committing**
  (`autoreview --mode local --thinking xhigh`), fix while uncommitted, then commit; run
  the branch-wide pass (`--mode branch --base origin/main --thinking xhigh`) ONCE at
  closeout.
- gantry-goal-pipeline: A→B→C; verify + commit between stages; then rebuild + runtime
  smoke (Telegram auto mode: provable read silent, write prompts admin) → fold into the
  branch PR.
