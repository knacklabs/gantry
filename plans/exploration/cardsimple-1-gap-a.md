# Family neutrality gap hunt — pass A: command classes + tool names (read-only, no edits, TIGHT)

Audit the CARDSIMPLE-1 family-grant code on the current checkout (feat/CARDSIMPLE-1-family-wide-grants). A prior partial pass already confirmed: all three minting lanes call the shared synthesizer, and the host IPC processor synthesizes when a runner (including DeepAgents RunCommand) sends no suggestions. Do NOT re-derive that; verify only these two questions:

1. **Command classes.** For each class, does it family, and if excluded is that per-contract or an accidental gap a user feels as "my Allow didn't stick": plain binaries (curl/gh/npm/git/jq); absolute paths; subcommand grammars (git push, npm run build); interpreter-with-flags-no-script (node -e, python3 -c); runner shims (npx, pnpm dlx, uvx); sudo-prefixed; env-assignment-prefixed (FOO=1 cmd); quoted/space or Unicode paths. Evidence: `shared/family-rule-synthesis.ts`, `shared/bash-command-parser.ts` guards, `shared/durable-access-policy.ts`.
2. **Tool names.** Bash and RunCommand both hit the family path in classifier eligibility, coordinator and SDK gate? Any other shell-executing tool identifier that mints or matches command rules but misses the synthesizer or the isFamilyRule marking?

Output: numbered findings (claim, file:line, class intentional-exclusion|gap, severity, smallest fix or deferral trigger). One-line verdict. No edits.
