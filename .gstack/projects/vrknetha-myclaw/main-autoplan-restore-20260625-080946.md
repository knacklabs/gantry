# /autoplan Restore Point
Captured: 2026-06-25T02:39:46Z | Branch: main | Commit: 09f0d5e8c

## Re-run Instructions
1. Copy "Original Plan State" below back to your plan file
2. Invoke /autoplan

## Original Plan State
# Making gantry's agent legible: presence + decision prompts

## Context

Users can't tell what the gantry agent is doing — whether it heard them, what it's
working on, or whether it's even running. That erodes trust. The reference product
(the three screenshots) earns trust with one behavior: the agent is **continuously
legible**. It reacts the instant it's asked, states a plan, shows a live checklist,
re-plans out loud when corrected, asks at real decision forks, and signs off with an
honest receipt.

Gantry has a strong execution engine (durable queues, fenced leases, crash recovery)
but the channel surface is **silence punctuated by a clock**. The agent's real state —
its plan, its todos, the step it's on, "I need you" — already exists inside the system
and both engines, but is never connected to the channel. We will connect it.

The **sharpest instance of the same illegibility is the permission/decision prompts.**
When the agent needs a human to approve a tool call, the user reported seeing "a lot of
code and truncated commands, just not able to understand at all." Verified in code: the
prompt leads with the raw payload (a fenced command/diff/config, truncated mid-token)
under a generic title, and **discards the plain-language `description` the model already
wrote**. So this plan has two parts that share one decision-card surface: **Part 1 —
presence** (what is the agent doing) and **Part 2 — decision/permission legibility**
(what does it need from me, said in plain language).

**Decisions locked with the user:**
- Scope: full redesign, shipped as one release (not a wedge).
- Channels: Slack, Teams, Telegram, Discord to parity.
- Plan source: un-strip DeepAgents `write_todos`; surface the engines' real todo state.
- Instant ack is an **emoji reaction on the user's own message** (`👀` seen → `✅` committed).
- **Remove the `Working → Done` timer entirely.** The todo card replaces it.
- Work runs **async**; the agent stays "ready to respond" — the todo is the window into background work.
- **Plan the agent instructions too**, not just the plumbing — the gold-standard *voice* is instructed, not free.

**Guardrail (unchanged):** per `docs/decisions/2026-06-23-agent-communication-reasoning-safety.md`,
we surface authored progress, explicit todo state, tool names, terminal receipts, and
safe summaries — **never raw reasoning / `thinking_delta`**. The todo projection is
literally "explicit todo state," so this redesign stays inside the existing safety line.

# Part 1 — Presence: the turn story

## The target experience (Slack, before → after)

**Before**
```
Nadia: @Claude build scheduled exports…
            (750ms+ silence)
Claude:  ⏳ Working
  +60s   ⏳ Working · 1m 23s
  end    ✅ Done · 4m 02s
```

**After**
```
Nadia: @Claude build scheduled exports…        👀   ← Claude reacts instantly
Claude (status line): Claude is reading the export stub…
Claude:  On it — here's the plan:
         ◻️ workspace_schedules table (admin-level)
         ◻️ admin-only cadence panel (daily / weekly / monthly)
         ◻️ reuse the nightly export job
         Heads up: ~2.1M-row migration — I'll ask before the destructive step.
Nadia:  hold up — workspace-level, not per-user
Claude:  ✓ Replanning — moved to a workspace setting.        ← same card rewrites
         🔧 workspace_schedules table …
Claude (⏸ waiting on you): Migration — (a) blocking, ~5 min lock, or
         (b) additive + backfill, zero downtime?
Nadia:  b
Claude:  ✓ Noted — additive + backfill.
         ✅ workspace_schedules table
         ✅ admin cadence panel
         🔧 nightly job …
Claude (receipt): Done. Changed 3 files + 1 migration. Reused the nightly job.
         Needs attention: backfill runs tonight — I'll confirm in #product-eng-launches.
```

One message, edited in place. No clock. The user always knows: *heard me, doing this, needs me here.*

## Architecture: one projection, four native renderers

Collapse the **three parallel, half-built progress mechanisms** —
`group-progress-heartbeats.ts` (time tickers), `runtimeEventOnly` adapter frames, and
manual `send_message` — into a single **AgentPresence projection**:

- **Subscribes** to the unified turn event stream: `LiveTurnState` transitions
  (`claimed → running → awaiting_interaction → setup_required → completed/failed`) plus
  adapter runtime events (`task_started/progress/updated`, **todo deltas**, ask boundaries, errors).
- **Maintains** a durable per-turn `PresenceState`: `{ ack, plan/todos[], currentStep, waitingOnUser?, terminalReceipt }`.
- **Renders** through a per-provider `ChannelPresenceRenderer` using native affordances —
  one self-updating surface per turn (the todo card), an instant reaction, and a status/typing signal.

This makes the cleanup and the feature the same change.

### Native affordance map (parity, honestly per-provider)

| Signal | Slack | Teams | Telegram | Discord |
|---|---|---|---|---|
| Instant ack | `reactions.add` 👀/✅ | typing + informative update* | `setMessageReaction` | `PUT …/reactions` |
| "thinking" presence | `assistant.threads.setStatus` (`is reading…`) | typing + informative-update bar | `sendChatAction(typing)` (exists) | trigger-typing |
| Live todo card | edited `chat.update` message | `updateAdaptiveCard` | `editMessageText` | `PATCH …/messages` |
| Decision fork | Block Kit buttons | Adaptive Card actions | inline buttons | components/buttons |

\* Teams bots can't add arbitrary message reactions; its instant-ack equivalent is the
typing indicator + first informative update (≤1000 chars). Note this in the renderer.

## Workstreams (land together as one release)

### 1. Instant emoji-reaction ack (new capability — nothing exists today)
- Add `addReaction(jid, messageRef, emoji)` to the channel-delivery interface and implement in all four:
  `apps/core/src/channels/slack/channel-delivery*.ts`, `teams-delivery.ts`, `telegram/channel-delivery.ts`, `discord-delivery.ts`.
- Fire `👀` at message accept in `apps/core/src/application/external-ingress/conversation-message-ingress.ts`
  (`acceptMessage`), and `✅` (or a contextual emoji the agent chooses) at turn claim in
  `apps/core/src/app/bootstrap/live-execution.ts`. This closes the start-of-turn silence gap.

### 2. The living todo card (replaces the clock)
- **Remove** the timer path: `apps/core/src/runtime/group-progress-heartbeats.ts` (Working/elapsed/no-output)
  and `apps/core/src/runtime/progress-updates.ts` (`✅ Done · / ❌ Failed ·`). Delete the `750ms` initial-progress delay.
- **New** `apps/core/src/runtime/agent-presence/` — `presence-state.ts` (durable state, reuse the
  `progress-state-file.ts` persistence pattern so it survives restart/recovery) and
  `presence-projection.ts` (event-stream → state → renderer).
- Each adapter gains a `renderPresence(state)` that creates/edits the single card. Reuse existing
  edit paths (`chat.update`, `updateAdaptiveCard`, `editMessageText`, Discord `PATCH`).

### 3. Surface the engines' real todos
- **DeepAgents:** remove `'write_todos'` from `EXCLUDED_TOOLS` in
  `apps/core/src/adapters/llm/deepagents-langchain/runner/builtin-tool-exclusion.ts`; in
  `runner/stream-normalizer.ts`, emit todo-state deltas as runtime events (durably projected,
  resolving the non-durability reason the strip cites). Update `deep-agent-runner.ts` wiring.
- **Anthropic:** in `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts`, map
  `TodoWrite` tool_use → the same todo runtime-event shape, so both engines feed one card schema.
- Keep `task` / filesystem built-ins stripped (delegation-authority concern stands; only `write_todos` changes).

### 4. Async + "ready to respond" + live re-plan
- Presence is **non-blocking**: post card, run work in the background runner, update the card from the
  event stream, keep the channel open. A new user message mid-turn is an interaction boundary
  (already detected in `query-loop.ts`) → re-plan = card rewrite, not a queued second turn.
- Map `LiveTurnState.awaiting_interaction` / `setup_required` to a distinct visible **`⏸ waiting on you`**
  state so blocked never looks like working.

### 5. Decisions, inline acks, honest receipts
- `ask_user_question` (`apps/core/src/runner/mcp/tools/messaging.ts`): on answer, post a `✓ Noted …`
  confirmation and flip presence out of waiting. While awaiting, the card shows the question, not a timer.
- Terminal receipts come from the projection: success = the structured **Completed / Used / Changed /
  Needs-attention** receipt `docs/AGENTS.md` already mandates (now enforced as the turn's terminal render,
  not an optional `send_message`); failure surfaces `safeErrorSummary` (already stored in
  `apps/core/src/jobs/execution-finalization.ts`) with a next step — never a bare `❌ Failed`.
- Long-running / scheduled / async jobs use the same card + **work-based** heartbeats (todo deltas), and
  worker recovery emits "picking this back up" instead of 90s of silence.

### 6. Agent instructions (the voice layer)
- Update `OPERATING_GUIDANCE_BLOCK` in `prompt-profile-service.ts` (the live source per the
  runtime-prompt-guidance memory) to instruct: react/ack first; post a plan/todo before non-trivial
  work; narrate via todo updates (not prose spam); ask at genuine forks with crisp A/B options;
  acknowledge corrections out loud ("Replanning…"); give honest receipts; stay human and brief
  (the "Good luck at the shoot" warmth). Make `write_todos`/`TodoWrite` a first-class instructed habit.
- Trim/realign `apps/core/src/shared/capability-guidance.ts` to the new presence model.

### 7. Cleanup
- Remove dead `PlanReviewRequest/Response/Surface` from `apps/core/src/domain/types.ts` and the
  composition in `apps/core/src/channels/channel-provider.ts` + `channels/README.md` (the todo card +
  `ask_user_question` deliver the behavior). If an explicit "approve plan before run" gate is wanted
  later, build it on `ask_user_question`, not this unused surface.
- Reconcile docs: DeepAgents `AGENTS.md` (write_todos now surfaced + durability projection),
  `docs/architecture/channel-interactions.md`, `docs/architecture/anthropic-claude-adapter-materialization.md`,
  and confirm alignment with the communication-reasoning-safety decision doc.

# Part 2 — Decision & permission legibility

Same disease, sharper symptom: when the agent needs a human decision (a permission
approval or an `ask_user_question` fork), the prompt **leads with raw payload, not
intent**. Users see truncated code and config they "just can't understand," so they
rubber-stamp or stall — both are trust failures.

**Root cause (verified in code):**
- The model's own plain-language Bash **`description`** ("Run the test suite and
  verify.py") is **discarded** for command prompts — `formatPermissionToolInputLines`
  surfaces `description` only for skill installs (`permission-tool-input-format.ts:487`),
  never for the actual command branch (lines 71–129).
- Commands / diffs / config are truncated with a **head+tail char window**
  (`headTailTruncate`, `permission-interaction.ts:307`; 900 head / 300 tail for commands) —
  which drops the meaningful middle and breaks mid-token.
- Titles are generic ("Allow exact command access?"); the body is a raw fenced
  `Command:` block. There is no *what / why / risk*.
- `request_settings_update` dumps the **full raw YAML with no diff and no redaction**
  (the one High-severity gap in the tool inventory).
- MCP prompts show raw tool ids (`list_repos`); skill installs headline file **hashes,
  byte sizes, and full paths**; the `isInternalPlumbingKey` filter runs only in the
  generic fallback, not the specialized formatters.

**Redesign principle: intent first, payload second, never mid-token.** Every tool routes
through the shared DecisionCard below.

| Tool | Lead line (intent) | Details (secondary / expandable) | Fix anchor |
|---|---|---|---|
| Bash / RunCommand | `What it does: <description>` or `Runs: <programs>` | command, start-preserving line-aware | `permission-tool-input-format.ts` cmd branch + `summarizeBashCommandPrograms` |
| Edit / Write | `Editing <file> — +N/−M lines` | diff, line-aware | `formatFileToolInputLines` |
| request_settings_update | `Update settings — <reason>` | **diff** (old→new) + redaction | `runner/mcp/tools/settings.ts` + new formatter |
| request_skill_install / proposal | `Install "<name>" skill — <description>` | "N files (size)"; hashes/paths → audit only | `formatKnownToolInputFields` skill branch |
| request_mcp_server | `Connect <server> — <reason>` | humanized tools ("list repos, create issue") | mcp branch + optional pattern descriptions |
| request_access (run_command) | semantic name + readable command | command, line-aware | reuse cmd rendering |
| request_agent_profile_update | `Update SOUL.md — <why>` | diff; drop the 96-char hash from the headline | profile branch |
| register_agent / service_restart / admin_permission_revoke | already legible — keep | — | — |

**Truncation policy (global):** replace head/tail char windowing for code/commands/
diffs/config with a **start-preserving, line-aware clamp** — show the beginning in full,
never cut a line in the middle, end with `… (+N more lines)`. New helper
`clampCommandForDisplay` in `permission-interaction.ts` (drop-in for
`sanitizePermissionCommandText`), extended to Edit/Write diffs and settings.

**Consistency:** apply `isInternalPlumbingKey` uniformly across every specialized
formatter so ids / hashes / paths never reach a headline.

> Two small edits are already staged in the working tree from a partial start:
> `summarizeBashCommandPrograms` added to `shared/bash-command-parser.ts`, and its import
> in `permission-tool-input-format.ts`. Keep them (they fit this plan) or revert; the rest
> of Part 2 has not been written.

## Shared abstraction: one DecisionCard for "Does it need me?"

Permission prompts and `ask_user_question` forks are the same surface as Part 1's third
question (*Does it need me?*). Unify them on one model, rendered by the same per-channel
renderers as the presence card:

```
DecisionCard {
  title:   intent, plain language          // "Run a command?"  not "exact command access"
  what:    one line — what happens          // model description / parsed summary
  why:     reason / context                 // the agent's stated reason
  risk?:   heads-up, only when real         // writes / deletes / network / migration
  details: collapsible payload              // command, diff, config, files — line-aware
  actions: Allow once / 5 min / Always / Cancel   (or the fork's options)
}
```

`PermissionPromptParts` (`permission-interaction.ts:218`) is the seam — today its
`bodyLines` mix intent and raw payload. Split into `what / why / risk / details` so Slack
blocks, Telegram HTML, Teams cards, and Discord all put intent on top and the payload
behind an expander — the same renderer the presence todo card uses.

## Native Full-view surfaces (the truncation killer) — selected wow feature

`DecisionCard.details` never dumps the raw payload inline. Inline stays intent-only
(*what / why / risk*) with a **"Full view" affordance**; opening it shows the provider's
richest *fully readable* native surface — complete command / diff / config, scrollable and
monospaced, never truncated:

- **Slack** — `views.open` **modal** carrying the full payload. (Later upgrade: a pinned Canvas work-doc.)
- **Teams** — **task module / stageview** dialog (Adaptive Card in a modal).
- **Telegram** — the full payload as a sent **file** (`sendDocument`: `command.txt` / `change.diff`)
  and/or a native **expandable blockquote**. (Later upgrade: a Mini App dashboard.)
- **Discord** — interaction **modal**, or the full payload as a **file attachment** on an ephemeral follow-up.

Fallback where a surface is unavailable: the inline expandable block (still line-aware clamped).
One `details` affordance, four native expressions — shared by permission prompts,
`ask_user_question` forks, and the presence todo card. *Ponytail note:* reuse existing
message/file-send paths (`sendDocument`, interaction responses); add modals only where the
provider makes them cheap — not a new UI framework.

# Part 3 — Job notifications: honest + clean

Same illegibility, plus a correctness bug. Verified in `jobs/status-formatting.ts`
(`formatRunStatusMessage`, lines 28–34):

- **False "Completed".** Every terminal notification hardcodes a `Completed: <summary>` line —
  *including failures and timeouts*. The header emoji is right (`❌ Failed`), but the body still
  reads `Completed: …`, so an errored job announces "Completed." Dishonest. (Header status is
  generally correct — `runStatus` flips to `failed` on a thrown error, `execution-finalization.ts:66,118`
  — so this is a body-label bug. Secondary upstream case: the agent claims success but the work
  silently failed with no thrown error → `runStatus` stays `completed`; flagged for follow-up, not
  fixable in the formatter.)
- **Boilerplate gibberish.** Every notification also emits three constant lines —
  `Used: scheduler job`, `Changed: not reported`, `Delegated: no` (lines 31–33) — that never carry
  signal for scheduled jobs. Pure noise stacked on the raw `summary`.

**Fix (ponytail — relabel and delete, no new structure):**
- Replace the hardcoded `Completed:` label with a **status-matched** line (reusing the existing
  `statusLabel`): completed → `Done:`, failed → `Failed:`, timeout → `Timed out:`, dead-lettered →
  `Paused:`. Never assert completion on a non-completed run.
- **Drop the constant `Used / Changed / Delegated` lines** unless they carry real content; keep
  `Needs attention:` only when `notificationAction` returns something. A clean run is two lines, not six.
- Failures show the one-line reason from `notificationOutcome` + the recovery action already computed;
  the full raw error/diagnostics goes behind **Full view**, not inline.

Before:

    ❌ Failed · nightly-export · 4m
    Completed: Error: ECONNREFUSED 10.0.2.5:5432 at Socket.<anon>… Diagnostics: …
    Used: scheduler job
    Changed: not reported
    Delegated: no
    Needs attention: none

After:

    ❌ Failed · nightly-export · 4m
    Failed: couldn't reach the database (connection refused).
    Needs attention: check the DB host, then [Retry now].
    [ Full view ]   ← complete error + diagnostics

Files: `jobs/status-formatting.ts`, `jobs/execution-notifications.ts`. Reuses the same
honest-receipt + Full-view pattern as Parts 1–2.

# Part 4 — Streaming smoothness (per-provider, no seams)

Verified in the channel adapters: gantry uses a flat **900ms debounce** on Slack and
Telegram-group, **no streaming at all on Teams and Discord** (`sendStreamingChunk` is
unimplemented → every flush is a *new full message*, size-split into several), and
inconsistent rate-limit handling. That's the chunkiness — a 900ms pause→block, and on
Teams/Discord, separate messages with visible seams.

Drift vs. each provider's documented cadence:

| Provider | Gantry today | Docs say | Drift |
|---|---|---|---|
| Slack | native `startStream`/`appendStream`, **900ms** debounce, 3× retry (no jitter); fallback = **separate messages** | placeholder + `chat.update`, **~500ms** debounce, 1/sec | choppy at 900ms; **fallback splits into new messages** (seams) |
| Teams | **no streaming** — full message per chunk, byte-split into separate messages | **native streaming entity** (informative→streaming), **buffer 1.5–2s**, 1/sec, await prior success | **major: native streaming unused** |
| Telegram (private) | native draft streaming (`@grammyjs/stream`) | ~1 edit/sec/chat, honor `retry_after` | OK; no explicit `retry_after` handling |
| Telegram (group) | **900ms** `editMessageText` debounce | ~1 edit/sec/chat, **honor `retry_after`** | **no 429/`retry_after` handling** (documented flood risk) |
| Discord | **no streaming** — full message per chunk split at 2000 chars; **no rate-limit handling** | ~1.2s edit debounce, **parse `X-RateLimit-*`** | **major: no streaming, no rate limiting** |

**Fix:**
- **Per-provider debounce, not a flat 900ms** — promote the existing `SLACK_STREAM_UPDATE_INTERVAL_MS`
  / `TELEGRAM_GROUP_EDIT_INTERVAL_MS` constants to a small per-provider config: Slack ~500–600ms
  (within burst), Telegram ~900ms–1s, Teams 1.5–2s, Discord ~1.2s.
- **Implement streaming for Teams and Discord** (biggest win): Teams → the **native streaming entity**
  (`streamType` informative→streaming, awaiting the prior call); Discord → **single-message edit**
  streaming at ~1.2s, not new messages.
- **Stop spawning new messages mid-stream.** Keep editing/appending one surface; split to a second
  message only when the provider's hard cap is truly hit — never as the normal cadence.
- **Honor rate limits uniformly:** parse `retry_after` (Telegram group), `X-RateLimit-*` (Discord),
  add jitter to Slack's backoff; coalesce so a 429 neither drops nor bursts.

Files: `channels/slack/text-limits.ts` (interval) + `channels/slack/channel-delivery.ts` (flush/native/
fallback), `channels/telegram/channel-state.ts` (group flush + `retry_after`), `channels/teams.ts` +
`teams-delivery.ts` (add native streaming), `channels/discord.ts` + `discord-delivery.ts` (add edit
streaming + rate limits), `runtime/group-processing.ts` (pipeline), `channels/channel-retry-delay.ts` (backoff).

## Worked examples (what the user sees)

### Permission prompt — before → after (a real bash approval)

Before (current `formatPermissionPromptText` output):

    🔐 Allow exact command access?

    Command:
    ```
    psql "$DB" -c 'BEGIN; LOCK TABLE workspace_schedules IN ACCESS EXCLUSIVE MODE;
    INSERT INTO workspace_schedules (workspace_id,cadence,day) SELECT id,'weekly',1
    FROM wo…edules; COMMIT;' > /tmp/migrate.log
    ```
    Redirect: > /tmp/migrate.log
    Agent: Default Agent · Context: agent chat · Reply in 5m

Generic title; the statement is truncated mid-SELECT with a head…tail "…". The user can't tell what it does.

After (intent-first DecisionCard):

    🔐 Run a command?
    What it does: Backfill every workspace with a weekly export default (2.1M rows), then commit.
    ⚠️ Writes to /tmp/migrate.log
    Runs: psql
    [ Full view ]  → complete untruncated command in a Slack modal / Teams stageview / Telegram file / Discord modal
    Default Agent · agent chat · the agent can't approve this itself
    [Allow once] [Allow 5 min] [Always allow] [Cancel]   Reply in 5m

`What it does` is the model's own Bash `description` (today discarded). `⚠️ Writes to …` comes
from the existing `firstDestructiveRedirectTarget`. The raw command moves to **Full view**, fully readable.

### `ask_user_question` — before → after (a decision fork)

Before — the question renders, but presence still shows `⏳ Working · 2m 10s` (looks busy, not
blocked) and the answer is acknowledged with silence:

    Claude: Migration approach?
      ( ) blocking      ( ) additive
    [user taps additive] → (silence; agent just continues)

After — a distinct waiting state, the *why* in the question, a recommended default, and an inline ack:

    Claude (⏸ waiting on you): The workspace_schedules migration touches 2.1M rows —
    how should I run it?
      ◉ Additive + backfill — zero downtime   (recommended)
      ○ Blocking — simpler, ~5 min table lock
    [user taps Additive + backfill]
    Claude: ✓ Noted — additive + backfill, zero downtime. Resuming.
            🔧 backfilling workspace_schedules …

## Wow surface examples

### Full view (IN SCOPE — selected) — tapping "Full view" on the permission prompt

Slack `views.open` modal (Teams stageview / Telegram file / Discord modal are the same idea):

    ┌ Full command — Run a command? ────────────────┐
    │ psql "$DB" -c '                                │
    │   BEGIN;                                        │
    │   LOCK TABLE workspace_schedules                │
    │     IN ACCESS EXCLUSIVE MODE;                   │
    │   INSERT INTO workspace_schedules               │
    │     (workspace_id, cadence, day)                │
    │   SELECT id, ''weekly'', 1 FROM workspaces;     │
    │   ANALYZE workspace_schedules;                  │
    │   COMMIT;' > /tmp/migrate.log                   │
    │                                                 │
    │ Writes: /tmp/migrate.log                        │
    │             [ Allow once ]   [ Cancel ]         │
    └─────────────────────────────────────────────────┘

Complete command, line-wrapped and scrollable — nothing truncated. The inline card stays clean.

### Optional / future wow surfaces (not in the selected build — shown for the call)

Slack Canvas — one persistent, co-edited work-doc per task (updates in place, not scrollback):

    📄 Scheduled exports — live           🔧 in progress · 3m
    ────────────────────────────────────────────────────────
    Plan
      ✅ workspace_schedules table (admin-level)
      ✅ admin cadence panel (daily / weekly / monthly)
      🔧 nightly job — backfilling 2.1M rows
      ◻️ ship to #product-eng-launches
    Decisions
      • Migration: additive + backfill (zero downtime) — Nadia
      • Workspace-level, admin-only (not per-user) — Nadia
    Changed
      services/export/schedule.ts (+128)
      db/migrations/0042_workspace_schedules.sql (new)
    Needs attention
      Backfill finishes ~tonight; I'll post the result here.

Telegram Mini App — a button opens a live web dashboard:

    [ 📊 Open live dashboard ]
    → Mini App:  🔧 Building · 3m | Plan 3/4 | Diff +128/−4 | Pending: none | [Approve next step]

Discord — ephemeral approval (only the asked user sees it) + Rich Presence:

    member list:  🟢 Claude — Playing: Building scheduled exports
    in #eng (ephemeral, only Nadia sees it):
       🔐 Run a command? — Backfill 2.1M workspaces…   [Full view] [Allow once] [Cancel]

Teams — stageview dialog + native AI label/feedback:

    🔐 Run a command?  What it does: Backfill 2.1M workspaces…   [ Open full view ]
    🅰️ AI-generated · Sources: ATL-421 · 👍 👎

Each degrades gracefully; say the word to promote any into the build scope.

## Execution & review (how this gets built)

- **Implementer: codex**, run non-interactively with write access and high reasoning:
  `codex exec "<prompt>" -C /Users/ravikiranvemula/Workdir/myclaw -s workspace-write -c 'model_reasoning_effort="high"'`
  (prompt written to a temp file to avoid injection).
- **Forced ponytail discipline** — the codex prompt hard-codes ponytail's ladder and rules:
  stop at the first rung that holds; **reuse existing helpers** (`firstDestructiveRedirectTarget`,
  `summarizeBashCommandPrograms`, `headTailTruncate`/`sanitizePermissionCommandText`) instead of new
  abstractions; smallest working diff, fewest files; no speculative config/interfaces; mark deliberate
  simplifications with `// ponytail:` comments naming the ceiling; leave **one runnable check** (extend
  the existing `permission-tool-input-format.test.ts` / `permission-interaction.test.ts`, no new
  frameworks). Read the flow fully before editing — laziness shortens the solution, never the reading.
- **Scope order (separate codex passes, each reviewed before the next):**
  1. **Part 2a — inline intent-first** (smallest, highest-value first diff): lead every prompt with
     *what / why / risk*; line-aware truncation; settings diff+redaction; humanize MCP/skill formatters.
     Files: `permission-tool-input-format.ts`, `permission-interaction.ts`, `shared/bash-command-parser.ts`,
     `runner/mcp/tools/settings.ts`, and the two test files. (Two edits already staged — keep them.)
  2. **Part 2b — native Full-view surfaces**: the `details` affordance opens a modal/file per provider.
     Touches the channel adapters (`slack/`, `teams-*`, `telegram/`, `discord-*`); reuse `sendDocument` /
     interaction-response paths. Reviewed on its own.
  3. **Part 3 — job notifications**: honest status label + drop the boilerplate lines
     (`jobs/status-formatting.ts`). Small formatter fix; ships with or right after 2a.
  4. **Part 4 — streaming smoothness**: per-provider debounce + Teams/Discord native streaming +
     rate-limit honoring (channel adapters). Pairs with 2b (same files).
  5. **Part 1 — presence redesign** (new projection, reaction capability, un-strip `write_todos`,
     4 renderers, instructions). Larger and architectural; its own codex pass + review.
- **Reviewer: me, via `/review` (gstack)** on the resulting working-tree diff before anything lands.
  Nothing is committed until the review passes; findings loop back to codex.

## Verification

### Part 2 — decision/permission prompts
- **Unit:** `permission-tool-input-format.test.ts` + `permission-interaction.test.ts` —
  command prompt leads with `What it does:` (from `description`) and falls back to `Runs:`;
  line-aware clamp keeps the start and ends with `… (+N more lines)` (never mid-token);
  `request_settings_update` renders a redacted diff, not raw YAML; skill install collapses
  the file list; MCP humanizes tool ids.
- **Manual:** trigger a gnarly multi-line bash permission prompt on each channel; confirm
  the lead line is the model's description and the command is readable, not a head…tail stub.
- **Full view:** the inline message stays intent-only; opening "Full view" shows the complete
  untruncated payload in the provider's native surface (Slack modal, Teams stageview, Telegram
  file/blockquote, Discord modal/file); unsupported provider falls back to the inline block.

### Part 3 — job notifications
- **Unit:** extend the `jobs/status-formatting.ts` tests — a `failed`/`timeout` run never renders a
  `Completed:`/`Done:` line; the `Used`/`Changed`/`Delegated` boilerplate is gone on a clean run;
  a failure shows the one-line reason + recovery action; the header emoji/status is unchanged.
- **Manual:** force a job to error (bad command/credential); confirm the notification reads `❌ Failed`
  with an honest reason and a `Retry now` action, not `Completed:` + filler.

### Part 4 — streaming smoothness
- **Unit:** per-provider debounce config resolves to the right interval; the flush keeps one surface
  (no second message emitted until the hard cap); Telegram honors a mocked `retry_after`; Discord
  respects mocked `X-RateLimit-*` headers.
- **Manual:** stream a long multi-paragraph answer on each channel — smooth progressive growth of one
  message on Slack/Teams/Telegram/Discord, no mid-stream new-message seams; no 429 floods under load.

### Part 1 — presence
- **Unit:** presence projection state machine (claim→running→waiting→terminal), todo-delta → card
  schema for both engines, `addReaction` per adapter (mock provider APIs). Extend
  `test/unit/adapters/*execution-adapter.test.ts` and `test/unit/runtime/agent-spawn.test.ts`.
- **Per-channel manual run** (`/run` or live workspace): one thread per provider — confirm
  reaction within ~1s, plan card appears, mid-turn correction rewrites the same card, decision fork
  shows `⏸ waiting`, `✓ Noted` on answer, honest receipt; confirm the old `⏳ Working · Xs` never appears.
- **Async/scheduled:** a multi-minute job shows todo progress + a final receipt, not silence.
- **Recovery:** kill the worker mid-turn; confirm "picking this back up" instead of a 90s gap.
- **Safety:** assert no `thinking_delta` / raw reasoning ever reaches a channel (todos/tool-names/summaries only).
- `verify.py` (or repo equivalent) green; new shared files added to the ipc-mcp-stdio fixture copy list
  if they're reachable from the runner (per the fixture-copy memory).
