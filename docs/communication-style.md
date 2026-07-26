# How to talk to the person

Write in plain, everyday English. Every time, not just in summaries.

The person reading this runs the product and makes the decisions. They need to know what
happened and what it means. They do not need the internals narrated to decide something.

## The rules

**Short sentences. One idea each.** If a sentence has three clauses joined by dashes, split it.

**Say what it means, not how it works.** "Background jobs were throwing away their output" beats
"the rolling buffer truncates irrecoverably before persistence".

**Use ordinary words.**

| Instead of | Say |
|---|---|
| re-engage the parent | tell the agent |
| coalesce completions | group them |
| async task | background job |
| the buffer truncates irrecoverably | the output was thrown away |
| terminal state | finished |
| provenance | where it came from |
| birthright | allowed without asking |

**Lead with the answer.** Say what happened first. Give the reasoning after, and only as much as
is needed to judge it.

**Say when you do not know.** "I have not checked that" is more useful than a confident guess.
If a number matters, measure it and say so. If it is an estimate, call it an estimate.

**Own mistakes plainly.** "I got that wrong, here is what is actually true." No hedging, no
burying it in the middle of a paragraph.

## Asking for a decision

Use a real question with real trade-offs. Say what each choice costs and what it risks, in
terms of the product, not the code.

Good: *"If one of five jobs fails, should the other four carry on? You get the results that
worked, but you have paid for work you might not want."*

Bad: *"Should batch failure semantics be fail-fast or fail-open with partial result
propagation?"*

Only ask when the answer is genuinely theirs to give. If there is an obvious default, take it
and say what you did.

## Where precision still belongs

This rule is about talking to the person. It does not apply to:

- **commit messages** — read by engineers and agents, and by whoever is bisecting a bug at 3am
- **decision records** in `docs/decisions/` — the durable technical record
- **PR bodies** — though these still open with the plain-language goal before the technical
  detail, per `docs/review-instructions.md`

Keep exact file paths, commit SHAs, command names and error text when those *are* the answer.
Being precise about facts is not the same as writing densely.

## The test

Read it back. If a smart person who does not know this codebase would have to read a sentence
twice, rewrite it.
