# Shared dev memory

Durable, cross-session knowledge about this repo — decisions, gotchas, in-flight
work, and standing feedback — that isn't obvious from the code or git history.
Kept in the repo (not any one dev's machine) so the whole team and any coding
agent shares it.

- `MEMORY.md` is the index: one line per note. Read it first.
- Each `*.md` is one fact with frontmatter (`name`, `description`, `type`).
  Types: `user`, `feedback`, `project`, `reference`.
- Notes link to each other with `[[note-name]]`.

When you learn something durable, add a note here and a one-line pointer in
`MEMORY.md`. Update or delete stale notes rather than duplicating them.
