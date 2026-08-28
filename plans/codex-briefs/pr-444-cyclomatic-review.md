READ-ONLY review (do NOT modify files, no DB or service actions). Repo: this checkout, branch feat/JOBPERM-1-chat-parity-job-permissions (PR #444). Scope: ONLY the source-code changes, i.e. `git diff $(git merge-base origin/main HEAD)...HEAD -- apps/core/src` (exclude tests, docs, plans, .factory, harness). Run `git fetch origin main` first if needed.

Lens: CYCLOMATIC COMPLEXITY. For every function/method that this diff adds or modifies, estimate its cyclomatic complexity after the change (count decision points: if/else-if, ternaries, &&/||/??, loops, case labels, catch, optional-chaining guards that branch), and where a function is modified, the delta versus before the diff. Use a tool if available (e.g. `npx eslint --no-eslintrc --rule '{"complexity":["error",1]}'` on the touched files, or `npx ts-complex`/`escomplex` if installed) — otherwise count by hand from the diff and say so.

Report, SHORT:
1. A table of the top 15 functions by post-change complexity: file:line, function, CC after, CC delta (+/-), and one line on the branching that drives it.
2. Any function this diff pushes above 10, and any above 15 — flag these explicitly.
3. Net effect of the PR on complexity: functions simplified (deleted branches) vs. functions grown, with the biggest single reduction and biggest single increase.
4. Up to 5 concrete simplification opportunities in the changed code, each a one-line description with file:line and the expected CC after — prefer deletions/flattening over new abstractions (owner rule: simplest form, no new layers).
Do not review style, naming, or unrelated code. Keep total output under ~120 lines. Never print more than 60 lines of a file at once.
