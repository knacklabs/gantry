# Permission durable-storage simplification assumptions

## Stage 2 — One recovery orchestrator

None.

## Stage 3 — Merged schema cutover

| Assumption | Missing information | Choice | Impact if wrong | Validated |
| --- | --- | --- | --- | --- |
| A member rebound from a settled Review-each batch must retain relational lineage to that terminal batch prompt. | The goal requires envelope-only claims and member `envelope_id`, but does not name the lineage column needed when the member moves to its individual prompt. | Add nullable `permission_prompts.parent_envelope_id` and set it only when an individual prompt replaces a settled batch prompt. | Without lineage, the batch owner can be lost; if a separate history table is required instead, the schema and recovery queries must change. | |
| Review-each expiration must not become durable until the provider prompt is terminalized. | Provider terminalization and Postgres settlement cannot share one transaction. | Keep the persisted Review-each claim unchanged when terminalization fails; after terminalization succeeds, atomically expire the envelope and resolve its members. | A provider outage could otherwise make retry feedback lie while the database permanently reports `already_decided`. | Stage 3 invariant test covers failure then retry. |
| A transient failure after authority application must retry only durable resolution. | The existing IPC file represents the whole request, not a post-authority phase. | Perform one typed `retryable_error` resolution retry in the same processing phase; never restore the original request after authority starts. | Replaying the request could duplicate grants, settings writes, recovery work, and user-visible persistence messages. | Runtime test proves two resolution attempts and one transient-grant write. |
