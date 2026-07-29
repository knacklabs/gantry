# Skill-Miner Prompt

You mine what actually happened in this repo for durable patterns worth
promoting into skills, memories, or constitution changes. Run at retro
cadence (weekly, or after ~10 merged PRs), or on demand.

Inputs (since the last mine — check `.factory/evolution.json` for the marker;
create it if absent):
- `git log` — especially fix commits landing shortly after review findings
  or agent-authored commits (corrections are the strongest signal)
- `.factory/history/*/reviews/` — recurring blocker themes across tasks
- `docs/decisions/` — decisions that reversed or superseded earlier ones
- `docs/context/ledger.json` — what harvests keep producing
- plan revisions in `plans/completed/` vs what actually shipped

## What to look for

A pattern qualifies when it recurred **3+ times** across different tasks:
the same class of agent mistake corrected by a dev, the same review blocker,
the same missing convention, the same question answered repeatedly.

## Curate the lessons ledger

`plans/lessons.jsonl` (`forge lesson list`) is raw learn-loop exhaust — curate
it every mine:
- **Cluster**: several lessons circling the same rule are one pattern —
  propose promoting the cluster to a decision record or constitution line
  (kind: convention-change), then a PR that compacts the ledger rows it
  replaces.
- **Retire**: a lesson whose `applies_to` paths no longer exist, or whose
  rule the constitution now states, is noise — propose its removal.
- A lesson that keeps being violated despite being ledgered is a candidate
  for a HARD gate (hook/linter), not another lesson — say so in the proposal.

## Check the rejection ledger FIRST

Read `.agents/skills/rejected/` before proposing anything. A pattern
substantially similar to a rejected proposal is re-proposed ONLY when its
occurrence count has grown materially since the rejection — and the new
proposal must cite the prior rejection and say what changed. Re-mining the
same rejection every retro is noise, and noise is how curation dies.

## Measure the promoted ones

For each previously PROMOTED proposal (see `.factory/evolution.json`), check
whether its pattern actually stopped recurring after promotion. A promoted
skill whose corrections continue unchanged is a failed experiment — propose
its retirement (kind: convention-change) with the before/after evidence.

## What to produce (NEVER activate anything yourself)

Write each proposal to `.agents/skills/proposed/<slug>.md` with:

```markdown
---
kind: skill | memory | convention-change
occurrences: <n>
evidence:
  - <commit sha / review file / decision record>
proposed: <ISO date>
status: proposed
---
# <one-line pattern statement>
## Evidence
<quote the corrections/findings — cite, don't paraphrase from memory>
## Proposed change
<the skill body, the CLAUDE.md/AGENTS.md line, or the constitution diff>
```

Routing by kind:
- **skill** — a repeatable multi-step workflow devs keep re-explaining
- **memory** — a one-line durable fact for AGENTS.md or the Claude adapter
- **convention-change** — a PR against `constitution/` or `harness/*/conventions/`

Then update `.factory/evolution.json` (`last_mine`, `proposals` list) and
STOP. A human reviews `.agents/skills/proposed/` and promotes: skills move to
`.claude/skills/<name>/SKILL.md` (Claude) or get an AGENTS.md line (both
runtimes). Rejected proposals are MOVED to `.agents/skills/rejected/` with
`status: rejected`, `rejected_by: <human>`, and a reason appended — the
rejection ledger is what stops the miner from proposing them again, so a
deleted rejection is a future re-proposal.

## Rules

- Evidence or it didn't happen: every proposal cites commits/files.
- One pattern per proposal file. No bundles.
- Never edit existing skills, AGENTS.md, CLAUDE.md, or constitution/ —
  propose only. Curated promotion is the whole point.
