---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-28
---

# Make runtime lease loss observable and check it after connect

## Context

A runtime lease can be lost while its holder is still working, and today that loss
can be **silently missed**:

- `RuntimeLease` exposes only `onLost?` and `release`
  (`apps/core/src/domain/ports/runtime-lease.ts:1-6`) — no validity state.
- The Postgres implementation fires the handler set that exists **at the moment of
  loss** and never replays: `notifyLost` sets `released = true` and iterates
  `lostHandlers` (`apps/core/src/adapters/storage/postgres/runtime-store.ts:131-135`), while a
  later `onLost` call merely `.add()`s to the set
  (`apps/core/src/adapters/storage/postgres/runtime-store.ts:149`). A handler registered *after* loss never fires.
- `apps/core/src/channels/provider-account-channel-connect.ts` acquires the inbound lease (`:180-182`),
  **awaits `channel.connect(...)`** (`:201-204`), and only then registers the loss
  handler (`:209-211`). `connect` does real blocking work per provider — Slack
  `app.start()` + `auth.test()`, Discord gateway discovery + `gateway.connect()`,
  Teams `sdkClient.start()`. A lease lost during that window is therefore lost
  forever, and the channel is published as an active inbound owner anyway. Teardown
  on loss is also fire-and-forget (`:216`).
- Telegram's poll-lease loss handler drops the lease reference and schedules a retry
  but **never stops the running bot** (`apps/core/src/channels/telegram/channel-polling.ts:52-60`,
  versus the normal disconnect path at `apps/core/src/channels/telegram/disconnect.ts:101`), so two pollers
  can consume the same account.

The fix shape already exists in this repo. RACE-4's browser-profile wrapper
implements exactly the missing semantics — it stores `lostError`, exposes `isValid`,
and immediately invokes a handler registered after loss
(`apps/core/src/runtime/browser-profiles.ts:241, 252-253`). This decision promotes that proven
pattern into the port rather than inventing anything.

## Decision

1. **Loss becomes replayable and queryable on the port.** `RuntimeLease` gains
   `isValid()`, and `onLost` replays to a late subscriber when the lease has already
   been lost. The Postgres implementation retains the loss error and answers both.
   This is the `apps/core/src/runtime/browser-profiles.ts` behaviour, moved to where every consumer gets it.

2. **Register before connect, verify after.** The inbound path registers the loss
   handler **immediately after acquisition**, before any `await`, and after
   `channel.connect` returns it re-checks loss/validity before publishing the channel
   as an active owner. Teardown on loss is awaited rather than fire-and-forget.

3. **Telegram stops the poller on loss.** The poll-lease loss handler stops the
   active bot before scheduling any retry, so a successor cannot double-consume.

## Scope — and what this explicitly does NOT do

This slice closes the **loss-detection and teardown** races. It does not provide
durable rejection of a stale owner's already-dispatched work, and does not pretend to:

- **No durable fencing generation.** Sequenced separately (see below). None of the
  three fixes above need it.
- **No stale-event rejection.** There is no single inbound admission choke point:
  `onMessage`/`onChatMetadata` converge at
  `channel-persistence-handlers.ts:146/179`, but `onMessageAction` bypasses that
  wrapper entirely (`channel-wiring.ts:240`, invoked from Telegram review callbacks
  and Discord interactions). A callback can also pass a precheck and stay queued while
  persistence runs async. Fencing dispatched events therefore needs the durable
  generation **plus** per-event-class conditional writes — a separate, larger task.

**Sequencing (why RACE-5 ships alone):** exploration confirmed RACE-5 and RACE-4b are
separable. Next slices, in order: (2) a durable per-lease-key generation returned at
acquisition, then (3) RACE-4b — browser successor quarantine with confirmed
termination of the prior generation, a profile-generation CAS on snapshot publication,
and generation-scoped snapshot suppression (D-0016, D-0017). Note the existing
`snapshot_fencing_version` fences the *snapshotting turn's run lease*, not
browser-profile ownership (`browser-profile-snapshot.ts:10/25`), so RACE-4b needs an
**additional** authority rather than a reuse of that column.

## Consequences

- **Touched:** `apps/core/src/domain/ports/runtime-lease.ts`, `apps/core/src/adapters/storage/postgres/runtime-store.ts`,
  `apps/core/src/channels/provider-account-channel-connect.ts`,
  `apps/core/src/channels/telegram/channel-polling.ts`, their tests, and mechanical updates to lease
  fakes in tests that construct a lease literal.
- **`isValid()` required on the port** means every lease fake must supply it — a
  compile error rather than a silent gap, matching RACE-8's precedent.
- `apps/core/src/runtime/browser-profiles.ts` keeps working unchanged; its local wrapper becomes
  redundant with the port and can be simplified later (not in this slice, to keep the
  diff honest).
- **Behaviour change:** an inbound channel whose lease was lost during `connect` is no
  longer published as active — it fails closed instead of running unowned.
- Closes RACE-5. RACE-4b (D-0016/D-0017) and the durable generation remain open and
  are now explicitly sequenced.
