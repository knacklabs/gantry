---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-26
---

# App-isolate and content-address skill artifact storage

## Context

Skill artifact storage builds its storage reference from the sanitized skill
name only — `skills/<name>` — in both the local and S3 stores
(`local-skill-artifact-store.ts:24`, `s3-skill-artifact-store.ts:63`), while
catalog uniqueness is per `(app_id, name)`
(`apps/core/src/adapters/storage/postgres/schema/skills.ts`). Two apps that
install a skill with the same name therefore resolve to one physical location:
the second install overwrites the first, and the first app then executes the
second app's bytes under its own identity, permissions, and recorded hash. This
is exploitable **without concurrency**. Concurrency adds a second failure: both
stores replace in place (local `rmSync` then sequential writes; S3
delete-prefix then sequential upload), so a reader can observe a partial or
mixed bundle mid-install.

A third hole compounds it: the direct selected-skill projection
(`selected-skill-projection.ts:116,140`) reads whatever bytes currently exist
at the stored ref but returns the catalog's *previously stored* `content_hash`
without recomputing it — so substituted or partial bytes pass the integrity
check. Only the S3 fleet `materializeSkillArtifact` path recomputes and verifies
(`s3-skill-artifact-store.ts:135`); the direct execution paths (Claude
materializer + both DeepAgents lanes + control API GET) bypass it.

Key enabling fact from exploration: `storage_ref` is an **opaque stored column**
— the catalog, service, and repository pass it through unchanged; reads follow
whatever string is saved. So the storage layout can change with **no** schema,
service, or repository change, and old-shape rows keep resolving with no
compatibility code.

## Decision

1. **App-scoped, content-addressed layout for new writes.** Both stores write to
   `apps/<appId>/skills/<catalogId>/<contentHash>/` — an immutable directory keyed
   by the content hash. Write the full bundle to that directory, then persist the
   catalog `storage_ref` pointer. Because each write lands at a distinct
   hash-named path, there is no in-place replacement and therefore no
   partial/mixed-read window; readers of a given ref always see a complete bundle.

2. **Read-time integrity, fail closed.** The direct selected-skill projection
   recomputes `hashSkillBundle(bundle)` over the bytes it read and compares to the
   catalog `content_hash`; on mismatch it fails closed (refuses to project /
   quarantines) rather than returning the stored hash — matching the S3
   materializer's existing behavior.

3. **App-scope the install lock key.** The three install writers key
   `withSkillMaterializationLock` by lowercased name only; change them to
   `<appId>:<name>` via one shared helper, so the lock scope matches the new
   physical namespace and cross-app installs no longer serialize against each
   other. (Not required for correctness of reads; cheap alignment.)

4. **No legacy/compat code, no migration script.** Per active-development policy
   (no backward-compatibility burden), the codebase carries no dual-read or
   deprecation path. Existing old-shape rows keep working purely because
   `storage_ref` is opaque — not because of any compat handling. Migrating
   already-installed skills to the new layout is an **operational** step done by
   hand against a given runtime, not shipped code. On the local gantry runtime all
   21 installed skills are under a single app (`default`), so no cross-app
   collision exists there and the running instance keeps working unchanged after
   deploy; hand-migration there is optional/cosmetic.

## Consequences

- **Touched:** `local-skill-artifact-store.ts`, `s3-skill-artifact-store.ts`,
  `remote-first-skill-artifact-store.ts` (its cache-name derivation must track the
  full ref), `selected-skill-projection.ts` (read-time verify), the three lock
  call sites + a shared key helper, and their focused adapter/projection tests.
  Schema, `skill-service.ts`, and the repository are **unchanged** (opaque ref).
- **Fails closed** on hash mismatch is a deliberate behavior change: a genuinely
  corrupted/stale bundle now refuses to project instead of silently running. That
  is the point — a skill is an executable instruction bundle.
- **`catalogId` in the path**, not `skillId`: `skill_catalog`'s identifier column
  is `id`; there is no `skill_id` column on that table (`skill_id` lives on
  `agent_skill_bindings`).
- No data migration ships; any runtime with pre-existing multi-app same-named
  skills must be hand-migrated or those skills reinstalled. Accepted under the
  no-legacy policy.
- Closes the RACE-1 Critical. Sibling concurrency items RACE-2..9 tracked
  separately.
