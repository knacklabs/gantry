# LAT-5A — Adapters Report Actual History Coverage (Port Widening Only)

Issue: `LAT-5`
Branch: `perf/phase5-provider-history-watermark`
Base: `origin/main` @ `b2c061ee9`
Program: MyClaw Response-Latency Refactor, Phase 5, first of two PRs
Governing decision: `docs/decisions/0087-lat-5-durable-provider-history-coverage.md`
Sign-off: `docs/decisions/0088-client-signoff.md`
Signal: `S-0001-11ca` (contradiction) — raised and resolved before planning

## Problem

While a conversation's local window is incomplete, every eligible turn awaits
the provider hydration hook under a 2.5s ceiling
(`runtime/group-conversation-context.ts:21,42`), persists each accepted message
in its own transaction, and re-runs the local context query. Phase 5's cure is a
durable coverage record so complete conversations stop re-requesting — but that
record must hold what the PROVIDER returned, not a local row count, and today
**no adapter can say what the provider returned**.
`ConversationContextHydrationResult` exposes only
`attempted`/`skipped`/`failed`/`reason`/`messages`
(`domain/ports/conversation-context-hydration.ts:17`). Slack alone receives
`has_more`/`next_cursor` and discards them
(`channels/slack/conversation-context.ts:11,102,157`); Discord gets a bare page;
Teams a bare array. The durable record (LAT-5B) cannot be honest until the port
carries coverage facts. This PR delivers exactly that capability and nothing
else.

## Scope / Non-goals

### In scope

- Widen `ConversationContextHydrationResult` with an optional `coverage` block:
  what was requested (scope, limit, boundary), what came back (count), the
  provider's completeness claim as a **kind**, and the thread-root outcome.
- Slack reports `server_confirmed` completeness derived from the provider's own
  `has_more`/`next_cursor` — captured where they are discarded today.
- Discord and Teams report the weaker `request_bounded` claim, explicitly
  labelled as such. They must never claim `server_confirmed`.
- Hookless providers (Telegram and everything else) unchanged: same
  `unsupported` skip, no coverage block, no provider request.

### Non-goals

- **No behaviour change.** Hydrated messages, persistence, prompt output, the
  2.5s deadline, and the 30/50 limits are byte-identical for identical provider
  responses. Coverage is data no read path consumes yet.
- **No schema, no migration.** The `conversation_history_coverage` table, claim
  and generation are LAT-5B, gated on this PR merging.
- No interpretation helper that decides "complete enough to skip hydration" —
  that is a 5B read-path concern; adding it here would create an untested
  promotion surface.
- Settings, public API, SDK, CLI, permission surfaces.

## Acceptance Criteria

- **AC1** — The port carries, per attempted hydration: the latest-message input
  the request was built from, **one observation per actual provider request**
  (its role, limit, the effective cursor/bounds actually sent, raw response
  count, and that request's own pagination signals), a derived completeness
  claim that is a closed union of kinds, the normalized delivered count kept
  distinct from raw counts, and a thread-root outcome
  (`included` | `missing` | `not_applicable`).
- **AC2** — Slack: `exhausted: true` comes ONLY from the full-range request's
  own pagination — channel history's single page, or a thread's FIRST
  `conversations.replies` response (`has_more` falsy AND no usable
  `next_cursor` on THAT response). Tail-window queries
  (`fetchSlackThreadTailWindow`) are separate narrow `[oldest, latest)`
  requests and can never make anything more exhausted. Falsifications: (a)
  `has_more: true` → `exhausted: false`; (b) first page has a usable
  `next_cursor`, tail returns `next_cursor: ''` → `exhausted` must be
  **false** — this is the false-positive the current metadata merge
  (`conversation-context.ts:173-178`) would produce if read naively.
- **AC3** — Discord and Teams: `request_bounded` always; `server_confirmed` is
  unrepresentable from their adapters. Per-request observations carry the real
  requested limits and raw counts (Discord's separate root and first-reply
  fetches, Teams' root + replies each appear as their own observation).
- **AC4** — Hookless fallback (`channel-wiring-conversation-context.ts:28-36`)
  returns exactly today's object — no coverage key. Telegram remains untouched.
- **AC5** — Behaviour equivalence at the RUNTIME seam, not just adapter output:
  drive `buildGroupTurnConversationContext` with mocked channel + repository
  (the `group-processing.test.ts` pattern) and assert what gets persisted and
  the built context packet are deep-equal to pre-change for identical provider
  responses. Falsification: must fail if an adapter reorders, drops, or mutates
  a message while attaching coverage.
- **AC6** — Skipped and failed hydrations either omit coverage or carry one that
  cannot read as complete — a failed fetch must never look `exhausted`.
- **AC7** — `threadRoot` means presence in the adapter's **normalized returned
  window** — never a claim about whether the provider has a root. Tests cover:
  root filtered out by normalization, root fetch failed, and Teams'
  no-`getChannelMessage` path (all report `missing`).
- **AC8** — Release gates green: `format:check`, `typecheck`, `lint`,
  `test:unit`, `test:integration`, `test:integration:postgres`,
  `check:architecture`, `verify.py`.

## Technical Approach

One new exported type on the port (`domain/ports/conversation-context-hydration.ts`),
re-exported through the existing chains (`channels/channel-provider.ts`,
`app/bootstrap/channel-wiring-types.ts`, `runtime/group-processing-types.ts`):

```ts
export interface HydrationRequestObservation {
  /** Which provider request this was. */
  role: 'channel' | 'thread' | 'thread_tail' | 'thread_root' | 'thread_first_replies';
  limit: number;
  /** What was ACTUALLY sent to the provider, not the inbound source fields.
   *  Slack: derived ts cursor; Discord/Teams: before-message id; tails: oldest. */
  effectiveBounds: { cursor?: string; oldest?: string };
  rawMessageCount: number;
  /** This request's own pagination signals, untranslated. */
  pagination:
    | { kind: 'server_confirmed'; hasMore: boolean; hadCursor: boolean }
    | { kind: 'request_bounded' };
}

export interface ConversationContextHydrationCoverage {
  /** The latest-message input the request was built FROM (source fields). */
  requestedLatestMessage: { externalMessageId?: string; timestamp: string };
  scope: 'channel' | 'thread';
  requests: HydrationRequestObservation[];
  /** Derived claim. exhausted may only come from the full-range request's own
   *  pagination — never from a tail/root/first-replies observation. */
  completeness:
    | { kind: 'server_confirmed'; exhausted: boolean }
    | { kind: 'request_bounded' };
  /** Normalized output length — deliberately NOT called "returned": normalizers
   *  filter, dedupe and truncate, so raw counts live on the observations. */
  deliveredMessageCount: number;
  threadRoot: 'included' | 'missing' | 'not_applicable';
}
```

`ConversationContextHydrationResult` gains `coverage?: ConversationContextHydrationCoverage`.
Both new type names are added to the three EXPLICIT re-export lists — named
exports do not flow automatically. The capability difference is the `kind` —
data, not Slack-shaped optional fields — so no adapter is the reference
implementation and a fourth provider inherits the shape (decision 0087).
Per-request observations exist because thread hydration already makes multiple
disparate provider requests (Slack first page + up to five tail windows; Discord
latest page + root + first replies; Teams root + replies) — one aggregate
scope/limit/count would silently lose the evidence 5B's durable record needs.

Per adapter:

- **Slack** (`channels/slack/conversation-context.ts`): the completeness-bearing
  response is the FIRST full-range one. `fetchSlackThreadMessages` currently
  merges tail metadata over the first page's (`:173-178`) — the coverage
  derivation must capture the first response's `has_more`/`next_cursor` BEFORE
  that merge, and record each tail window as its own observation with its
  `oldest` bound. Thread-root comes from presence in the normalized window
  (Slack's `conversations.replies` returns the parent first, but normalization
  can filter it — `:323-361`).
- **Discord** (`channels/discord-conversation-context.ts`): observations for the
  latest page (`before` id as effective bounds), the explicit root fetch, and
  the first-reply page when made. Root outcome = survived normalization.
- **Teams** (`channels/teams-conversation-context.ts`): observations for the
  root fetch (only when `getChannelMessage` exists — its absence reports
  `threadRoot: 'missing'`, meaning "not in this window", never "no root") and
  the replies fetch with its reduced limit.
- **Wiring fallback**: untouched.
- **Consumer** (`runtime/group-conversation-context.ts`): untouched — coverage
  flows through unread. That is the point: 5B reads it, 5A proves it is honest.

### Rejected alternative

Optional `hasMore?: boolean` / `nextCursor?: string` fields on the result —
smaller diff, but it makes Slack's wire format the port's vocabulary, leaves
"absent" ambiguous between "provider can't say" and "adapter forgot", and lets a
read path treat `hasMore === undefined` as complete. Recorded in decision 0087.

## Decisions

- `docs/decisions/0087-lat-5-durable-provider-history-coverage.md` — governing:
  corrected premise (2.5s is a ceiling, not a per-turn cost), the two-PR split,
  completeness-as-kind, hookless providers out of scope, the drop-mode write-time
  boundary.
- `docs/decisions/0088-client-signoff.md` — sign-off: port first; Discord/Teams
  weaker claim explicitly labelled; dedicated table in 5B; 2.5s untouched.

Status note: 0087 is `proposed`, deliberately — the client's standing direction
(2026-07-29) is to draft/grill/ship gated decisions as proposed and continue;
acceptance is human-gated and pending his word. The plan does not pretend it is
accepted.

No further new decisions.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | **Unchanged by design** | Coverage is attached, never read. AC5 is the proof. |
| API | **Unchanged by design** | Internal port; no control handler or SDK contract. |
| Data / schema | **Unchanged by design** | No migration, no table — that is LAT-5B. |
| CLI / ops | **Unchanged by design** | No command, setting, or config key. |
| UI | **N-A** | No user-visible surface. |
| Docs | **Changed** | Decision 0087 already records the shape; plan archived on `pr_ready`. |
| Tests | **Changed** | Per-adapter coverage assertions with falsification, equivalence net, hookless-fallback guard. |
| Deferred | **Deferred** | Durable record, claim, generation, and any skip-hydration read path — all LAT-5B, gated on this PR merging. |

## Task Decomposition

**Stage LAT-5A-1 — port type + Slack coverage.**
Write scope: `domain/ports/conversation-context-hydration.ts`, the three
explicit re-export lists (`channel-provider.ts:31-34`,
`channel-wiring-types.ts:265-268`, `group-processing-types.ts:43-46`),
`channels/slack/conversation-context.ts`, Slack unit tests
(seam: mocked Bolt `conversations.history`/`replies`, `slack.test.ts:48-79`;
the long-tail fixture at `:2248-2345` already drives ordered responses).
First-page signals captured before the tail-metadata merge; one observation per
provider request. Tests: AC2 falsifications including the tail-blank-cursor
false positive, AC6, AC7 root-filtered case.
Verify: `typecheck`, `lint`, Slack unit suite.

**Stage LAT-5A-2 — Discord + Teams request-bounded coverage.**
Write scope: `channels/discord-conversation-context.ts`,
`channels/teams-conversation-context.ts`, their unit tests
(seams: Discord `globalThis.fetch` mock `discord.test.ts:1458-1529`; Teams
injected `TeamsSdkClient` `teams.test.ts:1053-1124`, rootless path
`:1152-1277`).
Tests: AC3 — kind is `request_bounded`, per-request numbers real,
`server_confirmed` unrepresentable; AC7 root-failed and no-`getChannelMessage`
paths.
Verify: `typecheck`, `lint`, Discord/Teams unit suites.

**Stage LAT-5A-3 — equivalence net + hookless guard.**
Write scope: `apps/core/test/`.
AC5 at the runtime seam (`buildGroupTurnConversationContext` with mocked channel
+ repository, the `group-processing.test.ts:6202-6268` pattern) asserting
persisted messages and the context packet are unchanged; AC4 hookless fallback
object unchanged; adapter-level deep-equality across all three for identical
fixtures.
Verify: full unit + integration lanes, then branch closeout.

## Risks

- **Silent promotion is the failure mode this shape exists to prevent.** If any
  helper later collapses the union to a boolean, `request_bounded` becomes
  complete. 5A refuses to add interpretation helpers at all; tripwire — if
  review proposes one, it belongs to 5B with its read-path tests.
- **Slack's tail-metadata merge is a completeness trap.** The merged response
  carries the TAIL's `next_cursor` over the first page's
  (`conversation-context.ts:173-178`); a naive read reports `exhausted: true`
  while the first page's unconsumed cursor proves more history exists. The
  derivation must capture the first response's signals before the merge. AC2's
  second falsification targets exactly this — it was found by plan critique,
  not review, and is the reason the first plan draft was unsound.
- **`exhausted` on an error path.** A failed fetch that reports a stale coverage
  block could poison 5B's durable record. AC6 pins failed/skipped shapes.
- **Type-only churn across four re-export files** invites incidental edits.
  Surgical rule: the re-export chains change by one exported name each, nothing
  else.

## Verify Plan

1. Every AC2/AC3 assertion must be **falsified once** — break the derivation
   (flip `has_more`, swap tail metadata, hardcode `server_confirmed` in Teams)
   and watch the test fail, then restore. Record in the stage evidence.
2. AC5 equivalence runs the SAME fixtures against pre-change expectations
   captured from `origin/main` behaviour, not from the new code.
3. Per stage: smallest relevant suite, local autoreview on the uncommitted diff
   until clean, then commit.
4. Branch closeout: merge main FIRST, then `format:check`, `typecheck`, `lint`,
   `test:unit`, `test:integration`, `test:integration:postgres`,
   `check:architecture`, then `verify.py` with `.envrc` vars exported,
   **without** `GANTRY_TEST_DATABASE_URL`, under `caffeinate`; then `pr_ready`.
5. ONE branch-wide autoreview, three lenses, then record the three artifacts.
6. Postgres lane uses a fresh disposable container (`vector` + `pg_trgm` before
   migrations); `gantry-postgres` is off limits.
