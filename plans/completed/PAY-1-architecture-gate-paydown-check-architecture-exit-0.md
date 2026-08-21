---
issue: PAY-1
title: Architecture gate paydown — check:architecture exit 0
status: approved
saved: 2026-07-22T12:51:27+00:00
---

# PAY-1 — Architecture gate paydown: `check:architecture` exit 0

## Problem

`.envrc` pins the harness deterministic verify (`FACTORY_STRUCTURAL_CMD`) to
`npm run format:check && npm run check:architecture`. The checker fails on
baseline main across five sections, so **every** future story's `verify.py`
fails until this lands. Goal doc:
`docs/architecture/architecture-debt-paydown-goal-prompt.md`. Exploration:
Codex read-only pass 2026-07-22 (file:line evidence below).

## Scope / Non-goals

- Pure refactor + one checker enhancement: **zero runtime behavior change**,
  no public API/contract change.
- Non-goals: new provider-boundary debt entries (the mechanism ratchets exact
  counts; we repair instead); touching vendored harness files (WORKFLOW.md
  false positives die via checker placeholder-skipping); raising any
  line-budget limit.

## Acceptance Criteria (roadmap story PAY-1)

1. `npm run check:architecture` exits 0
2. `python3 .agents/scripts/verify.py` passes end to end
3. `npm run typecheck` and `npm test` green; no test deleted
4. No public API/contract change; contracts package diff empty
5. Any remaining architecture exception carries an expiry/ratchet note

## Technical Approach

### T1 — File splits (leaf extractions, no cycles)
- `genai-spans.ts` (1488→~580): extract `genai-message-attributes.ts`
  (lines 139–736: message normalization, request/response extraction, usage
  attributes, ~600) and `genai-tool-spans.ts` (737–1052: pending-tool map,
  delegation correlation, start/finish/fail, ~320). Both are leaves imported
  back by `genai-spans.ts`.
- `sse-accumulator.ts` (760→~661): move lines 52–151 (`SseFrameSplitter`,
  `createSseFrameSplitter`, `sseFrameData`, `isOpenAiUsageOnlyFrame`) to
  `sse-frame-splitter.ts`; update the one importer (`genai-spans.ts`).
- `gantry-model-gateway.ts` (730→~704): move `projectGatewayTokenEnv` +
  `projectedModelCredentialEnvKeys` (lines 703+) to
  `gantry-model-gateway-sdk-projection.ts` — matches existing
  `gantry-model-gateway-{http,observability,routing,rate-limit}.ts` idiom.
- `inline-lane/index.ts` (724→~703): move `structuredOutputError` +
  `abortedOutput` to `inline-lane-output.ts` (leaf on `RunnerOutputFrame`).
- `runner/query-loop.ts` (715→~687): move `toolResponseIsError` +
  `recordSuccessfulToolUse` (lines 89–116) to
  `query-tool-success-ledger.ts` — matches `tool-permission-*` /
  `query-usage-event-id.ts` naming.

### T2 — Layer-import fixes (checker ignores `import type` — real moves)
- `app/bootstrap/fleet-boot.ts:23` (type-only use): add a narrow
  `EffectiveControlRuntimeSettings` view beside `ControlPlaneStorageSettings`
  in `application/control-plane/control-plane-storage-model.ts` and type the
  `onSettingsReady` callback with it. Structural typing, no injection.
- `control/server/index.ts:31` (runtime): inject `getEffectiveMemoryState`
  through `startControlServer` input from `app/index.ts` — the port already
  exists on `ControlRouteContext` (`handler-context.ts:105–108`), mirroring
  the injected `getEffectiveRuntimeSettings` pattern.
- `control/server/routes/agents.ts:58–59` (runtime): new
  `ControlAgentSettingsPort` on `ControlRouteContext` (decode stored
  revisions → narrow agent/delegation view + revision-document serializer),
  implemented at the app composition root; move `writeAgentHarnessSetting`'s
  config load/write behind the same port so no config import remains.
- `control/server/routes/observer.ts:14` (runtime, NO exception entry): new
  `resolveObserverStatus(appId)` port on `ControlRouteContext`, composed in
  the app root from settings snapshots + effective memory state +
  conversation repository; the route consumes a neutral response shape.

### T3 — Provider-boundary tokens in tests (repair, not debt)
- `haiku-turn.agent-e2e.test.ts` (3 tokens: comment/env-read/skip-message):
  add a neutral fixture helper `requireRealModelCredential()` in the agent-e2e
  fixture kit reading `E2E_MODEL_API_KEY`; ci.yml maps the existing GitHub
  secret to that neutral name (`E2E_MODEL_API_KEY: ${{ secrets.E2E_ANTHROPIC_API_KEY }}`
  — workflows are outside the scanner's scope; no GitHub-secret rename
  needed). API-seeding path unchanged.
- `memory-lifecycle.postgres.integration.test.ts:70`: comment-only match —
  reword to "the real-model credential is unavailable". No code change.

### T4 — Provider literals in `prompt-profile-service.ts:332–357`
`channelContextLine` hard-codes telegram/slack labels, formatting guidance,
and message caps. The neutral seam is the channel provider registry
(`channels/provider-registry.ts:28–40` already owns `label`, `jidPrefix`,
`formatting`). Add an optional prompt-presentation descriptor to `Provider`
(label, formatting description, max-message guidance, attachment guidance),
render the exact existing sentence channel-side, and pass the completed
string into `PromptRuntimeContext`; the application service only appends it.
Application must NOT import the registry (architecture map restricts
application imports) — injection preserves the boundary. Byte-identical
prompt output is the invariant.

### T5 — Doc references (checker enhancement + repairs)
Verified: `architecture_rules.check_doc_references` has NO exemption
mechanism (no marker, no front-matter, no exceptions file; `plan-*` basename
exclusion is scope selection only). 85 dangling rows = 61 in 8 dated
historical records + ~14 template/runtime false positives + ~10 live-doc
short paths. Three parts:
1. **Placeholder skipping**: extend the skip set (rules lines 1503–1511) to
   ignore tokens containing `<...>` placeholders — kills the vendored
   WORKFLOW.md rows without touching the vendored file. (Runtime-created
   ledgers like `plans/roadmap.json` now exist; those rows self-heal.)
2. **Historical-record marker** (checker enhancement + decision record): an
   explicit opt-in HTML comment
   `<!-- doc-references: frozen <ISO-date> (decision 00NN) -->` that scopes a
   document out of dangling-reference checking only (all other gates still
   apply). Stamp the 8 dated records (pr237-final-review, pr237-validation,
   ponytail-audit-2026-07-14/16, media-render-plan-validation,
   permission-durable-storage-plan-validation, agent-e2e-plan-validation-
   round2, outbound-attachments-audit) + the superseded
   permission-floor-and-promotion goal-prompt. Rejected simpler shape:
   de-linkifying 61 refs inside audit records — it mutates historical
   records' text AND recurs for every future dated audit; the class fix is
   the marker (this rejection is the decision).
3. **Path repairs** in live docs (~10 rows): full-prefix short paths in
   artifact-store-s3 / mcp-hybrid-search / media-render / tool-awareness
   goal-prompts; drop-or-footnote the two planned-file refs
   (`examples/3p-updates.md`, `agent-e2e.yml`) in the E2E docs; fix
   codex-harness/codex-self-improvement leftovers under their historical
   banners (or stamp them with the marker too — they are historical).
Checker changes land with tests in `scripts/tests/test_check_architecture.py`.

## Decisions (records created on approval, before decomposition)
- `docs/decisions/0036-doc-reference-historical-records.md` — the frozen-marker
  mechanism, its exact scope (dangling-reference check only), and the named
  initial doc set.
- `docs/decisions/0037-channel-prompt-presentation-descriptor.md` — provider-owned
  prompt presentation injected as a completed string (T4 seam choice).
- `docs/decisions/0038-neutral-e2e-model-credential-env.md` — `E2E_MODEL_API_KEY`
  as the neutral CI variable mapped from the existing GitHub secret.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Unchanged by design | leaf extractions, port injections, byte-identical prompt line |
| API | Unchanged by design | no contract change (AC-4); control routes keep response shapes |
| Data/schema | N-A | no storage touched |
| CLI/ops | Changed | ci.yml env mapping line (secret → neutral name) |
| UI | N-A | none |
| Docs | Changed | ~10 path repairs, 9 frozen-marker stamps, goal doc |
| Tests | Changed | checker-semantics tests; fixture helper; import-path updates |

## Task Decomposition (bounded, disjoint write scopes)
- **A — splits** (T1): the 5 files + their new siblings + import updates.
- **B — control ports** (T2): `control/server/**`, `app/index.ts`,
  `app/bootstrap/fleet-boot.ts`, `control-plane-storage-model.ts`.
- **C — provider neutrality** (T3+T4): the 2 test files, agent-e2e fixture
  kit, ci.yml, `channels/provider-registry.ts`, channel wiring,
  `prompt-profile-service.ts`.
- **D — doc gate** (T5): `scripts/architecture_rules.py` +
  `scripts/tests/`, the stamped/repaired docs.
A–D are pairwise disjoint; runnable in parallel, verified together.

## Risks
- Split-extraction import cycles — Codex verified all extractions are leaves;
  typecheck gates each task.
- T4 prompt drift — pin with a byte-equality test on the rendered channel
  context line for telegram/slack/default before/after.
- Frozen marker abused on living docs — the decision record names the
  allowed set; reviewer lens checks new stamps.
- `npm test` duration — focused suites per task, full gate at closeout.

## Verify Plan
```bash
npm run check:architecture           # exit 0 = definition of done
npm run typecheck
python3 -m pytest scripts/tests -q   # checker semantics incl. new marker/placeholder tests
npm run test:unit                    # focused; full `npm test` at closeout
python3 .agents/scripts/verify.py    # the harness gate itself
```

## Implementation Assumptions

<!-- Made during implementation, NOT part of the approved plan. Dev: review these before merge; promote any that matter to docs/decisions/. -->
- 2026-07-22: Baseline File Size Budget inventory was undercounted (5 of 19 rows; truncated read of checker output). Stage E added for the remaining rows; mcp-tool-proxy ratcheted until CAP-1.
