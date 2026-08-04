# Decision Docs

The canonical record of explicit product and engineering decisions: approved
product calls, architecture decisions and overrides, tradeoffs, non-goals,
forced constraints, and anything that resolves ambiguity in
`docs/architecture/`. During planning and decomposition these files override
vague or conflicting architecture guidance.

## Shape

Records are created by the CLI, never by hand:

```bash
./forge decision new <slug> [--title "..."] [--supersedes <slug>]
./forge decision link <slug> --story <KEY>     # it governs another story too
./forge decision accept <slug> --by "<human>"  # after confirmation in chat
./forge decision list [--active]
```

`decision new` writes `NNNN-<slug>.md` with the next free number and this
frontmatter:

```yaml
status: proposed          # proposed | accepted | superseded
confirmed_by: ""          # a human's name, filled by `decision accept`
date: 2026-07-27
stories: [ENG-1]          # the stories this decision governs ([] = project-level)
supersedes: 0004-old      # only when replacing a record
superseded_by: 0016-new   # written on the predecessor when the successor is accepted
```

Body: `# Title`, then `## Context`, `## Decision`, `## Consequences`.

`stories` is seeded from the active task and appended by `decision link` — it
is how the board answers "which decisions came out of this feature", so a
record with an empty list reads as project-level, not as an omission.

## Enforced rules

`check_dual_runtime.py` fails the repo, and the gates refuse, on:

- a status outside `proposed | accepted | superseded`
- a record with no `stories:` field
- `accepted` with an empty `confirmed_by` — **agents never self-confirm; a
  human confirms in chat, and the acceptance commit carries a
  `Confirmed-by:` trailer**
- `accepted` whose Context / Decision / Consequences is still boilerplate
- a `supersedes` / `superseded_by` pointer that resolves to nothing
- `superseded` with no `superseded_by`
- an accepted record whose predecessor is not yet superseded — acceptance
  flips both in one step, so the two never govern the same question at once

`plan save` additionally refuses unless the plan's `decisions_reviewed`
frontmatter lists exactly the accepted corpus (`./forge decision list
--active`), and refuses while an open contradiction signal stands.

## Conventions

- one decision per file; decisions are never deleted or edited into
  irrelevance — supersede them
- a proposed record is history and context, not governance: only `accepted`
  records bind planning
- never bury a decision in a chat transcript or a plan note; if a plan
  depends on one, record it here first
- when a decision supersedes an architecture doc, link both and state which
  one wins
