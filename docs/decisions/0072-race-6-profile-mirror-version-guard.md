---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-28
---

# Order profile-file mirror writes by artifact version

## Context

Agent profile files (SOUL.md / AGENTS.md) are stored durably as versioned file
artifacts and *also* mirrored to a workspace file for humans and local tooling to
read. The durable write is properly version-guarded — `AgentProfileService`
fast-fails on a stale `expectedVersion` and the store re-checks it atomically,
raising `FileArtifactVersionConflictError`
(`apps/core/src/application/agents/agent-profile-service.ts:215-243`).

The **mirror** that follows is not. It is called with content only — no version
(`agent-profile-service.ts:244-250`) — and `writeProfileFileMirror` does a
tmp-`open('wx')` then `rename` (`apps/core/src/platform/profile-file-mirror.ts:120-124`).
Each individual write is atomic (no torn file), but nothing orders two of them:

1. Update A durably commits version 10 and begins a slow mirror write.
2. Update B durably commits version 11 and completes its mirror write.
3. A's delayed `rename` lands last.

Durable truth is version 11; the visible mirror holds version 10. Operators,
agents, and local tooling then read stale profile content, and recovery/import
logic can reason from state that disagrees with the store.

## Decision

1. **Carry the artifact version into the mirror.** The durable write already
   returns the committed artifact (with its version); thread that version through
   `ProfileMirrorInput` into `writeProfileFileMirror`. The mirror stops being a
   content-only side effect and becomes a versioned projection.

2. **Refuse out-of-order mirror writes, using state colocated with the target.**
   The mirrored version is recorded in a small sidecar next to the mirror file, and
   `writeProfileFileMirror` **skips** a write whose version is older than the
   sidecar's — last-*writer* no longer wins; highest-version wins. Writes are also
   serialized per target path so two concurrent mirrors for the same file cannot
   interleave between the read and the rename. A skipped stale write is a normal
   outcome, not an error.

   *(Supersedes a process-global `Map` of last-mirrored versions. Review showed
   that shape is unfixable: unbounded it leaks an entry per target for the process
   lifetime, and bounding it with LRU eviction silently drops the guarantee — an
   evicted target accepts an older version again, which is the very bug this
   closes. Version state belongs **with the target**, not in a cache: nothing to
   grow, nothing to evict, and the guard survives restarts.)*

3. **Scope: in-process ordering only — stated up front.** The mirror is a *local
   convenience projection*; the durable artifact store remains the single source of
   truth. Production mirrors are per-worker/container-local, so the realistic
   interleaving is two concurrent updates inside one process, which this closes.
   Cross-process *coordination* (locking or fencing a shared mirror path) remains
   **out of scope** — no lease, no fencing token. The sidecar in §2 is colocated
   durable state, not coordination; it happens to make the guard hold across
   restarts and processes too, but nothing here depends on that. Mirror failures
   stay non-fatal (they already route through `reportSideEffectError`); a stale or
   skipped mirror must
   never fail the durable write.

## Consequences

- **Touched:** `apps/core/src/application/agents/agent-profile-service.ts` (pass
  the version), `apps/core/src/application/agents/prompt-profile-service.ts`
  (`ProfileMirrorInput` gains the version), `apps/core/src/platform/profile-file-mirror.ts`
  (per-target serialization + skip-if-older), and their unit tests.
- **No schema or storage change**; the version already exists on the artifact.
- **Behavior change:** a mirror write can now be *skipped*. That is the point — the
  visible file converges on the newest committed version instead of whichever
  rename happened to land last. Skips are logged at debug, not surfaced as errors.
- **Bounded by construction:** no lease, no fencing token, no cross-process
  coordination. Unlike RACE-2/RACE-4, ordering here needs only a monotonic version
  that already exists.
- Closes RACE-6.
