<!-- Promoted verbatim from the session scratchpad (proactive-observer-plan.md) on 2026-07-22; design of record for the Observer program per goals-index.md. -->

# Plan: The Curious Observer — proactive insight digest (v1, batch-native)

Design of record. Grilled + adversarially reviewed (Fable design critique + Codex code
validation, 2026-07-21). Reflects every locked decision and critique fix.

## Context
Users don't see the agent's value because it only speaks when tagged. The host already hears
everything (Slack/TG/Discord firehose → `brain-channel-harvest.ts`, per-conversation
`brain_harvest`) and a nightly dream job already extracts knowledge — but nothing ever
surfaces it, and `RUNTIME_MEMORY_DREAMING_ENABLED` defaults off so evidence never becomes
active memory. Goal: a background "curious employee" that, at most once a day, sends the owner
a PRIVATE digest of concrete, high-value, FRESH, verifiable things it noticed — behind a
deterministic gate, with zero per-message LLM cost.

## Locked decisions
| Fork | Decision |
|---|---|
| Delivery | Private digest to the owner + keep the existing piggyback on active turns |
| Insight source | Repetition (existing loop) + brain content-insight |
| Value gate | Deterministic floor first; the only LLM judging rides the nightly BATCH, never per-message |
| Surface scope | **Per-channel opt-IN**, default OFF (trust-safe; bot discloses observing). LOCKED. |
| Plan scope | Proactive feature + memory prereq (activate evidence→active dreaming). Deep memory work deferred. |
| Cadence | Threshold-gated, ≤1/day, quiet hours; below threshold → no send |
| Batch | **In v1.** Extend the Model Gateway; morning-after timing; Anthropic+OpenAI+xAI/Kimi transports |
| Settings | v1 wizard sets the existing `memory.*` keys to optimal — NO `observer` facade (doesn't round-trip) |
| v1 quality | Full: send-time freshness revalidation + evidence permalinks, semantic dedup, feedback capture |

## Architecture (layers → real seams; critique fixes inline)

### L0 prereq — activate evidence→active + a SEPARATE insight cursor
- Activate dreaming per-app (cron + wiring exist, `system-jobs.ts:280`); surface honest off-state.
- CRITIQUE FIX (Codex C1): the brain dream advances the SOLE app cursor (`brain-dreaming.ts:109,148`).
  Enabling dreaming before insight-emission exists would permanently skip that backlog. → give
  insights their OWN cursor/backfill, OR install the insight emitter before activation. Also
  reconcile the discrepancy: Codex found fresh setup already defaults dreaming ON
  (`setup-flow-state.ts:297`) vs the CLI map's "off/invisible" — verify before building.

### L1 harvest — unchanged, per-message, ZERO LLM
- `channel-persistence-handlers.ts:172` → `brain-channel-harvest.ts:48` writes pages `embed:false`;
  `BrainService.write` only embeds when flag≠false (`brain-service.ts:124`). No change.
- NOTE (Codex C3): bot/self messages are excluded before harvest (`channel-persistence-handlers.ts:199`),
  so delegated/subagent output is NOT a brain source today — out of scope unless we add an
  attributed evidence path.

### L2 insight emission + deterministic floor (rides the nightly proposer)
- Extend the brain proposer output (`brain-dreaming.ts:62-130`, independent per-page calls — Codex
  confirmed cleanly batchable) to also emit `surfaceableInsights[]`. **Taxonomy (Fable): commitments/
  follow-ups ("X said they'd ship Y by Fri" — highest-value), contradictions, open-questions,
  stale-facts, decisions-without-owner, duplicated-work-across-channels. CUT `notable_entity` (filler).**
- Deterministic floor: novelty + confidence + evidence-count + not-already-active-memory. Repetition
  candidates keep coming from `detectPatternCandidates` (`app-memory-dreaming.ts:280`).

### L3 batch transport (IN v1 — built to Codex's bar)
- **Extend the Model Gateway** to allow `/v1/files` + `/v1/batches` (today rejected —
  `gantry-model-gateway-routing.ts:172`, test `gantry-model-gateway.test.ts:1583`); keep single-authority
  creds + per-app security. NOT a bypass.
- New chat-batch capability on the model descriptor (`model-provider-registry.ts:132` declares none
  today) + a `batch?` port beyond `query()` (`memory-llm-client.ts:34`). Transports: **Anthropic
  (`/v1/messages/batches`) + OpenAI (`/v1/files`+`/v1/batches`) + xAI Grok + Kimi.** Declared-capability
  detection (`Boolean(provider.batch)`), `auto|inline|provider_batch` + min-items; non-capable → live.
- **Restart-safe state machine — "no double-spend + best-effort recovery"** (provider batch-create is
  NOT idempotent — Anthropic/OpenAI expose no idempotency key, so true idempotency is impossible; the
  embedding impl creates the remote batch BEFORE recording its id at
  `app-memory-backfill-provider-batch.ts:45` and orphans paid work on crash). DECIDED semantics
  (2026-07-22): persist a submission-intent + `gantry_batch_correlation_id` BEFORE submit; pass that id
  in provider metadata; on the crash window mark `submission_unknown` and NEVER auto-resubmit (no
  double-spend); on restart, best-effort READ-ONLY list+metadata match to adopt an orphan (OpenAI yes,
  Anthropic best-effort), else `abandoned` + surfaced (rare, budget-capped). Keep immutable content-hash
  snapshot, transactional apply/cursor, and download/JSONL parse-error handling (not just poll errors).
- Batching removes 25 sequential waits but is still N independent requests (NOT one cross-page judge);
  APPLY phase mutates shared entity/edge/page state in page order → durable page→result mapping,
  ordered replay, per-page validation, cursor recovery.
- **Own cost accounting**: the embedding daily-cap is NOT reusable (in-process counter /
  per-run candidate cap). v1 batch needs persisted token/USD accounting, retry ceilings, file-size limits.

### L4 digest delivery (morning-after) + owner identity + settlement
- **Owner-identity primitive (NEW — Codex C2/B4):** nothing designates an app owner or owner-DM route
  today; the cited `live-execution.ts` seam was WRONG — delivery goes via scheduler notification routes
  and needs a NEW trusted job identity + handler branch (unknown system prompts rejected,
  `system-job-identity.ts:23`). Build owner designation + canonical owner-DM route.
- Timing: submit night N → poll (results ≤24h) → assemble → send when ready (usually next morning).
  Poll-cron runs BEFORE submit today (`system-jobs.ts:554`) so the digest CANNOT assume "after dreaming"
  = ready; stage it explicitly.
- **Delivery settlement (Codex C2):** notification idempotency is keyed by job/run/phase/route
  (`job-notification-routes.ts:51`) — NOT recipient/day → double-send risk. Enforce recipient/app/
  local-day uniqueness in Postgres; aggregate all subjects before delivery; mark insights surfaced ONLY
  after durable delivery settlement. Quiet-hours needs explicit TZ/DST semantics.
- **Freshness revalidation (Fable #1 — the credibility gate):** at assembly time, drop/re-queue any
  insight whose evidence thread had activity after the batch snapshot. Every insight carries evidence
  PERMALINKS (one-click verify). De-attribution rule: never name individuals in copy.

### Quality mechanisms (full-quality v1)
- **Dedicated `proactive_insights` table (Codex B4/C4)** — NOT `pattern_candidates` (repetition-specific,
  hardcoded floors). Canonical insight IDENTITY (semantic signature, not text-hash — Fable #3 + Codex),
  evidence-set + version, states `pending→claimed→sent→cooldown→resolved`, recipient, delivery id.
  Migration ships before job registration (runtime refuses unapplied migration, `storage-service.ts:166`).
- **Semantic dedup** against the surfaced set (reuse embeddings) + feed prior-surfaced insights to the
  batch judge as negative examples — kills nightly paraphrase repeats.
- **Feedback capture in v1** (Fable #4): reactions / "less like this" / reply-tracking on the digest DM;
  one crude rule (2 negatives on a type → suppress that type). Self-tuning learning loop stays deferred.
- **Digest artifact design (Fable #5):** ≤3 insights, grouped, plain tone, reply-to-digest + one-tap
  snooze. Cold start: first run BACKFILLS over harvested history so `observer preview` = "here's what I'd
  have told you last week" (instant aha + informed consent).

## Settings / CLI UX (wizard sets existing keys — no facade)
- `gantry observer setup` = one wizard step (extend `apps/core/src/cli/setup-flow.ts`, clack, template
  `runMemoryStep`) that writes the existing `memory.*` keys to optimal (dreaming on, embeddings+semantic
  on, batch auto, cadence, floor). Accept-defaults = best experience. NO `observer` block (Codex B3: a
  facade erases `mode:optimal` on the first revision sync + dual authority).
- `gantry observer preview` — model on `gantry next --preview` / `GuidedActionService.preview()`
  (side-effect-free); runs the pass over history, shows the would-be digest, sends nothing.
- `gantry observer status` — extend `gantry memory status`; ADD evidence-count / last-run / last-digest
  (new reads vs `memory_dream_runs`/`proactive_insights`, or `gantry jobs show`).
- Channel opt-in: `brain_harvest` (live, no restart) + in-chat `proactive_surfacing_consent`. NOTE
  (Codex C3): consent repo has no list-enabled query and the IPC handler doesn't pass the conversation
  JID into `setEnabled` — both need adding to supply a delivery/source route.
- GOTCHA: every `memory`-block write is restart-owned → wizard offers `gantry restart`. Semantic recall
  is not provider-neutral (OpenAI is the only registered embedding provider) — validate at setup.

## API + SDK + E2E (cross-cutting — required on every stage, user directive)
Every stage ships with a control-plane API surface, matching SDK methods, and E2E coverage
(the merge bar). Follow existing conventions (`control/server/routes/*`, the SDK client package,
the agent-e2e/control harnesses) — do not invent parallel surfaces.
- **API** grows by stage: S1 read-only `GET /observer/status` + `GET /observer/insights`; S2 adds
  insight listing/filtering; S4 adds `POST /observer/preview` (dry-run) + digest history; S5 adds
  enable/config + `watch/unwatch`.
- **SDK**: a matching `observer.*` client namespace, typed, error-conventional, per stage.
- **E2E**: each stage's user-visible behavior gets an agent-e2e/control E2E test (real API→DB→SDK
  round-trip), behavioral assertions only. E2E is the merge gate.

## Stages (each behind a flag, default OFF)
1. Owner identity + `proactive_insights` migration + insight cursor + activate dreaming (honest off-state).
2. Insight emission (proposer output + taxonomy) + deterministic floor + semantic dedup.
3. Batch transport: gateway extension + chat-batch port/transports (Anthropic/OpenAI/xAI/Kimi) +
   idempotent submit→poll→apply state machine + cost accounting.
4. Digest job: morning-after staging + delivery settlement (recipient/day uniqueness) + freshness
   revalidation + permalinks + feedback capture + digest artifact.
5. Wizard step + `observer preview`/`status` + cold-start history backfill.
6. Follow-on: self-tuning from feedback; deep memory fixes (semantic interactive recall, continuation
   parity, decay/importance, eval gold-set).

## Verification
- **Cost guard (load-bearing):** exercise `createChannelPersistenceHandlers` with the real harvester +
  a mock `MemoryLlmClient.query`; assert ZERO calls at the canonical handler boundary (Codex B5 — a
  harvester-only test would miss a future LLM call above it).
- Batch: idempotency across a simulated crash (submitted intent not resubmitted / not orphaned); apply
  ordering + cursor recovery; download/parse-error handling; per-provider transport fixtures.
- Digest: below-threshold → no send; recipient/app/local-day uniqueness (no double-send on retry);
  quiet-hours/DST; freshness revalidation drops a post-snapshot-resolved insight.
- Semantic dedup: a paraphrased repeat of a surfaced insight is suppressed.
- Existing dream/brain/settings suites stay green; typecheck + lint per stage.

## Risks / open items
- Batch-in-v1 is the big cost — real infra (gateway + transports + state machine + accounting). Accepted.
- Reconcile the dreaming-default discrepancy (setup ON vs CLI map "off") before Stage 1.
- Multi-owner/tenancy: system job ids are hardcoded global/default-app singletons (`system-jobs.ts:511`);
  per-app owner attribution needs app-qualified batches/jobs.
- Noisy-channel weighting (#random dominating evidence counts); success metric for "the digest works".

## Deferred (follow-on)
Self-tuning floor from feedback; semantic interactive recall; same-process continuation parity;
decay/importance (use `loadBearing`/retrieval counters); memory-quality eval gold-set.
