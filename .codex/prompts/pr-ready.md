# PR-Ready Prompt

Prepare the final PR package.

Include:
- approved plan summary
- implemented scope
- deterministic verification results
- quality / performance / security scores
- known risks and follow-ups
- exact manual validation evidence

Do not mark PR-ready if any required artifact is missing.

If the user asks for new implementation work that is outside the active PR-ready issue:
- do not block on the current PR-ready loop
- start a new factory run with intake for the new issue
- continue in `planning` -> `decomposing` -> `implementing` for that new run
