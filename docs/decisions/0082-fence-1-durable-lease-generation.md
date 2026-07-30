---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-29
---

# FENCE-1: durable lease generation for RuntimeLeasePort

## Context

RACE-4 (decision 0071) and RACE-5 (decision 0077) both stopped at the same
boundary. Each shipped ownership *exclusion* — an advisory lease replacing a
hand-rolled lockfile, and loss detection with `isValid()` / `onLost()` — and each
deferred the *handoff* contract because a successor can acquire a freed lease while
the previous owner is still shutting down, and a stale owner's async write can
commit after handoff. Four deferrals came out of that boundary: D-0016 and D-0017
(browser), D-0020 and D-0021 (provider inbound).

Two facts about the existing code shape this decision, and the first corrects the
initiative's own framing:

1. **Durable monotonic fencing already exists.** `run_leases` carries
   `fencing_version`, issued as `previousFencingVersion + 1` under CAS in
   `worker-coordination-lease.postgres.ts`, with fence-checked writes in
   `run-lease-fence.postgres.ts`. The browser snapshot repository *already* accepts
   `snapshotFencingVersion` and performs a monotonic CAS on
   `(snapshotFencingVersion, snapshottedAt)`, returning `stale` for a losing writer.
   So this task must **issue a generation to lease holders**, not invent a fencing
   mechanism. The backlog note "shares its fencing-token design — do them as ONE
   task" read as build-a-new-token and was wrong.

2. **`RuntimeLeasePort` has no generation.** It is a bare, connection-scoped
   `pg_try_advisory_lock` (`tryAcquireRuntimeAdvisoryLease`). Because no generation
   reaches the snapshot path, `snapshotFencingVersion` defaults to `0` there and the
   existing CAS is effectively inert. The port's holders are the browser profile
   lock, the settings projector, Telegram polling and provider inbound.

`run_leases` cannot host these keys: it is primary-keyed on
`(run_id, fencing_version)` with NOT NULL foreign keys to `agent_runs` and
`worker_instances`, so `browser-profile:<name>`, `settings-projector:<appId>` and
`telegram:poll:<hash>` have no place in it.

## Decision

Issue a **durable generation with every `RuntimeLeasePort` acquisition**, stored in a
new table keyed by lease key, following `run_leases`' monotonic-CAS discipline rather
than extending that table. Wire the generation into the browser consumers only:
the snapshot upsert CAS (D-0016) and the snapshot loss-suppression marker, which
becomes generation-scoped instead of a process-global profile-name marker (D-0017).

Scope boundaries, all confirmed by Ravi at the sign-off grill (2026-07-29):

- **Everywhere, not fleet-only.** A generation is issued on every lease acquisition
  including single-process. Fence `0` survives only for paths that take no lease.
- **Browser consumers only.** D-0020 (abort an in-flight `channel.connect`, or defer
  inbound admission until ownership is revalidated) and D-0021 (act on a failed
  lease-loss teardown) are **not** in this task and stay deferred to FENCE-2.
- The settings-projector and Telegram-polling holders receive a generation but get
  no fence check, because neither has a known stale-write sink and no deferral asks
  for one. Stated choice, not an oversight.

## Amendment (2026-07-29): ownership vs shared acquisition

Branch autoreview found the first cut of the fence was weaker than this record
claimed. The snapshot CAS compared the incoming generation only against the
**stored row**, so a stale owner still won whenever the row was behind: A owns
generation 1 and releases, B acquires 2 and starts using the profile, and A's
delayed generation-1 write lands while the row is still 0 — accepted.

Fencing against `runtime_lease_generations` was impossible as built, because the
snapshot path acquires the **same** lease key and therefore bumps the very
counter it would check. `RuntimeLeasePort` now distinguishes:

- **ownership** acquisition (default) — advances the generation; a new epoch.
- **shared** acquisition — takes the same advisory lock, so mutual exclusion is
  unchanged, but reports the current generation without advancing it.

The snapshot path acquires shared, and the upsert is guarded against the latest
issued generation for the profile's lease key. The guard is applied inside one
`INSERT ... SELECT ... WHERE ... ON CONFLICT ... WHERE` statement so it covers
the INSERT path too — guarding only the conflict path would let a stale owner
publish the first row — and so a concurrent acquisition cannot slip between a
read and the write.

Rejected here: holding ownership from launch through snapshot (blocks handoff for
a whole browser session, the stall RACE-4 fixed) and giving snapshots a separate
lease key (that would drop the exclusion which stops snapshotting a browser
mid-relaunch).

## Accepted risk: mixed-version deployments

An old binary's upsert ignores `snapshot_lease_generation`, so during a rolling
deploy it can overwrite a fenced row on the old (fence, timestamp) rule while
leaving the generation label untouched — stale content then reads as the newer
generation. **Accepted by fiat** (Ravi, 2026-07-29) under this repo's
no-backcompat policy and today's effectively single-instance runtime. Deploy
expectation: restart workers together for this migration rather than relying on
a mixed-version window. If the fleet ever runs genuinely concurrent versions,
this needs a database-enforced guard instead.

## Consequences

- One migration adding the generation table. No change to `run_leases`, so the
  agent_runs / worker_instances integrity guarantees and the live run-recovery path
  are untouched.
- `RuntimeLease` gains a generation the holder can pass to fence-checked writes.
  Existing consumers keep working, since a fence of `0` is the current behaviour.
- The browser snapshot CAS becomes effective on workstations, where it was inert.
  A stale owner's late snapshot now loses instead of overwriting.
- **Rejected: widening `run_leases`** to accept arbitrary keys. It would require
  making `run_id` / `worker_instance_id` nullable, discarding FK guarantees that hold
  today, and would put this change in the path of run recovery.
- **Rejected: a process-local generation.** A restart resets the counter, so a stale
  write can still win the CAS — it does not close D-0016.
- **Rejected: combining the inbound pair into this task.** This initiative's own
  evidence is that mixing exclusion with the handoff contract is what cost RACE-2
  eight autoreview rounds, RACE-4 nine and RACE-5 six.
- D-0020 and D-0021 stay open. Their current revisit trigger ("the durable
  lease-generation slice lands") fires when FENCE-1 merges, so both must be
  re-pointed at FENCE-2 at closeout rather than left looking satisfied.
