# Auto-mode gap: package-pinned shim families — FAST pass (read-only, emit quickly, do NOT explore beyond listed files)

Read ONLY these, then emit — do not grep the wider tree:
1. `apps/core/src/shared/family-rule-synthesis.ts` (whole file — runnerShimBashLeafReason, synthesizeFamilyRunCommandRuleContentForLeaf, isLiteralFamilyExecutable, runnerShimFamilyBypassReason)
2. `apps/core/src/shared/bash-command-parser.ts` lines 1-120 (the UNSAFE/STATEFUL/WILDCARD_SENSITIVE sets + leaf/argv shape)

PROPOSAL to validate: runner shims (npx/uvx/pnpx, npm exec, pnpm dlx, yarn dlx, bun x) currently get NO durable grant so they re-ask forever. Instead grant at PACKAGE granularity — e.g. `npx remotion *` (pinned to the one package, open on args), same safety class as `git *` (bounded to one program).

Answer with file:line + concrete minimal change:
1. Is `npx <pkg> *` SAFE to persist, given rails still inspect the exact command at match time? Confirm a pinned-package family cannot widen to arbitrary packages.
2. Smallest implementation seam for grant identity `<shim> <pkg>`: parser (extract the package token after the shim, skipping flags like -y/-p/--package), synthesis (mint `npx <pkg> *`), and the shim exclusion/bypass guards that must be relaxed for the pinned shape only.
3. Edge cases that MUST stay rejected (no durable grant): bare `npx *`, `npx -y <pkg>` where the pkg can't be resolved, `npx --package=x <pkg>`, `npx github:owner/repo`, `npx ./local`, `npx http://…`, scoped `@scope/pkg` (allow if literal). List each with reject/allow.

OUTPUT: numbered answers — claim, file:line, concrete minimal change; a go/no-go on safety; the edge-case reject/allow list. Under ~400 words. No edits. Emit as soon as the files are read.
