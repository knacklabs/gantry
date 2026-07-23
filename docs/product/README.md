# Product Docs

This directory is the canonical location for product intent.

Use it for:
- the product brief
- user types
- key flows
- vocabulary and domain concepts
- high-level business constraints
- explicit non-goals

Start with:
- `docs/product/BRIEF.md`

Rules:
- keep product intent separate from architecture mechanics
- architecture belongs in `docs/architecture/`
- binding product choices and tradeoffs belong in `docs/decisions/`
- if a brief becomes stale, update it before planning the next major change

During planning:
- `docs/product/BRIEF.md` defines what to build
- `docs/architecture/` defines how the system should behave
- `docs/decisions/` resolves ambiguity and records overrides
