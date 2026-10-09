Seven findings verified in current code. No files changed.

I would keep the stores separate: [scoped memory filters](../../../../apps/core/src/memory/app-memory-boundaries.ts#L91) enforce agent and subject boundaries; [brain page reads](../../../../apps/core/src/adapters/storage/postgres/repositories/brain-repository.postgres.ts#L58) use the shared app boundary.

1. **Enabling Observer removes the brain review path — parallel**

   **Today:** Without Observer, destructive dreaming proposals create owner reviews. With Observer enabled, the same proposals are merely journaled, counted as “proposed,” and passed over as the brain cursor advances. The owner has no review to act on.

   **Locations:** Duplicate loops: [brain-dreaming.ts:102](../../../../apps/core/src/brain/brain-dreaming.ts#L102), [brain-dreaming.ts:192](../../../../apps/core/src/brain/brain-dreaming.ts#L192). Different executors: [283](../../../../apps/core/src/brain/brain-dreaming.ts#L283), [299](../../../../apps/core/src/brain/brain-dreaming.ts#L299). Different destructive handling: [brain-dream-destructive-op.ts:14](../../../../apps/core/src/brain/brain-dream-destructive-op.ts#L14), [26](../../../../apps/core/src/brain/brain-dream-destructive-op.ts#L26). Production selection: [system-jobs.ts:598](../../../../apps/core/src/jobs/system-jobs.ts#L598).

   **Keep:** One operation executor with validated review creation. Observer should add insight emission.
   **Merge/delete:** Merge the loops; delete the Observer-only journal-without-review handler.
   **Size:** Medium story. **Risk:** Preserve both cursors and insight deduplication.

2. **Brain rewrite reviews hide the actual change — UX**

   **Today:** Rewrite previews show only the first nonempty markdown line. Changing a paragraph beneath an unchanged heading produces identical “Before” and “After” text. The CLI omits even those details, displaying only the rewrite headline.

   **Locations:** Preview construction: [brain-review-card.ts:108](../../../../apps/core/src/domain/brain-review-card.ts#L108), [123](../../../../apps/core/src/domain/brain-review-card.ts#L123). Consumers: [Slack:16](../../../../apps/core/src/channels/slack/brain-review-affordances.ts#L16), [Telegram:282](../../../../apps/core/src/channels/telegram/message-action-affordances.ts#L282), [Teams:578](../../../../apps/core/src/channels/teams/cards.ts#L578), [CLI:127](../../../../apps/core/src/cli/brain.ts#L127).

   **Keep:** The frozen before/after snapshot, already captured at [intake:227](../../../../apps/core/src/brain/brain-dream-review-intake.ts#L227).
   **Merge/delete:** Replace first-line previews with a bounded preview of changed text; print the same details in the CLI.
   **Size:** Small. **Risk:** Keep long reviews bounded without hiding all substantive changes.

3. **The exposed `rem` dreaming phase does nothing — dead**

   **Today:** An administrator can request `rem`. It acquires a run, reads evidence, and can finish successfully with zero decisions. The former REM work has been removed; only light and deep branches remain.

   **Locations:** Accepted phase: [memory-types.ts:31](../../../../apps/core/src/memory/memory-types.ts#L31), [OpenAPI:89](../../../../apps/core/src/control/server/openapi-schemas-extensions.ts#L89), [SDK:57](../../../../packages/sdk/src/index.ts#L57), [generated SDK:3584](../../../../packages/sdk/src/generated/openapi.ts#L3584). HTTP entry: [memory.ts:473](../../../../apps/core/src/control/server/routes/memory.ts#L473). Remaining branches: [dreaming:142](../../../../apps/core/src/memory/app-memory-dreaming.ts#L142), [207](../../../../apps/core/src/memory/app-memory-dreaming.ts#L207); success: [trigger:430](../../../../apps/core/src/memory/app-memory-trigger-dreaming.ts#L430). Live schema copies: [278](../../../../apps/core/src/adapters/storage/postgres/schema/schema.ts#L278), [542](../../../../apps/core/src/adapters/storage/postgres/schema/schema.ts#L542), [550](../../../../apps/core/src/adapters/storage/postgres/schema/schema.ts#L550).

   **Keep:** Light, deep, and their combined operation.
   **Delete:** The no-op phase from accepted inputs, public contracts, and current lease machinery.
   **Size:** Medium story. **Risk:** Schema cleanup needs a migration; existing historical records need not be deleted.

4. **Hybrid recall implements rank fusion twice — duplicate**

   **Today:** Developers maintain two copies of candidate sizing, rank accumulation, merging, and sorting.

   **Locations:** Memory sizing/fusion: [app-memory-recall-hybrid.ts:9](../../../../apps/core/src/memory/app-memory-recall-hybrid.ts#L9), [166](../../../../apps/core/src/memory/app-memory-recall-hybrid.ts#L166). Brain sizing/fusion: [brain-recall.ts:4](../../../../apps/core/src/brain/brain-recall.ts#L4), [37](../../../../apps/core/src/brain/brain-recall.ts#L37).

   **Keep:** Separate retrieval queries and scope enforcement; one small pure rank-fusion function.
   **Merge:** Candidate sizing and reciprocal-rank accumulation.
   **Size:** Small. **Risk:** Preserve memory’s confidence adjustment and each store’s tie-breaking rules.

5. **Hydration duplicates ordinary read-only queries — duplicate**

   **Today:** `listForHydrationReadOnly` repeats `list` exactly. Hydration search repeats ordinary read-only search, adding only the option to disable embeddings.

   **Locations:** Listing copies: [service:268](../../../../apps/core/src/memory/app-memory-service.ts#L268), [321](../../../../apps/core/src/memory/app-memory-service.ts#L321). Search copies: [303](../../../../apps/core/src/memory/app-memory-service.ts#L303), [339](../../../../apps/core/src/memory/app-memory-service.ts#L339). Callers: [hydration:85](../../../../apps/core/src/memory/app-memory-session-hydration.ts#L85), [100](../../../../apps/core/src/memory/app-memory-session-hydration.ts#L100).

   **Keep:** `list` and `searchReadOnly`, with the existing embedding-control option.
   **Delete:** Hydration-specific query implementations; redirect their callers.
   **Size:** Small. **Risk:** Preserve statement deadlines, first-visible lexical-only behavior, and absence of recall-event writes.

6. **Brain proposals accept redundant field spellings — over-complicated**

   **Today:** The host accepts both camelCase and snake_case identifiers, requiring alias allowlists and conflict handling despite prompts specifying one spelling per operation.

   **Locations:** Destructive aliases: [op-schema:46](../../../../apps/core/src/brain/brain-dream-op-schema.ts#L46), [204](../../../../apps/core/src/brain/brain-dream-op-schema.ts#L204). Additive aliases: [dreaming:580](../../../../apps/core/src/brain/brain-dreaming.ts#L580), [594](../../../../apps/core/src/brain/brain-dreaming.ts#L594), [616](../../../../apps/core/src/brain/brain-dreaming.ts#L616). Prompt contract: [proposer:24](../../../../apps/core/src/brain/brain-dream-proposer.ts#L24).

   **Keep:** Documented wire fields and the explicit internal canonical representation.
   **Delete:** Alternate wire spellings and dual-alias resolution.
   **Size:** Small. **Risk:** Retain strict type, unknown-field, and target validation.

7. **Harvest and dreaming duplicate frontmatter serialization — duplicate**

   **Today:** Two serializers construct the same YAML wrapper; they have already drifted on trimming the body.

   **Locations:** [brain-channel-harvest.ts:202](../../../../apps/core/src/brain/brain-channel-harvest.ts#L202), [brain-dreaming.ts:670](../../../../apps/core/src/brain/brain-dreaming.ts#L670).

   **Keep:** One serializer beside the existing page-ingest codec.
   **Merge/delete:** Delete one copy and the `quoteYaml` wrapper that only calls `JSON.stringify`.
   **Size:** Small. **Risk:** Preserve body whitespace; callers can trim explicitly.

Excluded observations:

- **covered by MSG-4:** Harvest’s read-modify-write concurrency guard lives in process memory ([harvest:19](../../../../apps/core/src/brain/brain-channel-harvest.ts#L19)).
- **covered by UX-1:** Memory Edit asks people to type a review ID and replacement template ([review action:88](../../../../apps/core/src/app/bootstrap/runtime-memory-review-message-action.ts#L88)).
- **covered by PERMFLOW-3:** Jobs have separate completion-memory plumbing ([compact-memory.ts:60](../../../../apps/core/src/jobs/compact-memory.ts#L60)).

The referenced UX-1 and provider-native spec files are absent in this checkout; their exclusions follow your descriptions.

Ranked by value, user impact first, then deletion opportunity:

1. Observer review bypass.
2. Rewrite reviews hiding changes.
3. No-op REM phase.
4. Duplicate rank fusion.
5. Duplicate hydration queries.
6. Proposal field aliases.
7. Duplicate frontmatter serializers.
