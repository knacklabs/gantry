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

2. **Refuse out-of-order mirror writes, using a version marker inside the mirrored
   file itself.** The mirrored file carries a single inert trailing marker line
   recording the artifact version it was written from. `writeProfileFileMirror`
   reads that marker and **skips** a write whose version is older — last-*writer*
   no longer wins; highest-version wins. Writes are serialized per target path so
   two concurrent mirrors cannot interleave between the read and the rename. A
   skipped stale write is a normal outcome, not an error.

   The marker lives in the **same atomically renamed object as the content**, so
   version and content can never disagree. Read rules: file missing ⇒ no recorded
   version (proceed); file present without a marker ⇒ no recorded version (an
   unversioned write legitimately clears the claim, because its content replaced
   the marker); file present but **unreadable** ⇒ fail closed, abort this mirror
   attempt (non-fatal to the caller) rather than silently disabling the guard.

   *(Supersedes two earlier shapes review proved unsafe. A process-global `Map` is
   unfixable — unbounded it leaks an entry per target for the process lifetime, and
   bounding it with LRU eviction lets an evicted target accept an older version
   again. A separate `.version` **sidecar** is also unsafe, because two files can
   disagree: if the content rename succeeds and the sidecar write fails or the
   process exits between them, a later older write reads a stale/absent marker and
   overwrites newer content; mixing versioned and unversioned writes leaves the
   marker describing content it no longer guards. Only a single atomic object
   holds.)*

3. **Scope: in-process ordering only — stated up front.** The mirror is a *local
   convenience projection*; the durable artifact store remains the single source of
   truth. Production mirrors are per-worker/container-local, so the realistic
   interleaving is two concurrent updates inside one process, which this closes.
   Cross-process *coordination* (locking or fencing a shared mirror path) remains
   **out of scope** — no lease, no fencing token. The marker in §2 is colocated
   durable state, not coordination; it happens to make the guard hold across
   restarts and processes too, but nothing here depends on that. Mirror failures
   stay non-fatal (they already route through `reportSideEffectError`); a stale or
   skipped mirror must never fail the durable write.

4. **Safe reads.** The marker read happens *after* the mirror directory safety
   check, opens the target `O_RDONLY|O_NONBLOCK|O_NOFOLLOW`, requires a regular
   file via `fstat`, and reads only the final 1 KiB. A workspace-controlled target
   swapped for a FIFO, a device symlink, or a huge file therefore cannot hang or
   exhaust memory. Plain `O_NOFOLLOW` (final component) is used deliberately rather
   than darwin's `O_NOFOLLOW_ANY`, which rejects a symlink *anywhere* in the path
   and so fails on ordinary files under macOS temp dirs (`/var` → `/private/var`);
   the containing directory is validated separately.

## Not a compatibility surface

Pre-existing mirror file content is **not** an input this design accommodates
(no-backward-compatibility policy). The mirror is a projection: every write
replaces the file wholesale from the durable artifact, so any file written before
this change is superseded on its next write and needs no migration, escaping, or
format discriminator. The marker is the final line of every file we write, which
is the only case the guard has to reason about.

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
