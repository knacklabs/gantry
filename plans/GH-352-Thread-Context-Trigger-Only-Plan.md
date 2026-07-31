# GH-352 — Restore The Thread Window, Pin The Channel-Background Guarantee, Make The Allowlist Trigger-Only

Issue: `GH-352`
Branch: `fix/thread-channel-context-read-all`
Base: `origin/main` @ `3623be890`
Governing decisions: `docs/decisions/0089-thread-turns-read-channel-context.md`,
`docs/decisions/0090-sender-allowlist-trigger-only.md`
Sign-off: `docs/decisions/0091-client-signoff.md`
Signal: `S-0001-2b7e` (contradiction) — raised and resolved before planning

## Problem

Three things are wrong or fragile after the GH-352 report and the same-day
convergence of fixes on it:

1. `75e1f0617` fixed the real defect (top-level mentions routed into synthetic
   empty threads) but also shrank the thread window from 50 to 10 and dropped
   the first-replies selection block — against the client's locked 30/50.
2. The guarantee that saved us — in-thread turns already carry the 30-message
   channel background (`runtime/conversation-context.ts:43`) — is an accident
   of implementation, pinned by no test. The next refactor can silently remove
   it, and nobody would notice until the next Ranjana screenshot.
3. `mode: 'drop'` silently makes permanent history holes at write time
   (`channel-persistence-handlers.ts:146`,
   `group-conversation-context.ts:214`), the unmatched fallback is
   deny-AND-forget (`platform/sender-allowlist.ts:77`), and no Postgres test
   asserts that any sender's message is actually persisted.

## Scope / Non-goals

### In scope

- `THREAD_CONTEXT_LIMIT` 10 → 50; long-thread selection back to
  **root + first 10 + latest 39**. The runtime side must FETCH enough rows for
  that shape (root candidate, first 10 non-root replies, latest 39 non-root
  replies — `runtime/conversation-context.ts:103,109,130`), not just raise the
  constant. Slack's hydration selection mirrors the same shape
  (`selectHydratedSlackMessages`): the root is identified by
  `requestedThreadId`, NEVER positionally — when the root is absent the
  latest-only fallback stays (`slack/conversation-context.ts:478,481`); the
  tail formula is bounded for small parameterized limits (tests drive limits
  below 11): `tail = max(0, limit - 1 - min(10, max(0, limit - 1)))`.
- Pin the guarantee with tests: a thread-scoped turn's packet contains the
  channel background; the formatter renders it; dedupe excludes
  thread-selected messages from the channel block — the AC2 fixture must
  include an actually-overlapping top-level root so the test proves dedupe,
  not merely disjoint blocks.
- Allowlist trigger-only: remove `drop` from the mode union
  (`config/settings/sender-allowlist.ts:3,28`, platform types, contracts,
  SDK); `DEFAULT_ENTRY` becomes `{ allow: [], mode: 'trigger' }`; delete both
  persistence suppressions; **legacy `mode: drop` normalized to `trigger` at
  the parser** before the throw/discard cliff
  (`runtime-settings-parser.ts:127`, `platform/sender-allowlist.ts:220`);
  renderer writes the normalized value; CLI `--mode` parsing and the setup
  flow's "Only listed senders" choice (`setup-add-conversation.ts:291`) write
  trigger gating.
- Real Postgres integration test: an inbound message from a sender NOT on any
  allowlist is persisted and appears in the context window (the read-all
  guarantee at the persistence layer).
- Docs: update decision 0087's drop-mode boundary note and
  `docs/architecture/runtime-components.md:282` to the new invariant.
- Resolve deferral D-0030.

### Non-goals

- The mention-routing fix from `75e1f0617` — preserved exactly.
- Provider hydration scope (single-scope stays; channel background on thread
  turns is local-storage-only — noted in 0089).
- Any settings knob for window sizes; any "never record this sender" switch
  (explicitly rejected in 0090 — returns only as its own loud decision).
- LAT-5B (durable coverage) — next phase, unrelated files.
- The 16KB formatter cap and its eviction order — documented boundary.

## Acceptance Criteria

- **AC1** — Thread packet: for a thread with >50 messages, `activeThreadContext`
  is exactly root + first 10 + latest 39; for ≤50, the whole thread. Channel
  turns unchanged at 30.
- **AC2** — The guarantee: a thread-scoped turn's packet carries
  `recentChannelContext` (top-level messages present, thread-selected ones
  deduped out), and the rendered prompt contains the channel section before the
  thread section. Falsification: making the channel fetch conditional on
  "no active thread" must fail these tests.
- **AC3** — Slack hydration mirrors the restored selection (root by requested
  thread id + first 10 + latest 39, latest-only when root absent, bounded
  small-limit tail); LAT-5A coverage stays honest: `fullRangeResponse` remains
  the FIRST `conversations.replies` response and a blank tail cursor after a
  cursor-bearing first page still cannot claim exhaustion (the #357 scenario
  re-asserted at the 50 shape). Parameterized small-limit tests
  (`slack.test.ts:2586,2771`) and the already-50 Discord first-replies test
  are NOT mechanically altered.
- **AC4** — `drop` gone: the mode union across config/platform/contracts (both
  Zod schemas: `contracts/src/settings/index.ts:186`,
  `contracts/src/agents/index.ts:305`)/SDK (`sdk/src/agents.ts:15`)/CLI has
  exactly `trigger`; both persistence suppressions deleted. The invariant,
  stated honestly: **every non-self/bot inbound message on a REGISTERED route
  that reaches persistence is stored regardless of sender allowlist
  membership**. Unregistered chats keep their deliberate drops; Telegram
  media keeps D-0027's boundary. Trigger gating byte-identical
  (`isTriggerAllowed` never read `mode`).
- **AC5** — Legacy config: a settings.yaml containing `mode: drop` loads
  without error, normalizes to `trigger`, keeps its `allow` list for trigger
  gating, and the renderer writes the normalized form. Falsification: with
  normalization removed, the load must throw/discard — proving the test guards
  the cliff.
- **AC6** — Postgres (real DB): an inbound message from a non-allowed sender on
  a registered route is persisted with its conversation row and appears in
  `getRecentTopLevelMessagesBefore`. Runs in the Postgres integration lane.
- **AC7** — CLI: `--mode drop` is rejected with a clear message pointing at
  trigger-only semantics; the setup flow's "Only listed senders" writes
  trigger gating with the listed senders.
- **AC8** — Release gates green: `format:check`, `typecheck`, `lint` (no new
  errors), `test:unit`, `test:integration`, `test:integration:postgres`,
  `test:integration:postgres:hot-path`, `check:architecture`, `verify.py`.

## Technical Approach

Two independent seams, three stages.

**Window restore** is constant + selection-shape work in
`runtime/conversation-context.ts` (reintroduce `THREAD_LONG_FIRST_REPLIES = 10`
and `THREAD_LONG_LATEST_REPLIES = 39` alongside the root; the ≤limit path
unchanged) and the mirrored selection in `slack/conversation-context.ts`
(`selectHydratedSlackMessages` regains the first-replies block;
`slackThreadTailFetchLimit` returns to `limit - 1 - first10`). Tests pinned to
10/9 flip to 50-shaped values (`conversation-context.test.ts:217,260,300`,
`group-processing.test.ts:5793,6522`, `slack.test.ts:2687,2712,2841`).

**Trigger-only** is a narrowing. Normalization lives in the SHARED
hand-written parser `parseSenderAllowlistConfig`
(`config/settings/sender-allowlist.ts:50`), BEFORE its validity predicate —
not in the `parseSenderPolicy` wrapper — so both the runtime-settings path and
`loadSenderAllowlist` normalize identically (there is no zod schema ahead of
this parser on the disk path; the contracts schemas gate only API payloads).
Then: narrow the union, flip `DEFAULT_ENTRY`, delete `shouldDropMessage` and
its two call sites (registered-route gating at
`channel-persistence-handlers.ts:121-134` survives untouched; only the
sender-mode route filter dies), retain the hydrated filter's self/bot
exclusion while deleting its sender-drop branch
(`group-conversation-context.ts:214,221`), update ALL CLI mode surfaces
(`group-args.ts:66,289`, `group-helpers.ts:44`, `group.ts:710,731`,
`group-policy-format.ts:26,34`, `setup-add-conversation.ts:291,300,445` — the
"Only listed senders" copy must say everyone is recorded and only listed
senders can trigger), contracts + SDK types, renderer
(`runtime-settings-renderer.ts:447`), docs (`docs/SPEC.md:649` sender-denied
branch, decision 0087's boundary note, `runtime-components.md:282`), and the
`drop`-writing fixtures
(`conversation-install-settings.postgres.integration.test.ts:73`,
`cli/slack.test.ts:1081`, `sender-allowlist.test.ts:457`). The existing
suppression regression at `channel-wiring.test.ts:1327,1367` is INVERTED into
"non-allowed sender persists", not deleted; the `shouldDropMessage` unit suite
is replaced by normalization tests covering both load paths.

### Rejected alternatives

- Keeping 10 or root+latest-49 — rejected in 0089.
- Rejecting legacy `drop` configs at load (crash or silent wholesale discard) —
  rejected in 0090; normalization is the only non-destructive path.
- A deprecation period where `drop` still functions — nothing depends on it
  that the client wants kept; a half-removed mode is the worst of both.

## Decisions

0089 (window + guarantee), 0090 (trigger-only), 0091 (sign-off). D-0030
resolves on merge. No further new decisions.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | **Changed** | Thread window 10→50 with restored selection; non-allowed senders' messages now always persist; legacy drop configs normalize. |
| API | **Changed** | Contracts + SDK mode union narrows to `trigger`. Active development — no compat shim (client standing direction). |
| Data / schema | **Unchanged by design** | No migration; more rows persisted on previously-dropping configs is data volume, not shape. |
| CLI / ops | **Changed** | `--mode drop` rejected with guidance; setup flow writes trigger gating. |
| UI | **N-A** | No user-visible surface beyond prompts already rendered. |
| Docs | **Changed** | 0087 boundary note, runtime-components.md, decisions 0089/0090/0091. |
| Tests | **Changed** | Guarantee pins, window-shape flips, legacy-normalization, CLI rejection, real-Postgres read-all persistence. |
| Deferred | **Deferred** | Provider-backed channel hydration on thread turns (single-scope stays); any compliance never-record switch. |

## Task Decomposition

**Stage GH-352-1 — window restore + guarantee pins.**
Write scope: `apps/core/src/runtime/conversation-context.ts`,
`apps/core/src/channels/slack/conversation-context.ts`,
`apps/core/test/unit/runtime/conversation-context.test.ts`,
`apps/core/test/unit/runtime/group-processing.test.ts`,
`apps/core/test/unit/channels/slack.test.ts`,
`apps/core/test/unit/messaging/formatting.test.ts`.
AC1/AC2/AC3 with falsifications. Re-flip inventory (verified by critique):
`conversation-context.test.ts:142,217,260,300` (baseline fetch/limit,
complete-window, long-thread — which becomes root+first10+latest39 —
root-missing); `group-processing.test.ts:5793,6139,6220,6519,6584` (hydration
request, error and timeout `threadMessages`, full-window and missing-root
fixtures); `slack.test.ts:2687,2702,2747,2805` (#357's reconciled long-tail:
first request 50, tail 39, delivered 50, coverage metadata; dense-tail
selection back to root+first10+latest39). Leave `slack.test.ts:2586,2771`
(parameterized small limits) and `discord.test.ts:1581` (already 50) alone.
Verify: `typecheck`, the four suites.

**Stage GH-352-2 — trigger-only conversion.**
Write scope: `apps/core/src/config/settings/`,
`apps/core/src/platform/sender-allowlist.ts`,
`apps/core/src/app/bootstrap/channel-persistence-handlers.ts`,
`apps/core/src/app/bootstrap/channel-wiring-types.ts`,
`apps/core/src/app/bootstrap/channel-wiring.ts`,
`apps/core/src/runtime/group-conversation-context.ts`,
`apps/core/src/cli/`, `packages/contracts/src/`, `packages/sdk/src/`,
`docs/decisions/0087-lat-5-durable-provider-history-coverage.md`,
`docs/architecture/runtime-components.md`, plus their unit tests.
AC4/AC5/AC7 with falsifications.
Verify: `typecheck`, `lint` scoped, platform/config/bootstrap/cli unit suites.

**Stage GH-352-3 — read-all Postgres proof + full lanes.**
Write scope: `apps/core/test/integration/`.
AC6 seam: extend `inbound-envelope-statements.postgres.integration.test.ts` —
it drives real `handleTelegramTextMessage` through real
`createChannelPersistenceHandlers` with queue drain on real Postgres. Its
harness currently STUBS `shouldDropMessage` false / `isSenderAllowed` true
(`:91`) — the new case supplies a real restrictive allowlist and a non-listed
sender, then asserts the stored message AND its presence in
`getRecentTopLevelMessagesBefore`. (`conversation-install-settings` is the
wrong seam — projection only, no inbound handler.) Then full unit +
integration + Postgres lanes.
Verify: everything, then branch closeout.

## Risks

- **The guarantee pin must be falsifiable.** A test that passes both with and
  without channel background in thread packets pins nothing — AC2's
  falsification (make the fetch conditional, watch it fail) is mandatory.
- **Legacy-config cliff.** Normalization must run BEFORE `parseSenderPolicy`
  throws; getting the layer wrong silently discards whole configs via the
  `loadSenderAllowlist` catch. AC5's falsification proves the test sits on the
  cliff edge.
- **Teammate friction.** This partially reverts 75e1f0617's window shrink by
  explicit client decision (0089 records why). The mention-routing fix is
  untouched — stage 1's write scope deliberately excludes
  `channel-interactions.ts` / `channel-message-ingest.ts`.
- **LAT-5A coverage tests re-flip.** #357 just reconciled them to 10/9; stage 1
  flips them to 50-shaped values. Same falsification discipline; do not weaken
  the blank-tail-cursor scenario.
- **Setup-flow semantics.** "Only listed senders" must keep meaning something
  after drop dies: it writes trigger gating (listed senders may trigger). The
  CLI copy must say the agent still reads everyone.

## Verify Plan

1. Falsify AC2 (conditional channel fetch), AC5 (remove normalization), AC6
   (re-add the drop leg) once each; record the failures in stage evidence.
2. Per stage: smallest relevant suites, local autoreview on the uncommitted
   diff until clean, commit.
3. Branch closeout: merge main FIRST, then `format:check`, `typecheck`, `lint`,
   `test:unit`, `test:integration`, `test:integration:postgres` (sharded),
   `test:integration:postgres:hot-path`, `check:architecture`, `verify.py`
   (envrc vars, no `GANTRY_TEST_DATABASE_URL`, caffeinate), then `pr_ready`.
4. ONE branch autoreview, three lenses; record the three artifacts + tests.
5. Fresh disposable Postgres container (`gantry-gh352-pg`); `gantry-postgres`
   off limits.
