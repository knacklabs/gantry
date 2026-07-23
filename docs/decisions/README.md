# Decision Docs

This directory is the canonical location for explicit product and engineering decisions.

Use it for:
- approved product decisions
- architecture decisions and overrides
- tradeoff records
- non-goals
- forced constraints
- changes that resolve ambiguity in `docs/architecture/`

Recommended shape:
- `ADR-001-*.md` or `DEC-001-*.md`
- one decision per file
- include status, context, decision, consequences, and date

Rules:
- decisions must be explicit and durable
- do not bury decisions inside chat transcripts or plan notes
- if a plan depends on a decision, record it here first
- if a decision supersedes an architecture doc, link both and state the precedence clearly

During planning and decomposition, these files override vague or conflicting architecture guidance.
