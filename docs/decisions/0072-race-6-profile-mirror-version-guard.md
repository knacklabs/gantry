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

2. **Serialize per target and skip an older version while a newer one is live.**
   Mirror writes for one target are chained, so two concurrent mirrors can never
   interleave. The chain carries the highest version applied during its lifetime,
   and a write whose version is older than that is **skipped** — last-*writer* no
   longer wins; highest-version wins. A skipped stale write is a normal outcome,
   not an error. The version lives **only on the chain**: when the chain drains its
   entry is removed and the version is forgotten, so the state is bounded by
   construction — no cache, no cap, no eviction, nothing to leak.

3. **Nothing is persisted. The mirror file gains no metadata.** A mirrored file
   contains exactly the pre-existing managed header plus the caller's content.

   *(This supersedes four shapes review rejected in turn, and the reasoning is the
   value here. A process-global `Map` cannot be both bounded and correct —
   unbounded it leaks an entry per target for the process lifetime; bounded by LRU
   it lets an evicted target accept an older version again. A separate `.version`
   **sidecar** can disagree with the content it guards, because a content rename
   that succeeds while the sidecar write fails leaves a later older write reading a
   stale marker. A version marker **inside the file** is worse still: these mirrors
   are **user-editable by design** — their own header says edits are imported or
   approved — so a user appending a section below the marker leaves it mid-file,
   where it reads back as profile content and can be imported into the durable
   artifact. Reading the file to recover a marker also required no-follow/bounded
   reads and a platform gate that broke mirroring on unsupported platforms. Each
   attempt was defending a mechanism the actual bug never needed.)*

4. **Scope, and the accepted residual.** The mirror is a *local convenience
   projection*; the durable artifact store is the single source of truth. The race
   this closes — two concurrent updates inside one process — is the one the audit
   reported and the only one a projection needs to handle. **Residual:** a caller
   that commits a version and then delays past a whole competing update (long
   enough for the chain to drain) can still write its older content, leaving one
   stale mirror file until the next write re-projects it. That is accepted: the
   durable store is unaffected, it self-heals, and every mechanism that closed it
   cost more than it was worth. Cross-process coordination (lease, fencing token)
   is explicitly out of scope. Mirror failures stay non-fatal via the caller's
   existing `reportSideEffectError` path and must never fail the durable write.

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
