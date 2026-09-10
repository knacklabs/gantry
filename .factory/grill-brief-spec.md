# Cold-read grill — gate: spec — spec agents-can-use-what-they-are-granted.md

You did NOT write what follows. Read it cold, as an adversary trying to break the handover, never as its author defending it. You are READ-ONLY: return findings, change nothing.

## Interrogation technique

Run the interrogation this way. The harness contract above is the floor; this is the technique.

---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview me relentlessly about every aspect of this until we reach a shared understanding. Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a *fact* can be found by exploring the environment (filesystem, tools, etc.), look it up rather than asking me. The *decisions*, though, are mine — put each one to me and wait for my answer.

Do not act on it until I confirm we have reached a shared understanding.


## Harness grill contract

# Griller Prompt — adversarial handover interrogation

You run BEFORE a handover gate, interrogating the humans in rounds until the
handover has no gaps or contradictions that would surface downstream as
rework. You are not reviewing code — you are stress-testing
what one role is about to hand the next. The gate scripts REFUSE without
your fresh, passing record.

**Independence is the whole point.** A grill has value only when the party
running it did NOT author the artifact under interrogation — a self-grill
inherits the author's blind spots and rubber-stamps the very gap it was meant to
catch (a plan that promised an API surface can pass its own grill precisely
because its author never scoped that surface). So if the coordinating session
authored the plan, the JIT task contract, or the decomposition, it MUST run that
grill in a SEPARATE agent that did not author the artifact — a read-only Codex
pass reading the plan/contract cold, released with
`./forge grill run --gate <gate>` (ledgered, so a killed launcher is still
visible to `forge codex status`; it pins gpt-5.6-terra @ xhigh from
harness.yaml) — rather than certify its own work inline. Codex on `gpt-5.6-terra` @ xhigh
is the required cold reader for planning grills: a fresh model context fully
independent of the authoring session, and because it is read-only it never
writes, so the write-lock that gates the write companion does not apply. Do NOT
use a Claude sub-agent for the grill, and never grill your own work inline.
Interrogate as an adversary trying to break the handover, never as its author
defending it.

RELEASE IT THROUGH THE HARNESS. `./forge grill run --gate <gate>` composes the cold-read brief (this contract plus the artifact) and releases Codex through the SAME ledgered launcher a delegation uses: the pid is recorded before the wait, so a grill whose launcher is killed still shows up in `forge codex status` instead of vanishing. It is read-only, so it takes no delegation lock and can never satisfy `stage done`. Recording the gate stays yours — the cold read only returns findings.

The technique is Matt Pocock's `grilling` skill — the design tree, the
frontier, numbered questions with recommended answers. `doctor --fix` installs
it into BOTH runtimes, and `./forge grill run` also inlines it into the brief,
so a reader reaches it whether or not its runtime resolves skills. This
contract is the harness-side floor; `grilling` is the technique.

`grill-me` is the HUMAN entry point — you type `/grill-me` and it redirects to
`grilling`. It carries `disable-model-invocation: true`, so no model invokes it
and none should be told to.

WHICH RUNTIME CAN RECORD WHICH GATE — get this wrong and you will chase a
refusal you cannot satisfy. ALL SIX gates match the AskUserQuestion ledger and
are therefore CLAUDE-ONLY, each with a floor of ONE logged round: `--gate spec`,
`--gate signoff`, `--gate epics`, `--gate requirements`, `--gate plan` and
`--gate task` — the floors live in `grill_gates.GATES`, one row per gate.
`signoff` and `epics` used to sit outside that check and so recorded with ZERO
rounds behind them; they now answer to it like every other gate.

ONE round is a FLOOR, never a target. Keep going until a round comes back clean
AND the next one stays clean — a single quiet round after a noisy one is a
coincidence, not convergence. The ledger files are written ONLY by `post_tool_use.py` on a
Claude Code AskUserQuestion event; `.codex/hooks.json` registers no PostToolUse
hook, so Codex cannot produce them and neither can a subagent. Delegating a
ledger-matched grill to Codex returns a well-formed payload that the recorder
then refuses, with nothing you can do to satisfy it — the payload was never the
problem, the runtime was.

For those four ledger-matched gates, independence is a COLD READ,
not necessarily a separate process. The recorder accepts ONLY rounds that match a
logged AskUserQuestion record (`record_grill_from_json.py`), and only the
top-level Claude session produces those log entries — a subagent or
read-only Codex pass cannot. So for those grills the top-level session drives
the rounds through AskUserQuestion itself — but because the coordinating session
authored the plan, the independent cold-read pass is MANDATORY, not optional: on
EVERY round release a fresh READ-ONLY Codex pass with
`./forge grill run --gate <gate> [--task <id>]` that reads the plan/contract
cold and returns findings — never a
Claude sub-agent, never grill your own work inline — then carry ALL of those
findings into your own AskUserQuestion rounds (the recorder rejects rounds not in
the ledger, so the top-level session must still ask). Read cold, as an adversary
who did not write it.

ONE COLD READ PER GATE — put every question to the human INSIDE it. The old
shape was Codex grill → your rounds → amend → Codex grill AGAIN, looping until
clean. That loop cannot converge: a fresh reader has no memory of what the last
one found, so it returns a DIFFERENT frontier rather than a shorter one, and the
artifact you amended to close round one becomes round two's input. Stories
reached eleven, twenty-six and forty rounds that way; the last cost six hours.
`forge grill run` now REFUSES a second unconstrained read on a gate that has
already been read since its last recorded pass.

So the WHOLE grill is:

1. `./forge grill run --gate <gate>` — one cold read. WATCH it.
2. Clean? Record the pass and approve. Nothing else happens.
3. Otherwise resolve every finding the REPOSITORY answers yourself — open the
   file and settle it. Take to the human only what the repository cannot
   answer: a decision nobody has made, a priority, a tradeoff between two
   workable shapes. Put those through AskUserQuestion with your recommended
   answer first, all of them, now. There is no later round to save the hard
   ones for, and a finding is not a menu.
4. Amend the artifact ONCE, to what they decided.
5. Record the pass against the AMENDED version, then approve exactly once.

The price is stated plainly, twice over: nothing independent re-reads the
amended version, and a gap this reader misses is not caught by a second reader
at this gate. Both surface at the next gate, or in review. That is the trade
for ending a loop that was costing whole days.

If the human's answers changed the artifact's SHAPE — a component dropped, a
different approach chosen — the amended artifact is not the one that was read
in any useful sense. Say so and read again: `./forge grill run --gate <gate>
--reread "<what changed shape>"`. It is a choice with a recorded reason, not a
way around the rule, and the five-read cap still backstops it. (EVERY gate is ledger-matched — signoff and epics no
longer excepted — so no gate can be recorded by a read-only Codex grill alone:
the top-level session asks the round and records it.)

FRESH CONTEXT, AND THE ANSWERS SO FAR. Every round is a NEW read-only Codex
session — that independence is the whole point. But a reader that knows nothing
of the earlier rounds does not re-find the same gaps, it finds DIFFERENT ones,
so the rounds never shrink and the grill has no natural end. `./forge grill run`
therefore carries every question already put to the human and the answer they
chose, read from the ledger the recorder validates against.

That gives the reader two obligations: do not re-raise settled questions, and
CHECK EACH ANSWER — that the artifact honours it, and that it contradicts no
other answer, accepted decision or constitution rule. An answer can be wrong, or
right and never applied; saying so is part of the read.

Do NOT tell the reader where to concentrate. A cold read is worth having because
it is unconstrained, and steering it toward the diff is how the thing nobody
looked at survives every round. More information, no direction.

END EVERY ROUND WITH AN EXPLICIT CONVERGENCE VERDICT, on its own line, so the
coordinator never has to guess whether to grill again or approve:

- `CONVERGED — no gaps, no contradictions, plan unchanged since the last round`
- `NOT CONVERGED — <the specific reason: open gaps, a contradiction, or the plan
  changed after the last clean round>`

`CONVERGED` on the cold read means there is nothing to amend: record and
approve. `NOT CONVERGED` does NOT mean read again — it means resolve what the
repository answers, put the rest to the human, amend once, and record the pass
against the amended version. Approval happens exactly once.

Five gates, five scopes:

- `--gate spec` (prototype → confirmed capability) — interrogate the exact
  `docs/specs/<slug>.md` file against BRIEF, architecture, decisions, and the
  prototype. Hunt: behavior the prototype proved but the spec omitted,
  implementation choices masquerading as requirements, vague acceptance
  language, and conflicts with active decisions.
- `--gate signoff` (client → PM, before `record_signoff.py`) — interrogate
  `docs/product/DISCOVERY.md`, `BRIEF.md`, confirmed specs, the spec-linked
  roadmap, `docs/decisions/`, and prototype notes. Hunt: unanswered
  stakeholder/constraint questions, scope
  the client saw vs. scope the BRIEF claims, decisions that contradict the
  BRIEF, acceptance criteria that are vibes instead of checks, non-functional
  requirements nobody asked about (auth, data retention, environments).
- `--gate epics` (PM → EM, before `forge roadmap import`) — interrogate the
  proposed epics + stories against BRIEF and decisions. Hunt: BRIEF
  capabilities with no epic (coverage), stories whose acceptance criteria
  contradict a decision record, dependency order that can't work
  (`dependencies` edges), stories too big for one implementation session,
  missing `skill` tags that will stall distribution.
- `--gate plan` (dev, before `forge plan save` — once per story plan) —
  interrogate the draft plan against the roadmap item's `acceptance_criteria`, the
  active decision corpus (`forge decision list --active`), and
  `docs/architecture/`. Hunt: acceptance criteria the plan never addresses,
  scope creep beyond the story, a SIMPLER SHAPE the plan ignores — fewer
  states, fewer components, one less moving part, an existing utility
  instead of a new abstraction; ask "which acceptance criterion does this
  task serve?" and flag every task with no answer (conduct §2 applies to
  plans: over-building fails the grill BEFORE code exists), compatibility
  work with no named consumer — shims, deprecation paths, migration flows
  the BRIEF and decisions justify for NOBODY (conduct §5: a breaking
  replacement deletes the old path unless live users are named), choices missing
  from the plan's Decisions section — INCLUDING any technology, framework,
  package-manager, test-runner, library, data-access, or build-tool pick that
  appears in the plan or tasks as an ecosystem default with no stated best-fit
  justification and no raised open question (conduct §9: silent tooling defaults
  are prohibited — a pick whose fit is unclear must be asked of the human, not
  defaulted; fail the plan on any tooling choice reached for on autopilot).
  Also flag a MISSING quality-gate baseline: any codebase the plan touches must
  wire a stack-APPROPRIATE static-analysis gate — a linter AND formatter, plus a
  type-checker where the language has one — into CI/verify, not merely a test
  runner. Name the CAPABILITY, never a fixed tool: ESLint/Biome for JS-TS,
  Ruff/flake8 for Python, golangci-lint for Go, Clippy for Rust, Checkstyle/
  Spotbugs for Java, and so on — the requirement is generic to every backend, not
  one ecosystem's tool. Fail the plan when code ships with no configured lint/
  format/static-analysis gate that an automated check enforces on every push; an
  absent linter is a silent quality default exactly like an unjustified tool pick.
  Also hold the plan against the CONSTITUTION's coding standards
  (`constitution/README.md` index — read the references it maps to the plan's
  surfaces). The constitution is law, so a plan whose SHAPE omits or contradicts a
  mandated standard is a GAP, not a style preference: HTTP surfaces with no typed
  request AND response DTOs (`pnp-api-standards`, `pnp-swagger-api-documentation-
  standards`), a module ignoring the modular-monolith layout or file-suffix
  standards (`pnp-coding-standards-modular-monolith`, `03`), missing structured
  logging (`05`/`06`) or domain exception handling (`07`), an external integration
  that skips the provider/port pattern (`08`, `pnp-provider-pattern-for-
  integration`), or database work ignoring `pnp-database-standards`. Flag each and
  require the plan to conform or record a deliberate, written deviation — never
  wave it through as "the implementer will follow standards later"; a plan must not
  design AGAINST the law. (`constitution/` is on disk in every environment, so the
  read-only Codex cold-read has the law available — hold the plan to it.)
  Reconcile the plan explicitly against
  EVERY ID from `forge decision list --active`; a conflict becomes a
  contradiction signal or a superseding decision, never a silent exception.
  Also hunt unbounded tasks and a Verify Plan that can't actually falsify the
  work, a `## Surface Impact` row left implicit (every Deferred /
  Unchanged-by-design entry needs a reason), and — CRITICALLY — every row
  classified `Changed` that NO task owns: cross-check each Changed surface
  (runtime behaviour, API, data/schema, CLI/ops, UI, docs, tests) against the
  Task Decomposition and FAIL the plan on any promised surface with no task
  whose contract actually PRODUCES it. A Surface Impact that promises "API
  endpoints" or "a UI" with no owning task is exactly how a half-feature ships —
  domain services no caller can reach, or a frontend wired to a backend that was
  never built. Also flag any RECURRING finding
  class (`./forge findings patterns`) in this story's area the plan neither
  consolidates nor tripwires. In Claude Code the
  `/grill-me` skill run against the plan satisfies this contract. The payload
  carries `"issue"`; the recorder stamps it against the active task.
- `--gate task` (orchestrator → implementer) — the workflow contract places
  this grill before `forge stage start`; the subsequent write `forge delegate`
  is the hard refusal point. Interrogate the next leaf task's just-authored
  contract in the re-recorded decomposition against the approved story plan,
  active decisions, and the actual repository state left by completed prior
  stages. Hunt: assumed files or APIs that prior work did not produce, a
  `write_scope` whose AREAS miss where the work must land or reach into areas
  the task has no business in (scope is directory prefixes plus named new
  files — a missing existing file under a declared prefix, a drifted line
  number or a renamed module is a NON-BLOCKING note, never a blocking finding;
  `stage done` measures the exact paths), acceptance criteria not served by the proposed
  work, a task that OWNS a plan `## Surface Impact` surface but whose
  `write_scope`/`required_tests` do not actually PRODUCE it (owns the API row but
  builds only domain services with no HTTP controllers/DTOs/routes; owns the UI
  row but ships no components) — reachability is part of "done", not a later
  task's problem, required tests that do not prove those criteria, verify commands that
  cannot falsify the change, reviewer focus that misses the risky seam OR that
  re-states shape rules the constitution already sets instead of CITING the
  load-bearing `constitution/` references for the task (the contract points at the
  law, never re-derives or contradicts it), and a
  `user_facing` flag that misclassifies the task — a UI task left `false` (its
  mandatory design skills and design review would be skipped) or a backend task
  marked `true` (forced to attest UI design skills it has no use for).
  This is the JIT task-planning gate from decision 0032, not a repeat of the
  story-level plan grill. Record it for the exact task id and contract digest;
  the digest covers `write_scope`, `required_tests`, `verify_commands`, and
  `acceptance_criteria`. A changed field makes the old task grill stale, and a
  write delegation refuses it; read-only delegation is unaffected.

Method:

1. Read the artifacts in scope FIRST; derive your question list from actual
   text, citing it (`BRIEF.md says X; decision 0003 says Y — which wins?`).
2. Interrogate in ROUNDS until the frontier is empty — not one pass. Each
   round, put the questions whose prerequisites are already settled to the
   human (PM or EM) with your recommended answer; their answers reshape the
   tree and unblock the next round's questions. Stop a single question when it
   would only confirm what a document already states; stop the grill only when
   no gap or contradiction remains unasked. In Claude Code, deliver each
   round's frontier through the AskUserQuestion tool (recommended answer
   first), not prose. For every ledger-matched gate (`spec`, `requirements`,
   `plan`, `task`) the recorder requires
   the FINAL round in the payload to carry `"frontier_empty": true` — that flag
   is how it confirms you stopped because the frontier closed, not because you
   ran out of patience; it is set by hand on the last `rounds` entry, never by
   the ledger. A zero-gap contract still needs at least one such round (every
   gate's floor is 1, and a floor is not a target), so ask a genuine closing
   question
   (e.g. "any remaining gap before we hand off?") and mark it `frontier_empty`.
3. Every finding lands somewhere real before the verdict: a doc edit, a
   `./forge decision new <slug>` record, or an explicit non-blocking entry
   in `open_items`. An `open_items` entry that PARKS scope also gets a
   deferral row with a revisit trigger (`./forge defer add`) — parked scope
   without a trigger is scope silently dropped. Unresolved blocking
   findings ⇒ verdict `blocked`.
4. Record the outcome (schema: `factory/schemas/grill.json`,
   `"generated_by": "griller"`):

   A task-grill input uses this recorded shape (the recorder adds its own
   task id, digests, commit, and timestamps):

```json
{
  "generated_by": "griller",
  "verdict": "pass",
  "gaps": [],
  "contradictions": [],
  "resolutions": ["What was sanctioned"],
  "inspected_refs": ["path/or/path:symbol"],
  "current_flow": "What the repository does now",
  "criteria_map": {"criterion": "proof"},
  "decision": "keep",
  "new_abstractions": ["None"],
  "rounds": [{"question": "Finding or choice", "options": ["Recommended", "Alternative"], "chosen": "Recommended", "frontier_empty": true}],
  "citations": [{"finding": "Repo-answerable finding", "source": "path:symbol"}],
  "open_items": []
}
```

   Each `rounds` entry has a non-empty `question`, two to four non-empty
   string `options`, and a `chosen` value equal to one option. Each citation
   is `{finding, source}`. Every string in `gaps` must be covered by an equal
   `rounds[].question` or `citations[].finding`.

   For every gate — all six are ledger-matched — extra recorder rules bind
   (this is what makes an otherwise well-formed payload fail):
   - Rounds must match the AskUserQuestion ledger and meet the gate floor
     (1 for every gate, and a floor is not a target); the final round carries
     `"frontier_empty": true`. A
     zero-gap grill still records its floor of real rounds — never zero.
   - `--gate task` only: `criteria_map` is a THREE-WAY equality — its KEYS must
     equal the frontier task's `acceptance_criteria` set AND the set of its
     `plan_contracts[].statement` values, exactly (no extra key, none missing);
     each value is the non-empty proof for that criterion. Author the task's
     `acceptance_criteria` and its `plan_contracts` statements as the SAME
     strings so there is one coherent key set to satisfy.

```bash
python3 factory/scripts/record_grill_from_json.py --gate <spec|signoff|epics|requirements|plan|task> --input <json> [--input-digest <artifact>] [--task <id>]
```

5. For every gate except task, commit the resolution edits
   BEFORE recording the grill — those gates check freshness against BOTH
   committed history and the working tree: any guarded doc changing after the
   grill (even uncommitted) stales it. (The sign-off / epics-approved decision
   records themselves are expected afterwards and don't stale it.) The task
   gate instead binds directly to the re-recorded task contract digest; the JIT
   sequence does not require a commit between re-recording and grilling. But that
   digest still folds in the product tree, so record the task grill LAST — after
   any docs/ or factory/scripts commits: a tracked change outside .factory/ and
   plans/ that lands between grilling and `task approve`/`stage start` re-stales
   it and forces a re-grill.
6. `--input-digest` is REQUIRED for the spec, epics, and plan gates: pass the
   exact spec / roadmap input / plan draft you interrogated. The gate verifies the
   digest — grilling version A never approves an edited version B; if the
   artifact changes, re-grill it. For `--gate task`, pass `--task <id>` and NO
   `--task-digest` — that flag was removed and the recorder rejects it; the
   recorder derives the grounding digest itself from the protected contract,
   approved plan, and product tree, and stores the result at
   `.factory/grills/tasks/<id>.json`.

A `pass` with unresolved findings is refused by the recorder. Grill hard;
downstream implementation inherits whatever you let through.



## Already answered on this story — verify, do not re-ask

These questions were put to the human and answered. Two obligations:

1. Do NOT raise them again as open questions. They are settled.
2. DO check each answer still holds — that the artifact actually honours it, and that it does not contradict another answer, an accepted decision, or the constitution. An answer can be wrong, or right and never applied. Saying so is part of this read.

- Q: SELF-1 — when an AI employee proposes a change to itself, what is the default for a new agent?
  A: Review-only by default; owner opts specific classes into auto-apply (Recommended)
- Q: INCIDENT-1 — what does `freeze` do to work already in flight?
  A: Soft by default: no new runs or tool calls, in-flight turns finish; `--hard` cancels immediately (Recommended)
- Q: ADMIN-ALERT-1 — where do admin alerts go in V1.0?
  A: One Teams/Slack conversation only (Recommended)
- Q: OPS-DR-1 — where do backups go?
  A: S3-compatible bucket or local path, operator's choice (Recommended)
- Q: LIFECYCLE-1 — default retention when the operator sets nothing?
  A: Messages 90 days, memory until offboarding, audit 400 days minimum (Recommended)
- Q: INTRO-1 — when does the intro card post in a channel?
  A: Once, on install, plus on first @mention by any new person (Recommended)
- Q: REVISION-1 — who can restore a prior persona/access revision?
  A: Owner for persona; administrator for access (Recommended)
- Q: Anything else to settle before I confirm these eleven specs and open the PR?
  A: No — confirm and open the PR (Recommended)
- Q: If the job card itself can't be created for a request (DB down, no group route), what should the run get?
  A: Deny the tool call with a plain reason (Recommended)
- Q: Anything else to settle for JOBPERM-2 before I confirm the spec and plan it?
  A: No — confirm and plan (Recommended)
- Q: Should attaching a skill remain separate from authorizing its declared actions?
  A: Keep separate (Recommended)
- Q: The independent cold read found no contradictions. Is the current Skills UI spec ready to confirm?
  A: Confirm spec (Recommended)
- Q: Requirements grill (cold-read finding 3) — the rails-before-rules ordering change: apply it ONLY to the new family rules, or to every reviewed rule? Either way the new decision record explicitly amends 0121/0144's approval-permanence wording for the rail-hit case.
  A: Family matches only (Recommended)
- Q: Requirements grill (cold-read finding 4) — late DENY (tap after the run died): what does the card do?
  A: Denial receipt + keep Reconsider (Recommended)
- Q: Spec re-confirm round: the CARDSIMPLE-1 spec was amended per the requirements cold-read — real action-shape×blocker-type matrix in AC1, rails scoped to family matches only (explicitly amending 0121/0144 for the rail-hit case), late Deny = denial receipt + Reconsider kept (no Run now), 0124 bounded delivery preserved with operator-initiated same-identity recovery, non-job cards excluded from scope. Confirm the amended spec so planning proceeds?
  A: Confirmed — go (Recommended)
- Q: Plan grill round 1 — all three cold-read passes folded (14 findings: typed family-match classification with rails forcing Allow-once; fingerprint-keyed lease-free card ingress + setup-origin delivery states; prompt-fold as migration; Pause deletion scoped to the affordance layer; live|late|stale matrix per needId+askingEpoch; deterministic receipt/Run-now identity; T3 now depends on T1 AND T2; the new decision amends 0040 + JOBPERM-2 too). One formal gate surfaced: decision 0134 (piped commands never durably granted for autonomous runs) is still marked PROPOSED though we've been treating it as binding. Accept 0134 now?
  A: Accept 0134 — and go (Recommended)
- Q: Plan grill convergence — round 2's three contradictions are fixed (family-only rails algorithm explicit, the two `once` cases, 0134 recorded accepted) and the round-3 terra cold-read returned CLEAN. Approve the CARDSIMPLE-1 plan (T1 family grants ∥ T2 canonical card → T3 late tap) so I record the grill, save the plan, and cut the decomposition?
  A: Approve — go (Recommended)
- Q: First-ask floor: repeats are covered by CARDSIMPLE-1's family rules, but the auto-mode classifier will still ask on FIRST use of anything not provably read-only (send_message, sheets writes, new tools). Tune that now?
  A: Follow-up story after CARDSIMPLE-1 (Recommended)
- Q: CARDSIMPLE-1 simplicity convergence — four sol@xhigh rounds cut 14 mechanisms and deferred 5 (T1: boolean flag + one coordinator seam + ONE narrow decision; T2: reuse 0124's delivery machinery and the existing raise seam, deletion-heavy, no new states/fields/ingresses; T3: one opId idempotency via the CARDFIX-1 pattern, zero-fanout first); final verdict SIMPLE ENOUGH with all behavior rulings intact (family grants, pipes-never-Allow, one surface, 0144, no auto-run). Approve the simplified plan so I re-gate and cut the slim decomposition?
  A: Approve — go (Recommended)
- Q: Parallel worktrees for CARDSIMPLE-1: the harness only parallelizes STORIES, not one story's tasks (intra-story = symphony-forge #145 stage B, deferred for its evidence-merge risk). How do you want the parallelism?
  A: Split into two stories
- Q: CARDSIMPLE-1-T1 task grill: round 1 (terra cold-read) found 5 issues — inline-lane suggestion overwrite, SDK-supplied-suggestion bypass, imprecise family predicate (script shapes must stay rejected while gh */aws * flip to admitted), additive-only isFamilyRule with mixed-compound semantics, and contract/scope alignment — all folded into the task plan; round 2 returned CLEAN. Go: record the grill, approve the task, start the stage and delegate to Codex sol@xhigh?
  A: No further notes — go (Recommended)
- Q: Single-session management of both worktrees is blocked by ONE hook: grill rounds/plan markers ledger only to this checkout (repo_root = session dir). How do we proceed?
  A: Fix the harness upstream (Recommended)
- Q: Gantry is DOWN (startup crash loop). Cause: my npx-shim hardening (merged in #465, deployed) makes settings validation reject your two stored grants — RunCommand(npx remotion *) and RunCommand(npx remotion render *) — and startup hard-fails on invalid settings. The permission classifier blocked every recovery path I tried (settings edit, build rollback, even opening a quickfix window). How do you want service restored?
  A: Remove the 2 npx grants (Recommended)
- Q: Should re-enabling a disabled provider preserve omitted stored fields through the existing sparse PATCH flow?
  A: Preserve via PATCH (Recommended)
- Q: Should first setup prevent saving or constructing a request until a multi-method provider’s authentication method is explicitly selected?
  A: Require selection (Recommended)
- Q: Before the spec hands off to planning, is there any remaining gap you want closed?
  A: No gap, hand off (Recommended)

## The artifact under interrogation (spec agents-can-use-what-they-are-granted.md)

---
slug: agents-can-use-what-they-are-granted
title: Agents can use what they are granted
status: draft
saved: 2026-09-10T10:57:43+00:00
---

# Agents can use what they are granted

## Why

Granting an agent access is not the same as making that access usable. Two
surfaces grant something and then leave the agent unable to use it. They look
like separate bugs and share a shape: what the agent was given is not present in
the form the agent actually works in.

**Capabilities: the grant is invisible.** The KnackLabs lead-maintenance job
holds a reviewed grant for `google.sheets.values.get`, a semantic capability
bound to a local CLI. In seven consecutive runs the agent opened every run by
burning failed calls before its first successful sheet read, in a fixed order: an
MCP server that does not exist, a tool that does not exist, then arguments
outside the reviewed template. The job prompt (3,513 characters) never mentions
that machinery.

Only the third failure is a template mismatch. The first two are the model
reaching for shapes it knows because it cannot see the one it has. That run
carried 62 allowed tools but 11 available, with tool search in automatic mode
(`apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-search-decision.ts:88`).
Commit 97ded3746 added a per-capability block to the runner's runtime capability
context (`apps/core/src/runner/mcp/context.ts:412`), not the system prompt. It
deployed and changed nothing, because context prose cannot help a model choose a
tool it cannot see. The model-visible catalog that does reach it
(`apps/core/src/application/agents/agent-prompt-capability-guidance.ts:241`)
renders a display name, category and description, and carries neither the
capability's stable id nor its invocation shape.

Decision 0158 settles the direction: discovery is the defect, and argv validation
remains the enforcement boundary. Decisions 0120 and 0130 stand unamended, so
this story adds no classifier-derived or cached allow to `capability_run` and
does not relax the reviewed template. Freeing the call shape is recorded in 0158
as direction gated on a replacement boundary, and is out of scope here.

**Documents: the grant is only usable whole.** `scheduler_update_job` replaces a
job prompt wholesale. The flattened 600-character read (GitHub #447) is already
fixed on a held branch
(`apps/core/src/runner/mcp/tools/scheduler-formatters.ts:138`). Three defects
that fix did not touch remain:

- **The read is redacted, so it is unsafe as an edit source.** Redaction is not
  identity: it rewrites `Bearer <token>` to `bearer [REDACTED_SECRET]` and
  `password: x` to `password=[REDACTED_SECRET]`
  (`apps/core/src/shared/sensitive-material.ts:132`). An exact-match edit built
  from a redacted read can fail to match or write the marker over a real value.
- **There is no compare-and-swap.** Job update input carries no expected version
  (`apps/core/src/application/jobs/job-management-types.ts:265`), the update
  service loads then writes (`.../job-management-update.ts:41`), and the
  repository updates by id alone
  (`apps/core/src/adapters/storage/postgres/repositories/canonical-job-repository.postgres.ts:261`),
  so two writers clobber each other silently. Decision 0108 defines
  `definition_revision` but it is not built: the jobs schema has no such column
  (`apps/core/src/adapters/storage/postgres/schema/jobs.ts:20`). Completing 0108
  is therefore owned scope here, not a dependency to assume, and it supplies the
  single revision this contract fences on. No second token is introduced.
- **The one existing edit-by-substring primitive is wrong.** The `FileEdit`
  facade calls `current.replace(...)`
  (`apps/core/src/adapters/llm/deepagents-langchain/runner/gantry-facade-tools.ts:485`),
  replacing the first match with no uniqueness check.

**Editing a job is attended work.** Decision 0106 holds that an unattended
scheduled run may inspect the scheduler but never mutate it, and requires both
halves of its protection: the mutation tools are absent from scheduled tool
surfaces, and the host rejects any mutation whose signed provenance names a
scheduled source (`apps/core/src/jobs/ipc-scheduler-mutation-authority.ts:18`).
Both halves apply here. `document_str_replace` and `document_insert` are absent
from scheduled tool surfaces; `document_view` is a read and stays available to a
scheduled run.

## Behaviour

**A granted capability is visible before the first attempt.** The model-visible
capability catalog carries, for every granted capability, its stable capability
id and the invocation shape that reaches it: the dispatcher tool name and the
argument list. That descriptor is present in the initial materialization the
model receives, before its first attempt, in the lane the run executes on, and
independently of whether tool search has loaded anything else. Enforcement is
untouched: argv validation, executable identity, structured argv with no shell,
size and NUL limits, and the existing sandboxed executor all stay exactly as 0120
and 0130 define them. Only the superseded per-capability block added by
97ded3746 is removed; the generic dispatcher tool and its contract stay.

**Documents are read in slices and edited in place.** The contract is a property
of documents, not of a surface. Version one binds exactly one document store, the
scheduled-job prompt; further surfaces are deferred, and binding one later means
registering a store, not writing another tool. Authority-bearing documents are
excluded by construction: an agent may never edit what determines its own access.

The tools, adopting the `memory_20250818` command shape:

- `document_view { document_ref, view_range? }` — `view_range` is `[start, end]`,
  1-indexed and inclusive over lines, `-1` meaning end of document. Returns the
  requested lines, the document's `revision`, and its total line count.
- `document_str_replace { document_ref, old_str, new_str, expected_revision }` —
  replaces one exact span.
- `document_insert { document_ref, insert_line, insert_text, expected_revision }`
  — inserts after the given 1-indexed line.

`document_ref` is a store key, never a filesystem path. It resolves against the
document's canonical owner as decision 0114 defines it, never from a
conversation JID or workspace, and against the acting person as decision 0118
defines it; the existing conversation-derived helper
(`apps/core/src/application/jobs/job-management-access.ts:9`) is not reused. An
unresolvable owner or acting person fails closed. Uniqueness is counted over the
whole stored document, never over the returned slice.

**Failure is loud, literal, and leaves the document untouched.** Absent expected
text returns ``No replacement was performed, old_str did not appear verbatim in
{document_ref}.`` Ambiguous expected text returns ``No replacement was performed.
Multiple occurrences of old_str in lines: {line_numbers}. Please ensure it is
unique.`` A stale revision returns ``No write was performed. {document_ref} is at
revision {actual}; the edit expected {expected}.`` No error echoes the submitted
text back.

**Concurrent edits cannot silently lose work.** A write is one conditional
persistence operation matching document identity and `expected_revision`,
incrementing the revision inside the same transaction, and returning the actual
revision on conflict.

**Secrets never round-trip and never leak through probing.** Reads stay redacted,
and redaction preserves line coordinates: a replacement marker occupies the same
number of lines as the span it replaces, so a range read and the stored document
agree on line numbers even when a secret spans lines.

An edit is refused when its expected text overlaps a protected span in the stored
text, detected against the stored text rather than by scanning the request for
markers. That refusal is indistinguishable from the ordinary not-found result:
both return the same literal string, so a caller cannot use the difference as an
oracle for whether a guessed secret is present. Repeated failed replacements on
one document are rate-limited.

Replacement text is redacted at ingress, before any permission record, transcript
or audit row is written, so submitted secret-shaped text never persists in the
clear. Text that is itself secret-shaped may be written into a document, since a
prompt may legitimately contain one, but it is stored as given and rendered
redacted on every subsequent read.

**Existing authority is preserved.** Where a surface gates writes behind review or
approval, the edit contract routes through that gate rather than around it.

## Acceptance criteria

Runtime scope is the Anthropic worker lane the KnackLabs job runs on; other lanes
are deferred. Document scope is the scheduled-job prompt.

1. The initial model-visible materialization in the worker lane contains, for a
   granted capability, its stable capability id and its invocation shape, proven
   by a hermetic test over the real catalog and tool-materialization path and
   asserted against the exact rendered descriptor, including when the run's
   available-tool count is below its allowed-tool count.
2. A deterministic replay of a recorded run, driven from that materialization
   with no live model call, issues a well-formed call to the granted capability
   as its first capability attempt, with no preceding call to a non-existent MCP
   server or tool. The fixture and the descriptor it asserts are named in the
   test.
3. Enforcement is unchanged: hermetic tests assert that a template mismatch is
   still refused, that no classifier-derived or cached allow reaches
   `capability_run`, and that executable identity, structured argv, size and NUL
   limits still apply. The existing proofs for 0120 and 0130 stay green.
4. The per-capability block added by 97ded3746 no longer exists, and the generic
   dispatcher tool and its contract are unchanged.
5. Live smoke, stated separately from the hermetic proofs and explicitly not a
   merge gate: five consecutive runs of job
   `job-knacklabs-lead-maintenance-43527c192a6e` on the deployed runtime,
   triggered serially with no retry between them. Each run must contain at least
   one successful capability invocation, and zero `tool.activity` rows with phase
   `failure` for tools `capability_run` or `mcp_call_tool` before it. Evidence is
   the per-run event query and the run's tool-search diagnostic, retained in
   redacted form on the story.
6. Jobs carry `definition_revision` per decision 0108: a migration adds it, every
   operator-meaningful definition write increments it, runs record the revision
   they claimed, and finalization fences on it. Proven by the tests 0108 names.
7. `document_view` returns a requested inclusive line range, the revision, and the
   line count, proven against a prompt over 3,000 characters containing blank
   lines and leading whitespace.
8. `document_str_replace` replaces one exact span and leaves every other byte
   identical, proven against the same document.
9. Absent expected text returns the literal not-found string and the document is
   unchanged.
10. Expected text occurring more than once returns the literal not-unique string
    naming the matching line numbers, counted over the whole document, and the
    document is unchanged.
11. A write carrying a stale revision is refused with the literal stale string and
    the actual revision, proven by two concurrent writers where the loser errors
    and the winner's text survives. The persistence operation is one conditional
    statement matching document identity and expected revision and incrementing
    it in the same transaction, asserted at the repository level. A concurrent
    whole-document `scheduler_update_job` is fenced by the same revision, proven
    by a test that races the two paths.
12. An edit whose expected text overlaps a protected span returns a response
    byte-identical to the not-found response, proven by a test comparing both
    responses; repeated failures on one document are rate-limited; and no error,
    transcript, permission record or audit row contains unredacted bytes.
13. Redaction preserves line coordinates, proven against a document containing a
    multi-line secret where a range read and the stored document agree on line
    numbers.
14. `document_str_replace` and `document_insert` are absent from scheduled tool
    surfaces, and a forged scheduled provenance is rejected by the host. Both are
    tested, per decision 0106.
15. `document_ref` resolution is authority-checked against the canonical owner
    (0114) and acting person (0118), failing closed when either is unresolvable;
    a caller without write authority is refused, and an authority-bearing
    document cannot be addressed at all.
16. The first-match-only replacement at `gantry-facade-tools.ts:485` no longer
    exists in any edit path.
17. Focused proof by name: the scheduler tool suite, the capability invocation
    suite, the tool-search decision suite, the capability guidance suite, the
    permission ladder suites, the job revision fencing suite and the new
    document-contract suite. `npm run typecheck`, `npm run lint`,
    `npm run format:check`, `npm run check:architecture` and `verify.py` green.

## Notes

Decision 0153's clauses excluding the classifier from autonomous runs were
amended on 2026-09-10 to match 0157, which supersedes 0121 and puts jobs on the
chat ladder; what survives is the learned-decision projection running before the
ladder. Ladder behaviour is cited from 0043 and 0157. Decision 0156 is the
console deployment decision and is not a ladder citation.


## What to return

Findings only: contradictions, gaps, unstated assumptions, and anything a reader would have to guess. Say what would break and why. Do not record a gate — the coordinating session records it.

The round count below is a FLOOR, not a target. Keep grilling until a round comes back clean AND stays clean on the next one — hitting the floor is not the same as passing.
