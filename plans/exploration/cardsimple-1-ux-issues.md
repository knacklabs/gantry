# User-facing UX issue hunt for the permission changes (read-only, no edits, TIGHT)

Audit the CURRENT checkout (branch fix/settings-import-tolerates-stored-rules = main + #465 family grants + #467 settings tolerance). Tonight's shipped behavior changes:
1. Allow-for-future on a simple command now records a command-FAMILY rule (`RunCommand(<argv0> *)`) synthesized by the host in all three lanes; SDK-supplied suggestions are discarded.
2. Excluded from families (allow-once only): pipes, runner shims (npx/pnpx/uvx; npm exec|x, pnpm dlx|exec, yarn dlx|exec, bun x), interpreters, meta-executors, relative/non-literal-absolute paths, destructive redirects. Family matches are provisional to rails + shim guard (rail hit ⇒ ask with allow_once|cancel and suggestions cleared).
3. Ask cards show "Allow for future covers: <argv0> *" via familyScopeCoverageLines (rendered inside the context-lines block on all three composers).
4. Pinned local_cli job readiness accepts covering family rules (toolRuleCoversRule).
5. Promotion history keys on the full sorted rule set; classifier prompt says "requests in this permission scope".
6. Settings loading tolerates stored RunCommand grants a tightened validator rejects (warnings at three seams: validateSettingsForImport, validateLoadedRuntimeSettings, reconcile throws in startup/restart-sync). Live example: user's stored `RunCommand(npx remotion *)` grants now load but npx invocations always re-ask.

Question: as an ordinary CHAT or SCHEDULED-JOB user, what issues or confusions can these changes cause? Hunt concretely, with file:line evidence, for things like (not limited to):
- Users who previously relied on now-excluded grants (npx-based tools like remotion/playwright, piped one-liners, scripts) — what exactly do they experience now, and is the messaging clear about WHY there is no Allow-for-future button and what to do instead?
- The "Allow for future covers" line: correct and comprehensible on every surface? Any surface (job permission card need rows, receipts, batch cards, denial messages) that still implies exact-command scope or shows nothing?
- A rail-hit inside a trusted family: does the user get a comprehensible explanation, or a confusing ask for a tool they thought was trusted?
- Old exact-argv rules users already saved: do they still work, get shadowed, or produce double asks alongside new family rules? Any migration confusion?
- The tolerated-but-invalid stored grants (warn-and-skip): do users get ANY signal that a saved grant is no longer honored durably (npx case), or does it silently re-ask forever with no explanation or remediation path?
- Compound commands: per-leaf family synthesis — can a user tell which leaves were saved vs not?

Output: numbered findings — user-visible symptom (one plain sentence), root cause file:line, severity (confusing|annoying|broken-workflow), smallest UX fix. One-line verdict. No edits.
