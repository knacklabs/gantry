# HANDOFF — Action-Based Auto-Permission (start here in a fresh session)

You are resuming a single-cut rework of auto-permission. This file is the entry point.
Read it, then execute the plan. Everything below is current as of 2026-07-13.

## TL;DR of what to do

Implement `docs/architecture/auto-permission-action-based-goal-prompt.md` (the plan,
already codex-reviewed and corrected) via the `gantry-goal-pipeline` skill: Stage A
(remove old machinery) → Stage B (action-based classifier + deterministic read-only
gate) → Stage C (docs + offline eval). Then rebuild, runtime smoke, and fold into the
branch PR. **Nothing is merged yet** and the merge stays held until this lands clean.

## The model (decided by grill + codex review)

Auto mode judges the **action, not who triggered it** — so there is NO run-identity
trust anchor to get right (that approach produced five trust holes and is being deleted).

- **Silently allow** a gray-zone call ONLY when it is **provably read-only** (deterministic
  gate, not LLM alone), **non-secret**, and **within an approved capability boundary**.
- **Ask** (interactive → prompt, approvable **only by a control approver**) or **deny**
  (unattended) for everything else: writes, deletes, sends, spend, secret-exposing reads,
  non-provable shell shapes, MCP calls lacking a read-only signal.
- **Durable rules** come from the "Allow for future" button already on each prompt (admin
  taps it → the mutation becomes a `tool_rule` → deterministic auto thereafter).

Why this is safe: the only trust decision left is "who **approved**", which the channel
(Telegram/Slack/etc.) authenticates on the button tap — the runner can't forge it.

### The one correction that changed the grill answer
The grill picked "broad read-only, auto-allow any read." Codex's review showed that's
NOT safe: the classifier only sees the command *before* execution, so it can't know a
benign-looking read returns secrets/PII, the bash parser is explicitly "not a safety
parser", and MCP read-vs-write isn't knowable from the name. So silent-allow now requires
a **deterministic read-only gate** (bash allowlist/parser + MCP annotations) UNDER the
LLM. The set of silently-allowed reads is therefore conservative, not "anything the LLM
thinks is a read." Flag this to the user if they expected every read to be silent.

## Repo state

- Branch: `feature/auto-permission-mode`. HEAD includes: Tier-2 (#210's commits), the
  auto-permission feature, all earlier fix rounds (r6–r12), the run-origin Stages A–C
  (committed but **inert** — the decision doesn't consume them), and the plan/handoff docs.
- **Not merged.** The committed interactive-decision path still has the r13 stale-approver
  issue; this rework replaces it entirely.
- **Stashed:** `git stash@{0}` = the abandoned run-origin Stage D + binding fixes. Stage A
  of the plan says to `git stash drop` it (do not apply).
- Dev DB likely applied migration `0100_run_permission_origin`, so Stage A adds a **drop
  migration**, not an in-place delete.

## Workflow rules (MANDATORY — user-set)

1. **Codex does code exploration** — read-only investigation via `codex:codex-rescue`
   before implementing; do not hand-explore large surfaces.
2. **Codex does ALL code changes.** You (orchestrator) write goal prompts, verify, commit,
   triage. Codex never commits, never runs autoreview by itself, no background gates.
3. **Codex effort: `--effort high` for implementation AND exploration; `--thinking xhigh`
   for autoreview.** (Codified in `.claude/skills/gantry-goal-pipeline/SKILL.md`.)
4. **Autoreview per stage on the LOCAL uncommitted diff BEFORE committing**
   (`autoreview --mode local --thinking xhigh` via a codex plain-command handoff), fix
   findings while still uncommitted, re-review until clean, THEN commit. Run the
   branch-wide pass (`--mode branch --base origin/main --thinking xhigh`) exactly ONCE at
   closeout. (Codified in the skill §3.3/§4.)
5. Handoffs use `--model gpt-5.6-sol`, `Use ponytail. No commentary.`, bounded write scope.
   After each commit re-check `git status` (pre-commit prettier can dirty files) and amend.

## Codex plan-review findings already folded into the plan (context)

P0: silent-allow needs a deterministic read-only gate (bash + MCP), not LLM alone; keep
`approvedCapabilityIds` as a capability boundary; MCP annotations are untrusted hints —
ask when absent. P1: the "make permanent" flywheel only fires on classifier allows, so use
the existing "Allow for future" prompt button instead; Stage A removal list was incomplete
(now complete) and `responseKeyId` must be KEPT for signing (remove only its trust
recovery). P2: guard the two non-channel decision helpers; audit event drops `attended` and
must source `runId` from a non-trust source. Full detail is in the plan's Locked decisions.

## First action in the fresh session

1. Re-read `docs/architecture/auto-permission-action-based-goal-prompt.md`.
2. Confirm branch + stash state (`git log --oneline -3`, `git stash list`).
3. Start Stage A: hand codex (effort high) the removal scope from the plan's Stage A list,
   bounded to those files. Local-autoreview (xhigh) before commit.
4. Proceed B → C per the plan; branch autoreview once at closeout; rebuild + smoke; PR.

## Related docs
- Plan: `docs/architecture/auto-permission-action-based-goal-prompt.md`
- Superseded by this model (update/remove in Stage C):
  `docs/architecture/auto-permission-interactive-trust-design.md`,
  `docs/architecture/auto-permission-run-origin-trust-goal-prompt.md`,
  `docs/architecture/auto-permission-mode-goal-prompt.md`.
