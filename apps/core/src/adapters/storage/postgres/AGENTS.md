# Postgres Adapter Notes

- Provider session resume lookup must be scoped by the resolved canonical
  `agentId` plus route scope. Route-only keys can leak provider session or
  digest continuity after conversation or thread rebinding.
- Conversation route upserts that represent rebinding must update the active
  binding `agentId`; keeping the old owner active makes runtime session
  ownership checks meaningless.
- Legacy continuity rows that lack current `scope_key` and digest scope fields
  are inert unsupported data. Postgres repositories must not import, backfill,
  or repair them into current continuity.
