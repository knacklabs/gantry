Read-only audit complete. Seven verified findings; no files changed. User-visible effects below are limited to what the code establishes. Existing database contents were not inspected.

1. **Unused embedding copies — parallel**

   **Today:** Every memory-item and brain-page embedding write stores the same vector twice. Search consumes the vector column; neither table’s JSON copy has a production reader.

   **Locations:** Definitions: [schema.ts:421](../../../../apps/core/src/adapters/storage/postgres/schema/schema.ts#L421), [brain.ts:143](../../../../apps/core/src/adapters/storage/postgres/schema/brain.ts#L143). Memory writes: [app-memory-embedding-writes.ts:80](../../../../apps/core/src/memory/app-memory-embedding-writes.ts#L80), [:94](../../../../apps/core/src/memory/app-memory-embedding-writes.ts#L94), [:143](../../../../apps/core/src/memory/app-memory-embedding-writes.ts#L143). Brain writes: [brain-repository.postgres.ts:477](../../../../apps/core/src/adapters/storage/postgres/repositories/brain-repository.postgres.ts#L477), [:493](../../../../apps/core/src/adapters/storage/postgres/repositories/brain-repository.postgres.ts#L493), [:527](../../../../apps/core/src/adapters/storage/postgres/repositories/brain-repository.postgres.ts#L527).

   **Keep/delete:** Keep indexed vector columns, used by [memory recall:109](../../../../apps/core/src/memory/app-memory-recall-hybrid.ts#L109) and [brain search:343](../../../../apps/core/src/adapters/storage/postgres/repositories/brain-repository.postgres.ts#L343). Drop these two JSON columns and their writes. Keep `embedding_cache`: its JSON and vector representations both have readers.

   **Size:** Medium, including migration and fixture changes. **Risk:** Schema cutover; no product reader of the removed values was found.

2. **Sandbox persistence API has no production callers — dead**

   **Today:** Storage constructs a six-method sandbox repository that production never calls. Only an integration test saves a profile and round-trips a lease; workspace-snapshot methods have no callers.

   **Locations:** [Implementation:1906](../../../../apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts#L1906), [construction:2050](../../../../apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts#L2050), [port:648](../../../../apps/core/src/domain/ports/repositories.ts#L648), [lease table:41](../../../../apps/core/src/adapters/storage/postgres/schema/sandbox.ts#L41), [lease type:25](../../../../apps/core/src/domain/sandbox/sandbox.ts#L25), [test callers:191](../../../../apps/core/test/integration/application-services.postgres.integration.test.ts#L191).

   **Keep/delete:** Delete the unused repository, port, construction and lease persistence. Keep actual runner enforcement: chat and async commands construct their profiles at [agent-spawn-helpers.ts:416](../../../../apps/core/src/runtime/agent-spawn-helpers.ts#L416) and [async-command-sandbox-runner.ts:131](../../../../apps/core/src/jobs/async-command-sandbox-runner.ts#L131). Profile and snapshot tables still have references, so their removal needs separate tracing.

   **Size:** Medium. **Risk:** Dropping lease history is irreversible; stored rows are unknown.

3. **Message-list hydration copied twice — duplicate**

   **Today:** Developers must change cursor lookup, attachment loading, part loading and grouping twice when changing conversation history.

   **Locations:** Cursor/query copies: [domain-repositories.postgres.ts:1425](../../../../apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts#L1425), [:1503](../../../../apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts#L1503). Hydration copies: [:1460](../../../../apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts#L1460), [:1539](../../../../apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts#L1539).

   **Keep/delete:** Keep both operations: one selects the earliest page, the other the latest page and reverses it. Merge shared cursor resolution and hydration into private methods in the same class.

   **Size:** Small. **Risk:** Preserve selection order, chronological return order and timestamp/ID tie-breaking.

4. **Retired webhook list-and-mark path remains — dead**

   **Today:** The repository offers an unused way to list due deliveries and mark them delivering separately, alongside the transactional claim used in production.

   **Locations:** Old [list:547](../../../../apps/core/src/adapters/storage/postgres/repositories/control-plane-repository.postgres.ts#L547) and [mark:593](../../../../apps/core/src/adapters/storage/postgres/repositories/control-plane-repository.postgres.ts#L593); surviving equivalent [claim:25](../../../../apps/core/src/adapters/storage/postgres/repositories/control-plane-webhook-claim.postgres.ts#L25). Production calls the claim at [webhook-delivery.ts:236](../../../../apps/core/src/control/server/webhook-delivery.ts#L236).

   **Keep/delete:** Keep the atomic claim with row locking and attempt increment. Delete both old methods and their test-only references. No production duplication of delivery was established.

   **Size:** Medium because obsolete mocks span more than five files. **Risk:** Low; retain production claim coverage.

5. **Single and batch MCP bindings repeat the same write — duplicate**

   **Today:** Attaching one MCP server and bulk attaching servers maintain identical insert/update field lists separately.

   **Locations:** [Single write:316](../../../../apps/core/src/adapters/storage/postgres/repositories/mcp-server-repository.postgres.ts#L316), [batch write:22](../../../../apps/core/src/adapters/storage/postgres/repositories/mcp-server-agent-bindings.postgres.ts#L22). The repository already delegates its batch method at [:350](../../../../apps/core/src/adapters/storage/postgres/repositories/mcp-server-repository.postgres.ts#L350).

   **Keep/delete:** Keep the existing transactional batch helper, including sorted authority locks. Replace the single-write body with a one-element batch call.

   **Size:** Small. **Risk:** Low; preserve locking and update fields.

6. **Wrapped Postgres errors inspected eight ways — duplicate**

   **Today:** Conflict handling has copied cause-chain traversal, with recursive versus bounded walks and differing stopping rules.

   **Locations:** [domain repositories:234](../../../../apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts#L234), [sessions:44](../../../../apps/core/src/adapters/storage/postgres/repositories/session-repositories.postgres.ts#L44), [outbound helpers:40](../../../../apps/core/src/adapters/storage/postgres/repositories/outbound-delivery-repository.postgres.helpers.ts#L40), [worker leases:24](../../../../apps/core/src/adapters/storage/postgres/repositories/worker-coordination-lease.postgres.ts#L24), [file artifacts:361](../../../../apps/core/src/adapters/storage/postgres/repositories/file-artifact-repository.postgres.ts#L361), [job inserts:78](../../../../apps/core/src/adapters/storage/postgres/repositories/canonical-job-run-insert.postgres.ts#L78), [dream reviews:238](../../../../apps/core/src/adapters/storage/postgres/repositories/brain-dream-review-repository.postgres.ts#L238), [memory writes:50](../../../../apps/core/src/memory/app-memory-service-helpers.ts#L50).

   **Keep/delete:** Merge traversal into one bounded extractor returning code and constraint. Keep each caller’s conflict-specific decision; delete local walkers.

   **Size:** Medium. **Risk:** Preserve constraint-specific retries and refusals; a blanket “unique violation means success” would be wrong.

7. **Uncalled memory-subject mapper — dead**

   **Today:** A 31-line mapper remains inside the 2,084-line repository file without any caller.

   **Location:** [domain-repositories.postgres.ts:308](../../../../apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts#L308).

   **Keep/delete:** Delete `_memorySubjectFromRow` and its now-unused import. No replacement is needed.

   **Size:** Small. **Risk:** None identified.

Planned work noticed:

- covered by PERMFLOW-4: setup-prompt and job-permission-card persistence remains wired at [domain-repositories.postgres.ts:2016](../../../../apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts#L2016) and [job-permission-need-repository.postgres.ts:402](../../../../apps/core/src/adapters/storage/postgres/repositories/job-permission-need-repository.postgres.ts#L402).

**Ranked value:** 1 first for eliminating unused per-embedding storage and writes; then 2, 6, 4, 3, 7, 5 by approximate removable code. Outside planned work, no direct user-facing UX defect was verified.
