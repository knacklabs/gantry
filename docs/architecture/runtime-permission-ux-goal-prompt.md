# Goal Prompt: Permission Auto-Mode UX, Quiet Prompts, Threading, Skill Installs

## Objective

Make the runtime pleasant to drive from chat: auto permission mode actually auto-decides (classifier judges what the deterministic gate can't prove; user approved this posture change), prompts are compact and edit down to receipts, auto-allows are silent, post-approval replies arrive as new messages, and skill installs work for multi-skill repos with failures that say why.

Use ponytail. Fail-open on rendering (a failed edit falls back to send). Security rails that must NOT change: host-side independent judge, schema-enforced verdicts, YOLO denylist backstop always forces ask, sanitized-input guard forces ask, prompts never see the capability list.

## Evidence (2026-07-14 runtime logs, verified)

- `Installer command did not produce a SKILL.md file` for `npx skills add remotion-dev/skills`; bare `Command failed with exit code 1` for single-skill installs (stderr empty — the CLI errors on stdout).
- Last `decidedBy: auto_classifier` entry July 12; since the action-based rework every unproven command hard-asks. Even `ls -la ~/Workdir/myclaw` prompted (the `-a` disqualifies it from the `ls`/`cat`-only proof set).
- `BUTTON_DATA_INVALID` on Telegram ask-user buttons (callback data > 64 bytes), falling back to plain text. Re-confirmed 2026-07-15 04:05 on the rebuilt binary — still live, Stage C target.
- Turns stream via edit-in-place; after a mid-turn permission prompt the resumed turn keeps editing the pre-prompt bubble. Supporting evidence 2026-07-15: `Progress lifecycle telegram dropped replaceOnly without handle` when the stream handle is lost across a prompt.

## Stages

### Stage A — Skill install reliability

**Status: SHIPPED (uncommitted, final review round pending).** Scope grew during live testing: multi-skill installs + failure surfacing as specified below, plus emergent runtime fixes — headless installer env (`AI_AGENT=1`), desired-state export hygiene (phantom accounts, observed-only chats, composite jids), stale-settings retry + canonical revision documents, permission full-view delivered in-group (supersedes part of Stage C's payload work), async/delegated task tools decoupled from the sandbox. Full record: ledger rows A.1–A.43.


- `apps/core/src/jobs/ipc-skill-install-handlers.ts` `collectInstalledSkillAssets`: when no root SKILL.md, scan the staging dir for skill folders (each containing a SKILL.md) and install ALL of them (each as its own skill artifact through the existing single-skill path); the decision receipt lists installed skill names. Zero skills found keeps the current error.
- `apps/core/src/adapters/sandbox/approved-command-runner.ts`: when a command fails and stderr is empty, append the stdout tail instead (existing byte caps and redaction apply).
- The skill-install failure receipt surfaces that output to the chat (the flow already delivers a failure message; enrich it).
- Tests: staging-dir fixtures (single skill, multi-skill repo, zero skills); runner failure-output cases (stderr, stdout-only, both). Find the existing test files for these modules and extend them; if none exists for the handlers, a focused new unit file following neighbouring patterns.

Bounded write scope: those two source files + the receipt delivery site in the same handlers file + their test files. Nothing else.

### Stage B — Auto mode that decides (user-approved posture change)

- `apps/core/src/shared/auto-permission-read-only-gate.ts`: widen the provable read-only set — flag-tolerant `ls` (incl. `-a`/`-l`), `pwd`, `stat`, `file`, `head`, `tail`, `wc`, `du`, `df`, `which`, `grep`/`rg` read-only forms, `find` without `-exec`/`-delete`/`-ok`/`-fprintf`-style writers, `git status|log|diff|show|branch` (no pager side effects — `--no-pager` tolerated). Keep: path confinement (workspace + granted folders), shell-control/redirect refusal, secret-bearing hidden-segment and credential-name blocks. `env`/credential reads stay unproven.
- `apps/core/src/runtime/permission-classifier.ts` `consultPermissionClassifierBeforePrompt`: when the deterministic gate cannot prove read-only (and input is not sanitized and the denylist does not match), CONSULT THE CLASSIFIER instead of returning a hard `ask` — with an ALLOW-LEANING posture (user decision 2026-07-15): the classifier allows unless it identifies concrete risk (destructive/irreversible actions, credential/secret access, data exfiltration, obfuscated or indirect execution, out-of-workspace writes); `ask` is the exception, not the default. Adjust the classifier prompt/verdict rubric accordingly. Denylist match and sanitized input keep forcing `ask`. Note in docs: `yolo` mode remains the pure reverse-list (allow-except-denylist, no LLM) option.
- Mode naming in settings (`apps/core/src/config/settings/`): `permission_mode: auto` = the new consult-classifier behavior; add `auto_strict` = today's deterministic-proof-only behavior. Parser accepts both; docs strings updated. Existing configs with `auto` get the new behavior by design (that is the user's ask).
- Promotion signal: extend the existing promotion counter so repeat approvals (N≥2) of the same suggestion shape mark "Allow always" as the primary/default button, and pass a `recentlyApprovedExactToolShape` boolean to the classifier prompt (mirror of `recentlyDeniedExactToolShape`).
- Tests: gate table tests (each newly proven command form, plus refusals: redirects, `-exec`, `rm`, hidden-secret segments, out-of-workspace paths); classifier-consult flow tests for `auto` vs `auto_strict` (denylist still asks, sanitized still asks, unproven consults); settings parser accept/reject for the new mode value.

Bounded write scope: those files + the permission gate/callback modules under `apps/core/src/runtime/permissions/` ONLY if mode plumbing requires it + settings parser files + their tests. Nothing else. Mind the `permission-classifier.ts` file-size budget (currently near-limit territory — extract a helper module in the same directory if needed).

### Stage C — Prompt UX (compact, edit-in-place, silent auto)

- NOTE (2026-07-15): the oversized full-view payload now posts in the group thread with a contextual caption (Stage A, ledger A.38) — Stage C's compact rendering must build on that, not regress to approver DMs.
- USER DECISION 2026-07-15 (supersedes receipt-edit): on an APPROVED decision, DELETE the prompt message outright (Telegram deleteMessage; Slack chat.delete; providers without delete edit down to nothing/minimal) and post NO receipt — logs are the audit trail. Denials/timeouts keep a visible outcome. Fallback when delete fails: edit to a one-line receipt. Telegram has `editMessageText` plumbing (`apps/core/src/channels/telegram/channel-shared.ts`); Slack uses `chat.update`; Teams updates the card; providers without edit fall back to today's separate receipt. Seam: the decision path in `apps/core/src/channels/permission-interaction.ts` + provider adapters.
- USER DECISION 2026-07-16: batch coalescing with `Allow all / Review each / Deny all` is a wanted feature — keep it, with the hardening guardrails (Allow all suppressed when any row is truncated/redacted/generic; Review each atomically consumes the batch; restart-safe bindings).
- Batching: `apps/core/src/channels/permission-batch-coalescer.ts` already coalesces (1.5s window); render a coalesced batch as ONE message with compact rows and `Allow all / Review each / Deny all`; extend the window to 3s while a prompt for the same conversation is already pending.
- Silent auto-decisions: classifier/deterministic allows post NOTHING to chat; audit events remain. Optional single digest line appended to the turn's final message ("auto-allowed N commands") — implement only if a cheap seam exists in the turn-finalization path; otherwise skip (note in ledger).
- Telegram `BUTTON_DATA_INVALID`: interactive callback data (permissions AND ask_user_question) must fit Telegram's 64-byte limit — use short opaque ids mapped host-side (the pending-interaction store already keys requests; reuse its ids).
- Tests: coalescer render/flush cases; receipt-edit fallback (edit fails → send); callback-data length property test; existing channel suites stay green.

Bounded write scope: `apps/core/src/channels/` permission/interaction/telegram/slack/teams files named above + coalescer + their tests. Nothing else.

### Stage B2 — Egress default-allow (USER DECISION 2026-07-15)

Live bug: agent command sandbox got 403 from registry.npmjs.org — the egress gateway is default-deny + allowlist (`allowedNetworkHosts` via `ensureEgressGateway`). User contract: network calls (like tools/skills/MCP) are DEFAULT-ALLOW; the egress denylist (`permissions.egress.denylist`) is the only blocker, sandboxed or not. Flip the gateway posture: no allowlist gating for agent/async command egress; denylist still enforced; keep audit events. Applies to direct AND sandbox_runtime modes. Acceptance: `npm install` of a public package succeeds from an agent command with no grant; a denylisted host still blocks.

### Stage D — Stream boundary after interactive prompts

- When a permission prompt or user question is delivered mid-turn, signal the channel runtime to start a NEW message for the next streamed chunk in that conversation/thread: call the existing `resetStreaming(chatJid, ...)` (exposed via channel runtime; see `apps/core/src/runtime/group-processing-flow.ts`) from the interactive-prompt delivery path, scoped to the affected thread.
- Tests: a focused unit around the delivery path asserting resetStreaming fires on prompt delivery and the next chunk opens a new message (existing streaming tests as the pattern).

Bounded write scope: the prompt delivery seam (`apps/core/src/channels/permission-interaction.ts` or the rich-interaction delivery helper) + wherever the reset signal threads through `apps/core/src/app/bootstrap/channel-wiring.ts` + tests. Nothing else.

## Assumptions ledger

Every stage records assumptions in `docs/architecture/runtime-permission-ux-assumptions.md` (same contract as the observability ledger; orchestrator validates before each commit).

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Permission posture | Changed (user-approved) | `auto` consults the classifier for unproven commands; `auto_strict` added. |
| settings.yaml | Additive | New `auto_strict` mode value. |
| Chat UX | Changed | Compact prompts, edited receipts, silent auto-allows, new-message boundary after prompts. |
| Skill installs | Fixed | Multi-skill repos; failures carry output. |
| Control API / SDK | Unchanged | No contract changes. |
| Security rails | Unchanged | Denylist backstop, sanitized-input guard, host-side judge, schema verdicts. |

## Acceptance Criteria

- `ls -la` inside the workspace runs with zero prompt in `auto`.
- An unproven-but-safe command auto-allows via classifier; a denylisted command still prompts; `auto_strict` reproduces today's behavior.
- Multi-skill repo install succeeds and lists installed skills; a failing install shows the installer's actual output.
- A permission prompt edits down to a one-line receipt after decision; near-simultaneous requests render as one batch message.
- After approving a mid-turn prompt, the next agent reply arrives as a NEW message.
- No Telegram `BUTTON_DATA_INVALID` for permission/user-question buttons.
- Full unit suite green; architecture gates introduce no NEW violations vs branch base.

## Focused Verification (per stage)

```bash
npx tsc --noEmit -p tsconfig.json
python3 .codex/scripts/check_architecture.py
```

Plus per-stage focused vitest files named in each stage. Closeout: full `npm run test:unit`, branch autoreview, Telegram runtime smoke (install a multi-skill repo, run `ls -la`, approve one prompt, verify receipt edit + new-message boundary).
