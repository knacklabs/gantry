# End-to-end reply-latency report — design spec

- **Date:** 2026-06-14
- **Status:** Design approved; open items resolved by architect (§13) — ready for implementation planning, no code yet
- **Owner area:** Gantry core (capability), Boondi admin panel (consumer)
- **Branch:** `codex-lateny-fix`

---

## 1. Context & problem

Boondi shows two latency numbers for the same reply that never agree:

- **"Reply latency 8.3s"** in the trace popup is a *sum of active stages only*:
  `totalMs = stages.reduce((sum, s) => sum + s.ms, 0)` — `apps/core/src/runtime/reply-trace.ts:172`.
  Each LLM stage is timed `message_start → assistant`, i.e. pure generation
  (`apps/core/src/adapters/llm/anthropic-claude-agent/runner/llm-turn-accumulator.ts:29`).
  All time *between* and *around* the stages is excluded by construction.
- **"took 16s"** badge is a different measurement entirely:
  `replySeconds = (outbound.created_at − lastInbound.created_at) / 1000`
  — `boondi-admin/lib/queries.ts:245`.

They are deliberately different today (documented at `boondi-admin/lib/types.ts:39`
and `boondi-admin/components/LatencyReport.tsx:127`), so the popup can never
explain the wall clock. The operator cannot diagnose where the time goes.

### Two accuracy facts discovered during investigation (code is SOT)

1. **The "16s" badge ends *before* the reply is actually sent.** The outbound
   `created_at` is stamped pre-send (`apps/core/src/app/bootstrap/conversation-outbound-projection.ts:46`)
   and the row is written *before* the Interakt HTTP call (stored at
   `channel-wiring.ts:433`, sent at `channel-wiring.ts:448`; the send itself is a
   bare untimed `fetch` at `apps/core/src/channels/interakt/interakt-api.ts:63`).
   So today's number *excludes* send latency — an honest end-to-end total can be
   **larger** than 16s.
2. **The badge's start anchor uses the provider clock.** Inbound `created_at` is
   set from Interakt's `received_at_utc` when present, else app receive time
   (`apps/core/src/channels/interakt/channel.ts:201`), persisted as `created_at`
   (`canonical-message-repository.postgres.ts:128`). That can carry provider /
   network time and clock skew.

---

## 2. Goals & non-goals

### Goals (acceptance criteria)

1. **100% accurate, fully decomposed.** The report's total equals the real
   wall clock, and the sections **sum to that total** — nothing hidden.
2. **Human-readable sections.** Each section is an intuitive label a non-engineer
   can reason about ("Waiting in queue", "Generating reply", "Sending the reply").
3. **Reuse the existing LLM instrumentation.** The per-turn generation timing and
   the per-tool timing stay as-is and become sections of the larger timeline.
4. **Boring, simple code.** Add marks next to existing code; one new piece of
   plumbing only. No new transport, no clever abstractions.
5. **Strong Boondi ↔ Gantry boundary.** This is a *Gantry* capability; Boondi
   (the admin panel) is purely a consumer/renderer. No core file references Boondi;
   tool/server names flow as data only (existing rule, `reply-trace.ts:11`).
6. **Verified on the real path.** Proven with a heavy live prompt + admin
   screenshot, reconciling sum-of-sections == report total == independent wall clock.
7. **Extension of the existing report, not a new one.** Same popup component
   (`boondi-admin/components/LatencyReport.tsx`), same `message_traces` storage.
   All current content (LLM-turn stages, tool stage, token/cache chips, expandable
   payloads) stays. `timings_json` becomes **v2**; `totalMs`'s meaning changes
   (sum → wall clock) and the badge re-points to it. Because the app is still in
   development, **v2 is a clean break** — we do not maintain v1 dual-rendering
   (dev trace data is disposable, runbook §8 reset); the `version` field is kept
   only as a forward-compat gate (admin shows "unsupported trace version" for
   anything it doesn't render). See §13.D.

### Non-goals (YAGNI)

- WhatsApp **delivery** receipts (async, outside the reply path).
- Historical **backfill** / dual-rendering of old v1 `message_traces` rows (dev data
  is disposable — wipe via runbook §8).
- Any new UI framework — we extend the existing report component.
- Measuring the customer → Interakt network leg (unobservable on-host; see §4).

---

## 3. Key decision — the authoritative window (Option A, approved)

**The report's total wall-clock window = `webhook received at Gantry` →
`Interakt send API returns`.** This is the span Boondi actually controls and can
measure on one host. The "took Xs" badge is **re-pointed to equal this total**, so
badge and report share a single source of truth and can never disagree again.

Rejected alternatives: matching the current badge window (hides send time +
provider clock skew); adding a separate customer→Interakt network band (depends on
provider clock quality; deferred).

---

## 4. Approach — one absolute timeline of marks

Instead of summing a few stage durations, core records an **absolute timestamp
("mark") at every boundary** from message-arrival to reply-sent. The report
defines **each section as the gap between two consecutive marks**. Sections then
sum to the total by construction; any leftover is shown as an explicit "Other /
hand-off" section so no time is ever unaccounted.

**Why this is sound:** core and the agent child run on the **same host**, and every
existing mark is already `Date.now()` (ms-epoch). The current trace already orders
cross-process stages on one timeline by `startedAt`
(`reply-trace.ts:159`) — we are extending a proven pattern, not inventing one.

---

## 5. The sections (the human-readable breakdown)

Top-to-bottom for a typical reply. Each is real measured wall-clock time; they add
to the total.

| Section label | What it measures | Mark source |
|---|---|---|
| **Waiting in queue** | Persisted inbound waited before processing (≤500ms poll + any debounce + concurrency wait) | start = webhook-receipt (new); end = processing start `group-processing.ts:171`; poll = `message-loop.ts:421` (POLL_INTERVAL=500, `config/index.ts:31`); auto-registered debounce 2×poll `channel-persistence-handlers.ts:261` |
| **Safety check (guardrail)** | Pre-agent screening | exists — `group-guardrail.ts:68`–`83` |
| **Starting the assistant** | Cold spawn (node + runner + CLI + MCP connect) or warm hand-off to a live child | diagnostic only today — `timing-probe.ts` marks `before_sdk_query` (`query-loop.ts:314`) / `first_sdk_message` (`query-loop.ts:385`); promote into the trace |
| **Model warm-up (time to first token)** | Request dispatched → first token, per LLM turn (queue, prompt upload, cache-read) | **new** — gap between `query-loop.ts:314` and `message_start` at `query-loop.ts:543` |
| **Generating reply** | `message_start → assistant`, per turn | exists (reuse) — `llm-turn-accumulator.ts` |
| **Tool call** (e.g. `get_gifting_context`) | MCP round-trip incl. IPC | exists — `ipc-admin-handlers.ts:326`–`349` |
| **Sending the reply** | Final text → Interakt send API returns | **new** — bracket `interakt-api.ts:63` |
| **Other / hand-off** | Residual between marks, so nothing is hidden | computed remainder |

Existing per-stage detail (model, tokens, cache, tool bytes, expandable payloads)
is preserved unchanged.

---

## 6. The marks — reuse vs. add

**Already captured (reuse, no change to meaning):**

- Guardrail start/end — `group-guardrail.ts:68`,`82`.
- LLM turn `message_start` / `assistant` — `query-loop.ts:543`,`399` →
  `llm-turn-accumulator.ts`.
- Tool call start/end — `ipc-admin-handlers.ts:326`,`349`.
- Processing start — `group-processing.ts:171` (`commandStartedAt`) and run start
  `group-processing.ts:437`.

**New marks to add (each sits next to existing code):**

1. **Webhook receipt** — `Date.now()` at the top of the webhook handler
   (`apps/core/src/control/server/routes/interakt-webhook.ts:39`), before the
   200-ACK (`:62`) and the `setImmediate` defer (`:63`).
2. **Request dispatch / first token** — capture the instant just before the SDK
   `query()` (`query-loop.ts:314`); the existing `message_start` mark closes the
   gap. (The diagnostic `timing-probe.ts` already marks this point under
   `GANTRY_TIMING_LOG`; we promote it into the real trace.)
3. **Send start / send end** — bracket the Interakt `fetch` (`interakt-api.ts:63`);
   persisted on the **outbound** message row (see §13.B), so the window end is
   durable and race-free at assembly.

**Plumbing — two durable anchors on message rows, marks drained at assembly:**
The window's two endpoints must survive the persist→poll→restart boundary, so they
live as **typed columns on the message rows**: `ingress_at` on the inbound (window
start, §13.A) and `send_started_at` / `send_completed_at` on the outbound (window
end + send section, §13.B). Everything in between (guardrail, startup, per-turn
LLM, tools) is an in-process **run mark** drained at the existing assembly seam, as
today. At assembly the driving inbound's `ingress_at` anchors the start and the
outbound's `send_completed_at` anchors the end.

---

## 7. Data model & versioning

**Section-kind taxonomy (core-owned, generic, agent-agnostic).** Core emits a stable
set of section `kind`s; the admin maps each to a display label/color. New kinds vs.
the existing enum (`guardrail | llm | tool | command`):

| kind | meaning |
|---|---|
| `queue` | inbound `ingress_at` → processing pickup (poll + debounce + concurrency) |
| `guardrail` | pre-agent screen (existing) |
| `startup` | agent process becomes ready: cold spawn **or** warm hand-off |
| `model_wait` | request dispatched → first token, per LLM turn (TTFT) |
| `llm` | generation `message_start → assistant`, per turn (existing) |
| `tool` | MCP tool round-trip (existing) |
| `send` | outbound dispatch to the channel (`send_started_at → send_completed_at`) |
| `gap` | unattributed remainder between marks ("Other / hand-off") |
| `command` | command/canned reply (existing) |

Keeping the taxonomy in core (not the display strings) means labels can be reworded
in the admin without a schema change.

**`timings_json` version 2 (computed in core, stored — not derived in the admin):**
- `version: 2`, `windowStart`, `windowEnd`, `windowMs` (absolute ms-epoch + span).
- `sections[]`: the **contiguous** list (kind, ms, startedAt, detail), summing to
  `windowMs` by construction with the `gap` remainder explicit.
- `totalMs` = `windowMs` (true wall clock; no longer a sum of stages).
- The per-stage `detail` (model/tokens/cache, tool bytes, etc.) rides on its section
  unchanged. `startup` may carry optional `detail.phases[]` sub-marks (§13.C).
- **Core computes the sections** in a pure, unit-tested assembler (extending
  `reply-trace.ts`); the admin is a dumb renderer, so the "sum == total" invariant
  is enforced once.

**Schema changes (clean, via boot migrations — dev data disposable):**
- `messages`: add `ingress_at`, `send_started_at`, `send_completed_at` (all
  `timestamptz`, nullable) — see §13.A/§13.B.
- `message_traces`: columns unchanged (`total_ms`, `timings_json`, `payloads_json`,
  `created_at`); only the JSON shape and `total_ms`'s meaning evolve.
- The admin renders v2 and shows "unsupported trace version" for anything else
  (forward-compat gate); **no v1 dual-rendering** (§13.D).

---

## 8. Boundary — Gantry owns, Boondi consumes

- **Gantry core owns:** all mark capture, the timeline assembly (agent-agnostic),
  the schema, and persistence. Output is a generic v2 `timings_json`.
- **Boondi admin owns:** rendering the v2 sections (labels, colors, waterfall) in
  `boondi-admin/components/LatencyReport.tsx`, and re-pointing the badge
  (`boondi-admin/lib/format.ts`, `lib/queries.ts:245`) to the report total.
- No core file references Boondi. Server/tool names remain *data* flowing through.

---

## 9. Warm runs, continuations & batching

- **Per-reply unit (unchanged keying):** one report per outbound reply message,
  keyed by the outbound message id, via the existing seam
  `persistReplyTraceForTurn` (`group-processing.ts:348`) →
  `reply-trace-persist.ts:55`. `selectTurnTraceSlice` (`reply-trace.ts:229`) keeps
  it idempotent and slices cumulative turns per reply.
- **Warm continuation:** a reply produced by an already-live child has no spawn;
  its timeline shows a "warm hand-off" segment instead of "Starting the assistant".
  The report adapts to whichever marks exist.
- **Batched inbounds:** when several customer messages are coalesced into one
  prompt, the start anchor is the **latest** driving inbound's `ingress_at` for that
  reply (§13.F — matches customer-felt responsiveness and the current badge).

---

## 10. Correctness rules & edge cases

- **Single clock:** all marks are host `Date.now()`; safe to subtract. Provider
  timestamps are never used for the window.
- **Missing marks are non-fatal:** capture stays best-effort (matches existing
  swallow-errors policy in `reply-trace-persist.ts` / repository). A missing mark
  collapses its section into the adjacent "Other / hand-off" remainder rather than
  breaking the report; the total is still `windowEnd − windowStart`.
- **Remainder is explicit:** `sections.sum()` is forced to equal `windowMs` by
  emitting the leftover as the "Other / hand-off" section. Never silently drop.
- **Negative/zero guards:** clamp each section to ≥ 0 (as existing code already
  does, e.g. `Math.max(0, …)`).

---

## 11. The badge change

`boondi-admin` badge stops computing `outbound.created_at − inbound.created_at`
and instead reads the report's `windowMs`. If best-effort capture produced no v2
trace for a message, it falls back to the timestamp gap so the badge always shows
something (§13.H — robustness, not v1 compat). Severity thresholds in `format.ts`
continue to apply to the same displayed number.

---

## 12. Verification — live E2E per `docs/BOONDI-E2E-TESTING.md` (no shortcuts)

Drive a real reply through the live Interakt→guardrail→agent→Shopify→outbound
pipeline and prove the report in the admin panel. Section numbers below refer to
the runbook.

**Preflight (runbook §2, §3, §10):**
1. Stack up: 4710 / 8081 / 8082 / 3000 (services one-liner, §3).
2. Confirm safety rails on the **live** core process (§2): `GANTRY_OUTBOUND_DRYRUN=1`
   and a **fake** operator phone listed — never send from the real number.
3. Enable capture for the run: `GANTRY_TRACE_PAYLOADS=1` and `GANTRY_FLOW_LOG=1` in
   `~/gantry/.env`; **restart core** to apply (dev mode; direct `.env` /
   `settings.yaml` edits allowed for local dev). Optionally take a fresh start (§8)
   for a clean transcript.

**Drive a heavy reply (runbook §4, §5):**
4. Pick a fake listed number (e.g. `000000905`). Send a **heavy prompt** that forces
   a Shopify tool call + multiple turns via `scripts/lib/webhook.mjs` (a corporate
   gifting / catalogue request like the verified kaju-katli lookup).
5. Poll every 5 s (§5) until the outbound reply lands (chat turn ≤ 50 s).

**Prove it in the admin panel (runbook §7 — the proof of record):**
6. Open `http://localhost:3000/?c=conversation:wa:000000905`, click the reply's
   latency badge to open the **latency report**, and **take a screenshot**.
7. Verify in the screenshot: every expected section is present and labeled
   (Waiting in queue · guardrail · Starting the assistant · Model warm-up ·
   Generating reply · Tool call · Sending the reply · Other), and the existing
   per-stage detail (model/tokens/cache/bytes/payloads) still renders.

**Reconcile to wall clock (the acceptance gate):**
8. Independent wall clock from the flow log (§9, `GANTRY_FLOW_LOG=1`): webhook-ACK
   instant → `flow:outbound` for that reply, plus the new send bracket.
9. Assert: **sum of sections == report total == badge == independent wall clock**
   (within a few ms), with no unexplained remainder beyond the "Other" bucket.
   Iterate until they reconcile exactly.
10. Repeat once on a **warm continuation** turn (no cold spawn) to confirm the
    timeline adapts — shows a "warm hand-off" segment instead of "Starting the
    assistant".

---

## 13. Resolved design decisions (architect, 2026-06-14)

Resolved for long-term stability over short-term patching; the app is still in
development, so clean structural changes are preferred to compatibility shims.

**A. Webhook-receipt instant → dedicated column `messages.ingress_at` (timestamptz,
nullable).** It must survive the persist → poll-pickup → (possible restart) boundary,
so it has to be durable; it is a genuine property of the inbound message. A typed
column beats a metadata blob (queryable, can't rot) and an in-memory map (lost on
restart). Named distinctly from the existing `received_at` (= provider/app time) to
avoid confusion. Null for messages with no gateway origin (outbound/synthetic).

**B. Send timing → columns `messages.send_started_at` / `send_completed_at`
(timestamptz, nullable) on the outbound row.** Mirrors the existing `delivered_at`
column and is **race-free**: trace assembly reads the outbound row *after* the send,
so no ordering race with an in-memory collector. Gives precise diagnosis —
"hand-off before send" (gap) vs. "send round-trip" (`send` section) are separated.
`windowEnd = send_completed_at`.

**C. `startup` is one section with optional `detail.phases[]`.** Top-level taxonomy
stays stable (one `startup` kind), but the cold-spawn sub-marks already produced by
`timing-probe.ts` (node / runner / CLI / MCP-connect) are promoted into
`detail.phases[]` when present, so the admin can drill in without any future schema
change. Warm hand-off is a single span with no sub-phases. Lossless and stable.

**D. v2 is a clean break — no v1 compatibility layer.** Dev trace data is disposable
(runbook §8 reset), so we do not dual-render or backfill v1. The `version` field is
retained purely as a forward-compat gate (admin shows "unsupported trace version"
for unknown versions). This removes ongoing compat maintenance.

**E. Section labels live in the admin; core emits `kind`s.** The kind→label/color map
stays in `LatencyReport.tsx`, so wording can change without touching core. Chosen
v1 wording: queue→"Waiting in queue", guardrail→"Safety check", startup→"Starting
the assistant", model_wait→"Model warm-up", llm→"Generating reply", tool→"Tool
call", send→"Sending the reply", gap→"Hand-off / overhead".

**F. Batch anchor = the latest driving inbound.** When several inbounds are coalesced
into one prompt, `windowStart` = `ingress_at` of the **most recent** inbound for that
reply — matching customer-felt responsiveness and the current badge's `lastInbound`
semantics.

**G. Single-host clock is a documented invariant.** All marks are host `Date.now()`
(ms-epoch) and are only ever subtracted on the same host — which is the deployment
model (core + child + MCPs all local). If core and the child ever run on separate
hosts, this must be revisited (monotonic clock + offset handshake); called out so
it's a conscious assumption, not an accident.

**H. Badge degradation is robustness, not compat.** The badge reads `windowMs` when a
v2 trace exists; if best-effort capture produced no trace row for a message, it
falls back to the inbound→outbound timestamp gap so the badge always shows
something. Capture remains best-effort and must never affect the reply.

**I. Sections are computed in core and stored.** A pure, unit-tested assembler in
`reply-trace.ts` produces the contiguous `sections[]` + `windowMs` + `gap` remainder;
the admin only renders. The "sum == total" invariant is enforced in one place.
