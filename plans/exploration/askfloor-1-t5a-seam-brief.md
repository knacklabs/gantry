# ASKFLOOR-1-T5a seam map — exploration brief (read-only)

Purpose: give the T5a task plan (Card UX + provider surfaces; user_facing: true) an exact, line-cited map of every seam it must touch, and list the OWNER-LEVEL choices (product-visible wording/behaviour that the plan does not already fix) so they can be asked ONCE, up front. Read-only exploration: no file changes, no test runs.

Read first: the T5a ownership bullet in `plans/active/ASKFLOOR-1-the-judge-actually-judges-context-aware-first-asks-in-auto-mode.md` (line ~194) and the plan's card copy sections (labels, order, pre/post-tap lines, reason lines, batch line, the destructive/protected rulings of 2026-09-04, trust growth after three exact Allows); `docs/specs/askfloor-1-judge-actually-judges.md`; decisions 0154, 0155, 0122, 0124, 0138, 0156; the T5a stub in `.factory/stories/ASKFLOOR-1/decomposition.json` (objective + five ACs); what T3c shipped (`application/permissions/permission-remember-codec.ts` — the four closed codes in the scalar-mode slot; `human-decision-learning.ts` — `PermissionRememberContext` on the member payload with eligibility, candidate keys, kindVariant; provider codecs in `telegram/channel-shared.ts` and `slack/permission-action-id.ts` already accept the codes; place resolves `no_root` until T5a; kindVariant 'category' until T5a sets 'tool').

Map, with file:line for each:

1. `channels/permission-interaction.ts` — today's labels/order/lines (incl. `Cancel` at :86), how a card's buttons are built from the request + decision context, where the host-derived `rememberContext` (eligibility, candidate keys, destructive/protected flags) can be read to decide which remember button to render, and where pre/post-tap lines are emitted.
2. `channels/permission-batch-coalescer.ts` — the batch copy line in both renderers.
3. Each provider: `telegram/callback-handlers.ts` + renderer, `slack/channel-interactions.ts` + `permission-approval-delivery.ts`, `discord/components.ts` + `permission-callback.ts`, `teams/cards.ts` + `permission-submit.ts` + `interaction-handlers.ts` — where buttons are rendered from the shared affordance model, where a tapped code is decoded, and what each still lacks to render/settle the remember alternative and the `memory_forget` affordance.
4. `domain/message-actions.ts` — the union and what a `memory_forget` entry needs (payload shape: record id, person, label); which settlement path a Forget tap takes today (none) and the narrowest host seam to call the T3a revoke method on `HumanDecisionMemoryService` (name it).
5. The Teams card-level primary-action cap (`teams/cards.ts:629`) and how per-row ActionSets or chunked cards fit the existing renderer.
6. The destructive/protected classification source (the typed risk table from T2b — file:line) and the "trust growth after three exact Allows" counter: does T3a/T3b expose a count of active exact Allows per tool id (`listHumanDecisions`?) or must T5a add a read.
7. Ineligible-lane cards (ask, auto_strict, job prompts, groups): the exact render paths that must stay byte-for-byte, and the existing four-provider snapshot suites (`provider-affordance-parity.test.ts` etc.) to extend.
8. The S4 tap-budget fixture (`askfloor-tap-budget-harness.ts`, S1–S3 shapes) and what S4 needs (rm -rf build / dist, remembered No).
9. Architecture-map ceilings for every file in play.
10. Existing suite ownership per seam.

Then OWNER QUESTIONS: list every product-visible choice the plan text leaves open (exact button labels/order if any wording is unspecified, the post-tap line wording, what a Forget confirmation looks like, whether a remembered No shows a "remembered" reason line on later silent denials, Teams chunking vs per-row, anything else). Give each a recommended default so they can be asked as one bundled question.

Output: Markdown sections (1)–(10) with `path:line — symbol — what it does today — what T5a must change`, then OWNER QUESTIONS. Under ~240 lines.
