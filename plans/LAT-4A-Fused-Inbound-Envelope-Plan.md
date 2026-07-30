# LAT-4A — Fuse The Paired Inbound Envelope Into One Transaction

Issue: `LAT-4A`
Branch: `perf/phase4a-inbound-envelope-persistence`
Base: `origin/main` @ `98f40dce6`
Program: MyClaw Response-Latency Refactor, Phase 4A
Governing decision: `docs/decisions/0085-lat-4a-fused-inbound-envelope-transaction.md`
Sign-off: `docs/decisions/0086-client-signoff.md`
Signal: `S-0001-f4d3` (contradiction) — raised and resolved before planning

## Problem

Persisting one inbound envelope costs **28 SQL statements** on
the normal explicit-provider-account, no-thread, no-attachment route. Nine of
those are a **duplicate**: `ensureConversation` runs once in the metadata write
and again inside the message transaction, over the same seven tables, and
message persistence re-runs it without needing the separately committed metadata
row (`canonical-message-repository.postgres.ts:183`).

Fusing the two write phases into one transaction — the phase as literally
scoped — saves **zero statements and zero round trips**. Nine autocommit
statements plus `BEGIN` + 19 + `COMMIT` simply becomes `BEGIN` + 28 + `COMMIT`.

The saving comes from fusing *and then* invoking `ensureConversation` once,
which requires carrying `name` and `isGroup` into the surviving call. That is
what the roadmap means by "persist normalized metadata... in one serialized
transaction", and what A2 means by "carry name/kind metadata IN the ingress op".

## Scope / Non-goals

### In scope

- One serialized transaction for the **paired** inbound path: conversation
  graph state, message + part, participants, and all eligible admissions.
- `ensureConversation` invoked **once** inside it, receiving `name` and
  `isGroup` from the ingress envelope.
- Deletion of the paired metadata invocation once the surviving call covers it.
- Notify admissions **after commit**.

### Non-goals

- The six standalone metadata paths that never persist a message: Slack group
  discovery, Telegram group-join onboarding, unregistered Slack group messages,
  unregistered Telegram group text, Slack slash commands with no eligible route,
  unregistered Telegram group media. They keep their metadata write untouched.
- Collapsing the stable identity upserts *inside* `ensureConversation`.
  Plan-validation §1 calls that unsafe without a commit-backed graph-ready
  receipt. This phase deletes a redundant **call**, not the upserts within it.
- Optimising thread or attachment routes. Their behaviour must be preserved,
  not improved.
- Settings, schema/migrations, public API, SDK, CLI, permission surfaces.

## Acceptance Criteria

- **AC1** — On the measured route, persisting one inbound envelope issues **19**
  SQL statements, down from 28, counted against real Postgres with the
  measurement window held open until the persistence queue drains. The quantity
  is the total persistence cost of one inbound message, not "statements before
  the admission wake" — the wake is not observed, so asserting against it would
  claim a boundary the test never sees.
- **AC2** — `ensureConversation` is invoked exactly **once** per paired inbound
  message.
- **AC3** — For a **first group message**, `conversations.title` holds the
  supplied name (not the raw JID) and `conversations.kind` is `group` (not
  `direct`). This is precisely what a naive deletion breaks; a direct-only test
  would pass while shipping the bug.
- **AC4** — A later rename still propagates to `conversations.title`.
- **AC5** — All six standalone metadata paths still persist their conversation
  row, title and kind, with no message present.
- **AC6** — Multi-route: every selected route retains its admission identity and
  trigger decision.
- **AC7** — Admissions become observable only **after** commit; no wake can
  reference a message that is not yet committed.
- **AC8** — Message id and admission id/idempotency key remain deterministic and
  unchanged, so retries stay idempotent.
- **AC9** — Release gates green: `format:check`, `typecheck`, `lint`,
  `test:unit`, `test:integration`, `test:integration:postgres`,
  `test:integration:postgres:hot-path`, `check:architecture`, `verify.py`.

## Technical Approach

The public bundle currently exposes metadata only as a default-executor call
while message persistence opens its own transaction
(`canonical-ops-repo.postgres.ts:138`, `canonical-message-repository.postgres.ts:150`).
So the envelope operation must use the **executor-aware** graph and message
seams rather than nesting the existing public calls.

Shape:

1. Widen the ingress op that reaches message persistence to carry `name` and
   `isGroup` (the fields the metadata call supplies today).
2. In the message transaction, pass those through to the single
   `ensureConversation` invocation so it inserts/updates title and kind exactly
   as the metadata call would have.
3. Delete the paired metadata invocation at the ingress call site — only where a
   message follows.
4. Move the admission notify to after commit if it is not already.

Nothing in message persistence reads the metadata write today, so ordering is
not a constraint; the deterministic message and admission ids must be preserved.

### Rejected alternative

Wrapping both existing `ensureConversation` calls in one `BEGIN`. It is the
literal reading of "one transaction", it is a smaller diff, and it buys nothing
measurable — 0 statements, 0 round trips. Recorded in decision 0085 so the
cheaper-looking option is not re-proposed.

## Decisions

- `docs/decisions/0085-lat-4a-fused-inbound-envelope-transaction.md` — the
  governing record: the 28-statement breakdown, why fusion alone is worthless,
  the two traps (title/kind regression, six standalone paths), and the explicit
  boundary between deleting a redundant call and deleting the upserts inside it.
- `docs/decisions/0086-client-signoff.md` — sign-off for the sharpened scope.

No further new decisions.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | **Changed** | Inbound persistence becomes one transaction with one atomic visibility point; admissions notify after commit. |
| API | **Unchanged by design** | No control handler or SDK contract; the widened seam is an internal ingress op. |
| Data / schema | **Unchanged by design** | No migration and no new column. Same rows written, fewer statements. The lock window grows — accepted risk in 0082. |
| CLI / ops | **Unchanged by design** | No command, setting, or config key. |
| UI | **N-A** | No user-visible surface. |
| Docs | **Changed** | Decisions 0082 and 0083; measurement doc with before/after counts. |
| Tests | **Changed** | Statement-count assertions on real Postgres, title/kind regression, standalone-path coverage, multi-route admission identity, notify-after-commit. |
| Deferred | **Deferred** | Identity-upsert collapse inside `ensureConversation`, and thread/attachment route shapes — both named in 0082 with the conditions to revisit. |

## Task Decomposition

**Stage LAT-4A-1 — red-first statement baseline (tests only).**
Write scope: `apps/core/test/integration/`. Count statements on the paired
inbound path against real Postgres and assert **28**, plus assert
`ensureConversation` runs twice. Must pass at this commit, documenting the
baseline; stage 2 flips both numbers.
Verify: the disposable Postgres lane.

**Stage LAT-4A-2 — carry name/kind and fuse.**
Write scope: the ingress op type, the graph/message repository seams, and the
paired call site. Carry `name`/`isGroup`, invoke `ensureConversation` once,
delete the paired metadata invocation, notify after commit. Flip stage 1's
assertions to 19 and once.
Verify: `typecheck`, `lint`, `test:unit`, the Postgres lane.

**Stage LAT-4A-3 — the correctness net.**
Write scope: `apps/core/test/`. AC3 first-group-message title/kind, AC4 rename,
AC5 all six standalone paths, AC6 multi-route admission identity, AC7
notify-after-commit, AC8 deterministic ids. Capture the after-measurement.
Verify: full unit, integration, Postgres lanes.

## Risks

- **The title/kind regression is silent and easy to miss.** A test suite that
  only exercises direct conversations passes while group titles collapse to
  JIDs. AC3 exists solely for this and must use a *first* group message.
- **Six standalone paths are easy to break by over-deleting.** The temptation is
  to remove `onChatMetadata` entirely. AC5 covers all six by name.
- **Lock window growth.** Graph upserts that ran outside any transaction now sit
  inside one. Accepted in 0082; the revisit trigger is production contention.
- **Notify-before-commit would be a nasty, rare bug** — a wake for an
  uncommitted message. AC7 must assert ordering, not just presence.
- **Scope creep toward A2.** The adjacent upsert collapse looks tempting once
  the transaction is open. It is out of scope and unsafe without a graph-ready
  receipt. **Tripwire:** if review proposes touching the identity upserts,
  escalate per WORKFLOW.md Recurring Findings rather than widening this phase.

## Verify Plan

1. **Baseline must be real.** Stage 1's count runs against real Postgres via the
   disposable container, not a mock. If it does not observe 28, stop and
   re-measure rather than adjusting the number to fit.
2. **AC3 must be able to fail.** Confirm it fails if `name`/`isGroup` are not
   carried — that is the exact naive-deletion bug.
3. **AC7 must assert ordering.** Confirm it fails if notify is moved before
   commit.
4. Per stage: smallest relevant suite, then local autoreview on the uncommitted
   diff until clean, then commit.
5. Branch closeout: `format:check`, `typecheck`, `lint`, `test:unit`,
   `test:integration`, `test:integration:postgres`,
   `test:integration:postgres:hot-path`, `check:architecture`, then `verify.py`
   with the `.envrc` vars exported, **without** `GANTRY_TEST_DATABASE_URL`, under
   `caffeinate`.
6. **Real Postgres is required, not optional** (Program Acceptance §6). A
   disposable Docker container with `vector` and `pg_trgm` enabled before
   migrations, removed afterwards. The persistent `gantry-postgres` container
   backs real developer data and is off limits.
7. ONE branch-wide autoreview, three lenses, then record the three artifacts.
