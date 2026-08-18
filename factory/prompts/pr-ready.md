# PR-Ready Prompt

Prepare the final PR package.

Before the branch-wide closeout autoreview, run `./forge review-brief --all`
and pass its printed repo-relative path to autoreview with `--prompt-file`.
This review covers every task's plan contracts so a later stage cannot silently
undo an earlier stage's implementation.

Include:
- approved plan summary
- implemented scope
- deterministic verification results
- quality / performance / security scores
- known risks and follow-ups
- exact manual validation evidence

Do not mark PR-ready if any required artifact is missing.
