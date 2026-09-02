# ASKFLOOR-1 — The judge actually judges: context-aware asks in auto mode

Story: ASKFLOOR-1
Inputs: owner directive 2026-09-01 ("the classifier is supposed to judge unknown commands automatically and move only when needed") plus two sol@xhigh validation passes — the original first-ask validation (plans/exploration/askfloor-1-validate.md, six findings folded) and the 2026-09-01 auto-mode-parity gap hunt (plans/exploration/classifier-automode-consolidated.md, three passes). Live diagnosis: the classifier DOES judge unknown shell commands (auto-allowing low/medium), and complete `send_message` calls are ALREADY birthright-allowed before any risk bucket (decisions 0052/0121). The remaining pain is threefold: (a) static `high` defaults for whole tools skip the classifier; (b) a human's Allow is NOT learned, only used as prompt-hint text, so identical requests can re-ask; (c) a deterministic read-only gate cannot prove several structurally read-only cases.

## Relationship to the sibling stories (owner 2026-09-01: one program)

The "judge decides; the human is asked only when needed" program spans three stories, kept scope-disjoint:
- CARDSIMPLE-1 (landed): family rules eliminate REPEAT-asks for grantable commands; rails-before-family ordering added the one coordinator branch. ASKFLOOR-1 depends on its landed state and adds the family rail-hit path to its invariance suite.
- ASKFLOOR-1 (this story): eliminates needless FIRST-asks (arg-aware native risk) AND makes human decisions STICK for shapes that can't hold a family grant (decision-learning). Touches only the caller-side native-risk inputs to `gantryToolDefaultRisk` and an auto-only human-decision memory consulted before the LLM — NEVER the shared deterministic rails/read-only gate, NEVER the family-synthesis machinery.
- SHIMPIN-1 (new sibling, NOT this story): package-pinned runner-shim families (`npx <pkg> *`) so shim commands can hold a durable grant. Lives in family-rule-synthesis/bash-command-parser — CARDSIMPLE-1 machinery territory, explicitly out of ASKFLOOR-1's scope. Cross-referenced because ASKFLOOR-1's decision-learning is the fallback for shims until/unless SHIMPIN-1 lands.
- CARDSIMPLE-2 (sibling): the card surface (explain-on-exclusion, settle/retract lifecycle).

## Why

In auto mode the owner should meet the permission system only when something genuinely needs a human — and never twice for the same decision they already made. Today provably harmless actions still interrupt (the static risk map rates whole tools, not actions), and a human's approval is forgotten (used only to bias the next LLM verdict), so identical requests — especially a scheduled job's per-run shim/pipe commands — re-ask every time.

## Behaviour

### 1. Human decisions are learned and consulted before the judge (auto only) — NEW, highest impact
- When a human settles a permission in the interactive `auto` lane (Allow-once or Allow-future), record that outcome keyed by the EXACT effect hash (permission-effect-key.ts), as a distinct HUMAN-DECISION record — separate from the existing classifier-verdict cache, which caches machine verdicts, not human outcomes.
- Before consulting the LLM classifier, consult the human-decision memory: an exact-effect match that a human ALLOWED auto-allows with human-decision provenance; an exact-effect match a human DENIED keeps the deny. No match ⇒ fall through to the classifier exactly as today.
- Invalidation: a human-decision record is invalidated when the deterministic rails version bumps (a tightened rule must re-ask) and when its scope inputs change; records are auto-lane-only and never consulted by ask mode, auto_strict, or the autonomous lane.
- Keying discipline (gap-hunt pass 2): the human-decision key is the EXACT effect hash (raw command/tool/agent/cwd-normalized), NOT the family rule — family keys stay promotion-hint-only, to avoid over-colliding distinct args. This is the ONLY learning path for shapes that can never hold a family grant (runner shims, pipes, generated-runtime commands), so a scheduled job stops asking every run for a command the human already approved.

### 2. Arg-aware native risk before the coarse identity buckets — extends the closed-matrix approach

#### Live evidence (2026-09-02, ~/gantry/logs/gantry.log + gantry.permission_* — plans/exploration/askfloor-1-runtime-evidence-2026-09-02.md)
In `permission_mode: auto`, ten pure-read shell commands (`ls`, `head`, `wc`, `grep`, `sed -n`, `git log`, `find`) went to a human tap in three minutes because the shared deterministic gate REFUSED them — "Command target is outside the owner-declared trusted roots: …/Workdir" (roots are learned; `~/Workdir` was never learned), "…: /dev/null" (a `2>/dev/null` redirect misread as a target), "Bash meta-executor find is not supported for persistent approval" — and a refusal goes STRAIGHT to ask: no classifier line exists in that window; `deterministic_read_only` decided once in 48 hours. Reading an attachment the owner sent cost three taps (`mcp__gantry__file` classified "can mutate depending on arguments" twice, then the `ls`). 975 of 976 decisions in 48 hours were `allow_once`: taps teach nothing. The judge exists (104 `classifier_verdict` rows in decision memory) but is bypassed for the common case.

What this changes in this section: the refusal itself is the bug, not the rails. In auto mode a deterministic-gate refusal of a shell command (out-of-trusted-root path, unsupported meta-executor such as `find` without `-exec`) must be routed to the classifier WITH the refusal reason as context, so a read is judged low and allowed and only genuine risk asks — never widening the shared rails (they stay exactly as consulted by the ask/autonomous lanes). Separately, the parser's `2>/dev/null` handling is a plain correctness bug in the shared rails (a redirect to `/dev/null` is never a path target) and is fixed as such.
- The native-risk input consumed at `gantryToolDefaultRisk` becomes ACTION/ARGUMENT-aware for bounded cases, computed caller-side with host-trusted context, still NEVER widening the shared rails/read-only gate (gap-hunt pass 1 + validation finding 5: rails feed every lane; a global widening would leak to ask/auto_strict/autonomous).
- Browser CLOSED matrix (validation finding 3): `browser_status` and all `browser_inspect` modes stay low; `browser_act` verbs `wait_for` and `screenshot` become low (driver-proven side-effect-free); every other verb — navigation, click, type (even submit:false), press, hover, drag/drop, select/fill, evaluate, upload, dialogs, open-without-URL, tab lifecycle, resize, close — keeps the ask; unknown/malformed action or argument shapes ⇒ ask. Exhaustive per-verb unit test over the full enum.
- Grantable-exact un-shadowing (gap-hunt pass 1, finding 3): a `classifyDurableGantryMcpToolName` = `grantable-exact` (routine, boundable) invocation must not be forced HIGH by an earlier coarse identity bucket; its risk is judged on arguments (or routed to the classifier) rather than the tool name.
- Unmapped/known-but-unmapped gantry tools route TO the classifier instead of an unconditional HIGH default (gap-hunt pass 1, findings 1 & 4).
- Enumerated read-only bindings (validation finding 4): each is a `(tool, action, argument predicate, required approved capability)` tuple with host-owned metadata — initial set `file` with `action=list|read`, FAIL-CLOSED: names its literal required capability id and keeps asking for broad/unscoped lists, `artifactId`-only reads, and attachment reads; only a path-bearing read in unprotected workspace scope under the named capability auto-allows.

### 3. Classifier unavailability — NEW (gap-hunt pass 1, finding 4)
- Define and TEST the degraded behaviour when the classifier cannot be reached: fail-closed to ask (never silent-allow), with explicit provenance. Today the await has no local fallback.

### Unchanged on purpose
`send_message` stays birthright for complete input (0052; concealed/redacted input keeps its hard-floor ask; a DESTINATION-BEARING variant still requires a NEW decision amending 0052/0121 and is explicitly OUT of scope — arg-awareness here must not silently admit it). The shared deterministic rails/read-only gate, ask mode, auto_strict, the autonomous lane (0121), destructive verbs, authority-changing/dispatcher/delegation/decision-actor buckets, and the YOLO backstop all keep asking. Family-synthesis machinery is untouched (SHIMPIN-1 owns it).

## Decision hygiene
Arg-aware calibration is pure work inside decision 0043's contract (deterministic facts to the engine, risk to classification); 0052/0121 cited as the send_message contracts. The human-decision memory is a NEW auto-lane learning mechanism — assess at grill whether it needs its own decision record (likely yes: it introduces a human-outcome store consulted before the classifier); flag for the owner. Every new auto-allow records decidedBy/reason provenance (human-decision vs classifier-low) distinctly.

## Acceptance criteria

- AC1: in auto mode, `browser_act` `wait_for` and `screenshot` proceed without asking with low-risk provenance; every other `browser_act` verb, and any unknown/malformed action or argument shape, still asks; exhaustive per-verb test covers the full enum.
- AC2: the enumerated read-only bindings (initially `file` list/read) auto-allow in auto mode only when the argument predicate and approved-capability requirement hold and no protected/secret path is touched; failing any condition asks.
- AC3: NEW — a human Allow in auto mode on an exact effect is LEARNED: an identical later request in auto mode auto-allows with human-decision provenance WITHOUT re-consulting the classifier; a human Deny is likewise honored; a rails-version bump invalidates the record so it re-asks. Proven for a shape that cannot hold a family grant (a runner shim or pipe) so a scheduled job stops re-asking every run. Live evidence 2026-09-02: 975 of 976 decisions in 48h were allow_once, so today no tap is learned; the learning path must be the default outcome of an owner decision.
- AC4: NEW — grantable-exact gantry invocations and unmapped gantry tools are no longer forced HIGH by identity; they are judged arg-aware or routed to the classifier, while destructive/authority/dispatcher/scheduler-mutation/admin-mutation buckets and `send_message` destination variants still ask. In auto mode a deterministic-gate REFUSAL of a shell command (out-of-trusted-root target/cwd, unsupported meta-executor without `-exec`) is routed to the classifier with the refusal reason as context instead of forcing ask; the shared rails are not widened, and the `2>/dev/null`-as-target misparse is fixed in the shared parser as a correctness bug (live evidence 2026-09-02).
- AC5: NEW — when the classifier is unavailable, auto mode fails closed to ask (never silent-allow), with explicit provenance, under test.
- AC6: invariance proven by EXPLICIT tests (not asserted): ask mode, auto_strict, trusted-host autonomous, YOLO backstop, unmapped-forced-ask-where-still-required, scheduler/admin/destructive asks, the CARDSIMPLE-1 family rail-hit (still asks with Allow-once), and the inline-scheduled path (regression at inline-agent-loop-tools.ts:408) all behave exactly as today except where AC3/AC4 deliberately change them.
- AC7: existing unit and Postgres integration suites pass; tsc and check:architecture green.

## Not in scope

`send_message` destination-bearing semantics (0052/0121 govern; needs its own decision), the LLM classifier's internal criteria, the shared deterministic rails/read-only gate consulted by non-auto lanes, 0121/0043/#212 posture, egress policy, package-pinned shim families (SHIMPIN-1), and the card surface (CARDSIMPLE-2).

## Scope note (owner action)
This spec was EXPANDED on 2026-09-01 from first-ask calibration to also include decision-learning (AC3) and arg-aware bucket un-shadowing (AC4) + classifier-unavailability (AC5), per the owner's "fold the change set in" directive. The expansion is material — re-grill and re-confirm before decomposition.
