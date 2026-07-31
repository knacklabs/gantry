---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-31
---

# Client sign-off is a one-time project gate, pinned in harness.yaml and derived

## Context

`record_signoff.py` took `candidates[-1]` — the highest-numbered
`NNNN-client-signoff.md` in the repo, whatever task it belonged to — and wrote that path
into `.factory/run.json` as the project's attestation. RACE-3's gate therefore passed by
citing CONV-001's record, confirmed by a different person, for an unrelated feature. It also
accepted and silently discarded `--notes`, because it parsed no arguments at all.

The root cause is not the `[-1]`. `.factory/run.json` is **gitignored and per-worktree**, and
every task runs in a fresh worktree, so the flag was always absent and the gate always had to
be re-run. Re-running was structural, not sloppy — and each re-run re-pointed the attestation
at whatever record was newest. Twelve `client-signoff.md` records now exist because every task
was pushed into minting one.

`WORKFLOW.md` has always said sign-off is a single gate sitting between `prototype` and
`planning`, and `intake.py` deliberately carried the flag forward ("Intake must never bypass
or erase the sign-off gate"). The documented design and the practice had diverged.

## Decision

Grilled with Ravi on 2026-07-31; five decisions:

1. **Sign-off is one gate for the project, not one per task.** The per-task human gate already
   exists and is stronger: plan approval, which is grilled and enforced against the same issue.
   A second per-task confirmation would be ceremony on top of it.
2. **`harness.yaml` pins the record** (`signoff_record: docs/decisions/0034-client-signoff.md`).
   Committed, so every worktree reads the same answer; an identity rather than a convention, so
   no later record can displace it. Parsed by regex, not YAML — these scripts are stdlib-only
   by design.
3. **The flag is derived, never recorded.** `client_signoff`, `client_signoff_record` and
   `client_signoff_at` are gone from `run.json`, along with `intake.py`'s carry-forward. Ten
   call sites now ask `factory_lib.client_signoff(root)`, which checks the pin resolves to an
   accepted, human-confirmed record.
4. **Re-running `record_signoff.py` on a signed-off project is refused**, and it takes real
   arguments — `--notes` is now an error instead of being swallowed. With several records
   present it refuses to guess and requires `--record`.
5. **The 11 non-project records stay.** They are accepted decisions and each documents a real
   human confirmation; rewriting decision history is worse than the clutter. Nothing reads them
   once the pin lands.

## Consequences

- **`forge init` and `forge adopt` blank the pin.** Found while implementing: a fresh scaffold
  copied `harness.yaml` verbatim and started life pinned to THIS project's record. It failed
  closed only because the record was absent in the new repo, with a baffling message. Both
  paths now clear it explicitly, and `init` does so before `write_manifest` or the frozen-gate
  manifest records pre-reset bytes and reports drift on a brand-new scaffold. `forge upgrade`
  already preserves project-owned `harness.yaml`, so an existing client's pin survives
  re-vendoring.
- **Deleting `.factory/run.json` can no longer bypass the gate at all.** It never should have
  (autoreview r6 on the plan gate), and previously the guarantee rested on message ordering.
  `plan save` now checks sign-off first, precisely because that check needs no run state.
- Sign-off can no longer be established by an agent quietly re-running a script: changing a
  pinned record is a reviewed edit to `harness.yaml`.
- Rejected: making sign-off per-task and enforcing the issue in frontmatter (duplicates plan
  approval); keeping a cached copy in `run.json` for display (two representations of one fact);
  taking the earliest record by convention (still a convention — a back-numbered file breaks
  it); annotating all 11 stray records (says once in `WORKFLOW.md` what would otherwise be
  repeated eleven times).
