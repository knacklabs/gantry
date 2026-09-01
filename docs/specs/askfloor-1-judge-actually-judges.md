---
slug: askfloor-1-judge-actually-judges
title: ASKFLOOR-1 — The judge actually judges
status: draft
saved: 2026-09-01T03:41:50+00:00
---

# ASKFLOOR-1 — The judge actually judges: context-aware first-asks in auto mode

Story: ASKFLOOR-1
Inputs: owner directive 2026-09-01 ("the classifier is supposed to judge unknown commands automatically and move only when needed") plus a sol@xhigh validation pass (plans/exploration/askfloor-1-validate.md) whose six findings are folded in. Live diagnosis: the classifier DOES judge unknown shell commands (87 of 102 cached verdicts auto-allowed), and complete `send_message` calls are ALREADY birthright-allowed before any risk bucket (decisions 0052/0121; permission-deterministic-rails.ts:83/:133) — the remaining first-ask pain is the static `high` defaults for browser actions and a deterministic read-only gate that cannot prove several structurally read-only cases.

## Relationship to CARDSIMPLE-1 (owner 2026-09-01: the two are one program)

CARDSIMPLE-1 and ASKFLOOR-1 are complementary halves of "the judge decides; the human is asked only when needed": CARDSIMPLE-1's family rules eliminate REPEAT-asks (Allow settles the future) and its rails-before-family ordering adds the one new branch in the decision coordinator; ASKFLOOR-1 eliminates needless FIRST-asks. This story therefore (a) depends on CARDSIMPLE-1 on the roadmap and builds on its landed state, (b) adds the family rail-hit path to its AC3 invariance suite (a family rail hit must still ask with Allow-once after this story's calibration), and (c) touches only `gantryToolDefaultRisk`/native-risk inputs — never the coordinator branch CARDSIMPLE-1 T1 owns.

## Why

In auto mode the owner should meet the permission system only when something genuinely needs a human. Today provably harmless browser actions (wait, screenshot) and structurally read-only tool actions still interrupt, because the static risk map rates whole tools instead of actions.

## Behaviour

- Interactive `auto` lane ONLY: every change lands as an AUTO-ONLY native-risk input consumed where the classifier's gantry default risk is computed (caller-side, with host-trusted context) — NEVER as a widening of the shared deterministic rails/read-only gate that ask mode, auto_strict and the autonomous lane also consult (validation finding 5: rails feed every lane; a global widening would leak).
- Browser actions get a CLOSED matrix (validation finding 3): `browser_status` and all `browser_inspect` modes stay low (already covered by the read-verb rule); `browser_act` verbs `wait_for` and `screenshot` become low (driver-proven side-effect-free); every other verb — navigation, click, type (even submit:false), press, hover, drag/drop, select/fill, evaluate, upload, dialogs, open-without-URL, tab lifecycle, resize, close — keeps the ask; unknown or malformed action/argument shapes ⇒ ask (payload is an opaque record and permission evaluation precedes dispatch). An exhaustive unit test covers every enum member of the 20-verb surface.
- Additional read-only proofs are ENUMERATED bindings, not a "wider gate" (validation finding 4): each is a `(tool, action, argument predicate, required approved capability)` tuple with host-owned action metadata — initial set: `file` with `action=list|read` (distinct read branches, ipc-file-artifact-handlers.ts:109/:124), FAIL-CLOSED (validation r2): the binding names its literal required capability id, and rejects — i.e. keeps asking for — broad/unscoped lists, `artifactId`-only reads (no resolvable path), and attachment reads; only a path-bearing read inside unprotected workspace scope under the named capability auto-allows. Secret/protected-input rejection and capability checks remain mandatory.
- Unchanged on purpose: `send_message` (already birthright for complete input per 0052; concealed/redacted input keeps its hard-floor ask; a destination-bearing variant would require a NEW decision amending 0052/0121 and is explicitly out of scope), unmapped gantry tools, scheduler mutations, admin/authority mutations, destructive verbs, the YOLO backstop, ask mode, auto_strict, and the autonomous lane (0121).
- Decision hygiene (validation finding 6): this is pure calibration inside decision 0043's contract (deterministic facts to the engine, risk to classification); 0052 and 0121 are cited as the current send_message contracts; NO new decision record is needed.
- Every new auto-allow records the same decidedBy/reason provenance as today.

## Acceptance criteria

- AC1: in auto mode, `browser_act` `wait_for` and `screenshot` proceed without asking with low-risk provenance; every other `browser_act` verb, and any unknown/malformed action or argument shape, still asks; the exhaustive per-verb test covers the full enum.
- AC2: the enumerated read-only bindings (initially `file` list/read) auto-allow in auto mode only when the argument predicate and approved-capability requirement hold and no protected/secret path is touched; failing any condition asks.
- AC3: invariance is proven by EXPLICIT tests, not asserted: ask mode, auto_strict, trusted-host autonomous, YOLO backstop, unmapped/scheduler/admin/destructive asks, and the inline-scheduled path (regression at inline-agent-loop-tools.ts:408, which consults the classifier before checking isScheduledJob) all behave exactly as today.
- AC4: existing unit and Postgres integration suites pass; tsc and check:architecture green.

## Not in scope

Any change to `send_message` semantics (0052/0121 govern; a destination-bearing variant needs its own decision), the LLM classifier's criteria, the shared deterministic rails/read-only gate consulted by non-auto lanes, 0121/0043/#212 posture, egress policy, and CARDSIMPLE-1's family-grant machinery (lands first).
