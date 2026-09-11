# Cold-read grill — gate: spec — spec cache-bug.md

You did NOT write what follows. Read it cold, as an adversary trying to break the handover, never as its author defending it. You are READ-ONLY: return findings, change nothing.

## Interrogation technique

Run the interrogation this way. The harness contract above is the floor; this is the technique.

---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled — the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Each question should be formatted like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree — settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it — don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report — ask the rest of the frontier now. The _decisions_ are the user's — put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.


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

The read-only Codex cold-reader LOADS and RUNS the `grill-me` skill (Matt
Pocock's, installed into `~/.codex/skills/grill-me` by `./forge doctor --fix`)
to structure its interrogation; this contract is the harness-side floor, the
skill is the technique. In Claude, the `/grill-me` skill satisfies the same.

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
Claude sub-agent, never grill your own work inline — then carry ONLY those
findings into your own AskUserQuestion rounds (the recorder rejects rounds not in
the ledger, so the top-level session must still ask). Loop Codex grill → your
AskUserQuestion rounds → answers → Codex grill again, until a round is clean AND
the plan is stable; only then, approve exactly once. Read cold, as an adversary
who did not write it. (EVERY gate is ledger-matched — signoff and epics no
longer excepted — so no gate can be recorded by a read-only Codex grill alone:
the top-level session asks the round and records it.)

FRESH CONTEXT, NOT FRESH READING. Every round is a NEW read-only Codex session —
that independence is the whole point, and it is why the reader has no memory of
what it already blessed. It does NOT mean re-deriving the plan from scratch every
round: after the FIRST round, hand the fresh reader the plan AND what changed
since the last round (the resolutions you just folded in, and which sections they
touched), and tell it to concentrate there while still refusing anything it can
see is wrong elsewhere. Same cold judgement, a fraction of the tokens.

END EVERY ROUND WITH AN EXPLICIT CONVERGENCE VERDICT, on its own line, so the
coordinator never has to guess whether to grill again or approve:

- `CONVERGED — no gaps, no contradictions, plan unchanged since the last round`
- `NOT CONVERGED — <the specific reason: open gaps, a contradiction, or the plan
  changed after the last clean round>`

Converged means BOTH: this round is clean AND the plan did not change after the
round that made it clean. A clean round on a plan you have just edited is not
convergence — it is an unreviewed edit. Only `CONVERGED` authorises asking the
human for approval, and approval happens exactly once.

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
  stages. Hunt: assumed files or APIs that prior work did not produce, stale
  or over-broad `write_scope`, acceptance criteria not served by the proposed
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



## The artifact under interrogation (spec cache-bug.md)

---
slug: cache-bug
title: cache-bug — Retire oversized provider sessions across runner restarts
status: draft
saved: 2026-09-09T08:20:16+00:00
---

# cache-bug — Retire oversized provider sessions across runner restarts

## Why

Every persistent interactive runner start does two things at once: it resumes
the persisted provider session (which already holds every earlier user,
assistant and tool turn) AND it appends a freshly reconstructed briefing (up to
12,000 characters of durable memory plus up to 16,000 bytes of recent channel /
active thread context) as a new user turn. The per-turn briefing is a pinned
guarantee (decision 0089: every provider turn sees the channel block plus the
thread window; decision 0078: memory hydrates once per turn, with its
session-fence rehydration fallback) and stays as is. What is NOT bounded is
the transcript those briefings accumulate in: nothing expires a provider
session by age, turn count or size — the idle timeout only closes the runner's
stdin, and compaction fires only on explicit `/compact` or when the SDK
reaches the model's context window.

Production evidence (Slack): a one-word turn ("yes") read roughly 270k cached
input tokens on each of two model calls inside one execution (pre-tool and
post-tool), about 541k tokens for the turn. Prompt caching discounts the
repeated prefix; it does not remove it from the context window, stop stale
duplicate briefings reaching the model, or protect against cache misses.

Both execution adapters are affected, differently:

- Claude Agent SDK: model-visible context grows linearly until SDK autocompact
  at the context window (≈1M on the deployed model). Cost and latency grow.
- DeepAgents / LangChain: the library summarises at ~85% of a known window, so
  model-visible history is bounded, but the LangGraph Postgres checkpoint keeps
  the raw state, so checkpoint tables and checkpoint load latency grow instead.
  No application path owns checkpoint deletion.

Scheduled jobs already run non-persistent sessions on both adapters and are
out of scope. The runner is channel-neutral, so this applies to every channel
that holds a persistent interactive session, not only Slack.

Discovery: read-only Codex run `task-mttrhe3o-xh5mh1` (2026-09-09), plus the
Claude-adapter trace in `apps/core/src/runtime/group-agent-runner.ts`,
`apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop-phases-setup.ts`
and `apps/core/src/adapters/storage/postgres/repositories/canonical-session-repository.postgres.ts`.

Grill resolutions (spec gate, 2026-09-09), four rounds:
- Keep 0089 and 0078 unchanged; contain growth with a session-size ceiling
  only (a delta snapshot on resume is parked).
- MINIMAL scope: the ceiling uses per-run usage the adapters already report,
  corrected for provider cache semantics (round 4 showed
  `totalBillableInputTokens` subtracts cache reads and would never catch the
  270k case). No per-request seam, no model-capacity clause, no retry system.
- This is a **retire-after-observed-crossing** rule, not a hard bound: one
  turn can overshoot the cap before retirement. The title says "retire", not
  "bound", on purpose.
- Threshold is one global revisioned runtime setting per decision 0025.
- DeepAgents checkpoint rows are reclaimed by a host-owned cleanup on the
  named expiry paths only; orphans are an operator procedure.
- Pre-existing sessions are retired by a manual pre-deploy reset run by the
  deployment owner (decisions 0003 and 0112): no shipped command, no lazy
  retirement, and a deployment stop condition.
- Observability is two named runtime events plus an operator-only query with
  hashed identifiers.
- Roadmap card: the acceptance criteria captured on `cache-bug` at intake
  predate grill convergence. The harness does not edit an active card's
  criteria, so once confirmed and linked, THIS spec is the story's authority
  and those intake criteria are superseded by the acceptance criteria below.

## Behaviour

1. **Model-visible input per run.** The host derives
   `modelVisibleInputTokens` from the existing normalised usage of a run:
   - providers whose cache-read field is additive to the input count
     (Anthropic: `input_tokens` + `cache_read_input_tokens` +
     `cache_creation_input_tokens`): `inputTokens + cacheReadTokens +
     cacheWriteTokens`;
   - providers whose cached tokens are a subset of the input count
     (OpenAI-compatible: `prompt_tokens_details.cached_tokens` ⊆
     `prompt_tokens`): `inputTokens`;
   - providers without cache accounting: `inputTokens`.
   The provider registry entry that already names the cache usage fields
   gains one boolean, `cacheReadsIncludedInInput`, so the host never guesses.
   Because the Claude normaliser aggregates a run's model calls, the figure
   is per run, which over-approximates a single call's context; that is
   accepted for a retirement trigger. The billing fields and
   `totalBillableInputTokens` are unchanged.
2. **Per-session high-water mark, atomic and fenced.** A new repository
   operation `raiseProviderSessionContextHighWaterMark({ providerSessionId,
   agentSessionId, agentSessionResetAt, value })` performs one SQL update on
   the row matching that id, that agent session ownership, and a resumable
   status, setting `metadata_json.contextHighWaterMark` to
   `GREATEST(existing, value)` with `jsonb_set` so other metadata is
   preserved, and returns whether a row was updated. A non-integer or
   negative `value` is rejected before SQL; a missing existing key is treated
   as 0. It is called after any run (including an errored run) whose output
   carries a usage report; runs without usage do not call it. The turn
   context projection returns `contextHighWaterMark` alongside the existing
   provider-session fields.
3. **Retire on resume when over the cap.** Before resuming, if the projected
   high-water mark exceeds the cap, the host retires the session via
   behaviour 5 and starts a fresh session from the ordinary bounded briefing.
   The user-facing turn still completes. Sessions at or under the cap, and
   sessions with no stored mark, resume exactly as today. The preflight adds
   no hydration beyond what 0078 already specifies. Allowed overshoot: the
   one run that first exceeds the cap; a test pins that the *next* resume
   retires it.
4. **Cap setting.** Canonical desired-state path
   `limits.provider_session_max_input_tokens` (global; sibling of the existing
   `limits.providers.<id>.requests_per_minute`), parsed by the limits parser,
   validated as an integer in 20,000–900,000 with default 150,000 when
   absent, rendered by the existing settings exporter, importable and
   exportable through the same YAML/control-API surfaces as the rest of
   `limits`, distributed through `settings_revisions`. A worker applies the
   revision it currently holds; a lowered value takes effect on the next
   resume evaluated by a worker that has loaded that revision (0025 skew
   contract). No environment variable, no per-agent override.
5. **Atomic retirement returning the retired reference.**
   `expireProviderSession` (and the ceiling path that calls it) becomes one
   atomic resumable→expired transition, fenced by agent-session ownership,
   returning the retired `{ providerSessionId, externalSessionId,
   executionProviderId }` or nothing if no row transitioned. Covered
   expiry paths: ceiling (new), missing-session, access-fingerprint change.
   `/new` is covered too: its deletion first selects the scoped
   provider-session references it is about to delete and hands them to
   cleanup. Explicitly NOT covered (retention stated): normal handle
   replacement, which deletes the prior row without cleanup — for DeepAgents
   the thread id is stable across runs so replacement is rare; agent and
   workspace removal cascades; compaction failure and cancellation paths,
   which today reactivate the session and promise continuity to the user and
   keep doing so. Orphans from the uncovered paths are the operator
   procedure in behaviour 7.
6. **Host-owned DeepAgents checkpoint cleanup.** A host service (not an
   adapter method) receives the retired reference from behaviour 5; when
   `executionProviderId` is DeepAgents it deletes that exact thread's rows
   from `checkpoints`, `checkpoint_blobs` and `checkpoint_writes` using the
   host's runtime Postgres storage and the adapter's exported schema
   derivation (`deepAgentsCheckpointSchema(postgresSchema)`, the same one
   `prepare()` uses). It runs only from a non-empty retirement result, is
   idempotent, runs after the reply path is unblocked, and on failure emits
   the cleanup-failed event of behaviour 9 and leaves the session expired.
   For every other provider it is a no-op.
7. **Briefing, jobs, and operator procedures.** Every turn still receives
   the memory block and channel/thread snapshot exactly as 0089 and 0078
   require. Scheduled jobs are untouched. `docs/memory/` records:
   (a) the deployment owner's pre-deploy reset — drain live traffic, stop
   workers, delete all resumable `provider_sessions` rows for interactive
   scopes and truncate the DeepAgents checkpoint tables, verify zero
   resumable rows, and only then deploy; deploying with resumable rows
   present is a stop condition because those sessions carry no mark and will
   resume normally; (b) the orphan reclamation procedure driven by
   cleanup-failed events and the uncovered paths in behaviour 5.
8. **Observability events.** Two registered runtime event types:
   `session.provider.retired` (payload: `reason` ∈ {ceiling, missing,
   fingerprint, new}, `providerSessionHash`, `executionProviderId`,
   `contextHighWaterMark`, `cap`, `scopeKeyHash`) emitted at preflight before
   any run row exists, and `session.provider.cleanup_failed` (payload:
   `providerSessionHash`, `executionProviderId`, `error`). Hashes are the
   first 16 hex characters of SHA-256 over the raw identifier; the same
   function serves the query below. Events are correlated by
   `providerSessionHash` plus `agentSessionId`.
9. **Observability recipe.** An operator-only read-only SQL recipe in
   `docs/memory/`: per provider session (hashed), the stored mark and the
   per-run `model.usage` series via `agent_runs` LEFT JOIN `runtime_events`
   ordered by `agent_runs.started_at`, unioned with `session.provider.retired`
   events by hash; plus DeepAgents checkpoint-table row counts per hashed
   thread id in the derived checkpoint schema.

## Acceptance criteria

1. Unit tests: `modelVisibleInputTokens` for an Anthropic usage of 1,000
   input / 270,000 cache read / 500 cache write is 271,500; for an
   OpenAI-compatible usage of 1,000 input / 800 cached is 1,000; billing
   fields unchanged.
2. Repository tests (Postgres): the raise operation keeps the larger value,
   preserves other metadata keys, rejects a stale owner, ignores non-resumable
   rows, rejects invalid values before SQL, and reports whether a row changed.
3. Unit tests (host): a usage-bearing errored run raises the mark; a run
   with no usage does not call the operation.
4. Unit test: a session with a mark over the cap is not passed as the resume
   id; retirement returns the reference; the run proceeds without resume; the
   replacement handle is persisted; the reply is delivered. A session whose
   run crosses the cap is retired on the following resume, not mid-run.
5. Unit test: a session at or under the cap, or with no mark, resumes and
   still carries the memory block and snapshot. Existing tests pinning that
   (`group-processing.test.ts` "passes hydrated memory context with provider
   session resume id", `agent-runner-ipc.test.ts` live-turn persist/resume,
   `claude-agent-sdk-boundary.integration.test.ts` memory+prompt user
   message, `deepagents-memory-context.test.ts`) stay green and untouched.
6. Settings tests: `limits.provider_session_max_input_tokens` parses,
   defaults to 150,000 when absent, rejects values outside 20,000–900,000
   with a path-level error, round-trips through export, and is applied from
   a new revision by a worker that loads it.
7. Postgres integration test (DeepAgents, using the existing
   `deepagents-checkpoint.postgres.integration.test.ts` harness and its
   isolated schema fixture): for ceiling, missing-session, fingerprint and
   `/new` paths, the retired thread's rows are removed from all three tables
   and other threads' rows remain; a second call is a no-op; a simulated
   deletion failure leaves the session expired, the reply delivered, and a
   `session.provider.cleanup_failed` event recorded; an expiry that does not
   win the transition performs no cleanup.
8. Unit test: `session.provider.retired` is emitted with the specified
   payload before any run row exists and is not dropped by event forwarding.
9. Scheduled-job tests are untouched and green.
10. `verify.py` green.
11. Both operator procedures and the observability recipe exist in
    `docs/memory/`, and the query runs against the current schema.

## Non-goals

- Changing what a turn's briefing contains (0089, 0078) or its limits. A
  delta snapshot on resume is parked: revisit if retirement alone leaves
  turns too expensive.
- A per-model-request context measurement or a model-capacity-aware cap
  (parked; revisit if the per-run figure proves too coarse).
- A hard mid-run bound; this rule retires after an observed crossing.
- Replacing cross-process resume with briefing-only reconstruction.
- Any shipped migration, cleanup, or lazy-retirement behaviour for
  pre-existing state (0003, 0112).
- Cleanup on handle replacement, agent/workspace removal cascades, or
  compaction failure paths; and any durable cleanup retry system.
- Fixing the DeepAgents usage normaliser's largest-not-summed billing
  accounting (separate defect; recorded as a deferral).


## What to return

Findings only: contradictions, gaps, unstated assumptions, and anything a reader would have to guess. Say what would break and why. Do not record a gate — the coordinating session records it.

The round count below is a FLOOR, not a target. Keep grilling until a round comes back clean AND stays clean on the next one — hitting the floor is not the same as passing.
