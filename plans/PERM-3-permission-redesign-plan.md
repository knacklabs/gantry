# PERM-3 — Permission redesign implementation (F1–F5) plan

## Problem
The permission engine (PERM-2 coordinator, now on main) over-asks the human for
benign actions and its saved grants silently fail to match. Live-log field audit
(goal doc `docs/architecture/permission-engine-redesign-goal-prompt.md`): 285 asks,
198 to a human, only 44 to the classifier; the agent has 38 saved `RunCommand(...)`
rules and matched **0**. Root cause (F1): a ~740-char host env-prefix injected into
every shell command + a 500-char input truncation blind all four decision layers
(rails, classifier, effect-key cache, reviewed-rule matcher) at once, so ordinary
commands are treated as "incomplete input → ask". Secondary: benign first-party
tools have no birthright (F4); an unresolved capability poisons unrelated tools
(F3); the classifier conflates risk with authorization (F5).

## Scope / Non-goals
In scope: F1 real-command decision view; F4 birthright + known-safe catalog; F3
capability resolution; F5 risk-only classifier with engine-owned authorization +
codex calibration lines. Per-conversation cache/grant scoping (threads inherit).
Non-goals (deferred, non-blocking): the agent-global risk cache (leaner target —
add only if latency demands); SANDBOX-1 escape-as-new-action; connectors/OAuth;
the fuller two-factor LLM schema (superseded by risk-only). No change to
`sandbox_runtime` confinement. No new persisted exact-command rules (deprecated).

## Acceptance Criteria
1. Ordinary shell commands (incl. the host-env-prefixed render `RunCommand`s) are
   NOT marked "incomplete input"; rails/classifier/effect-key/reviewed-rule matcher
   evaluate the real, prefix-stripped command. (F1)
2. A saved capability grant auto-authorizes its bundled action with no prompt, and
   an unresolved capability rule is skipped (logged once) and never converts
   another tool's decision to a human ask. (F3)
3. Benign first-party gantry-MCP (send_message, todo_update, render_progress,
   scheduler READS) and rung-0 known-safe shell reads never prompt. (F4)
4. The classifier returns `risk_level` only; the engine derives allow/ask from risk
   + authorization it already holds. With an EMPTY cache and NO saved rules, a
   fresh ordinary-work conversation reaches the human only a handful of times. (F5)
5. Cache/grants key on conversationId; threads inherit their parent conversation.
6. `python3 .agents/scripts/verify.py` green; existing permission unit + postgres
   suites green; no test deleted for convenience.

## Technical Approach
**F1 (first — unblocks 2/3/4). Simplest shape (grill-reduced):** In
`ipc-parsing.ts`, strip the host env-prefix (`stripHostInjectedEnvPrefix`) from
shell command fields BEFORE sanitizing. Once the ~740-char prefix is gone, ordinary
commands fit well under 500 chars, so the existing 500-char `toolInput` that rails +
effect-key already consume now carries the REAL command — no re-plumbing to the 16k
view needed. Then refine `inputIsIncomplete` (shared by rails + effect-key) to fire
only on genuine absence or actual TRUNCATION of the command (use the existing
`toolInputTruncatedPaths`), NOT on sensitive-key redaction or 500-char display
alteration — redaction replaces secret values, not the risk-relevant verbs/paths.
Rejected (deferred to open-items): routing rails/effect-key to the 16k
`classifierToolInput`. It's only needed for a genuinely long (>500-char
post-strip) command, which is rare and degrades SAFELY to ASK today; adding the
plumbing now is speculative. Keep `toolInput` = 500-char display. Non-shell tools:
a redacted/altered display field must not block the read-only evaluation.

**F4.** Extend the rung-0 read-only fast-path with the codex `is_safe_command`
known-safe catalog and a first-party benign gantry-MCP allow-set (send_message,
todo_update, render_progress, scheduler_list_*/get_job); scheduler mutations stay
gated. These short-circuit to allow before sanitization can trip.

**F3.** Plumb `semanticCapabilityDefinitions` (already parsed at `ipc-parsing.ts`)
to the policy service; resolve a granted capability to its source-typed bundle
(commandRules / reviewed MCP tools / facade rules / adapter + hosts + credentialDirs)
so it auto-authorizes; an unresolvable capability rule is skipped (log once) and
never fails the whole match.

**F5.** Change the classifier verdict to `risk_level` (low/med/high/critical) +
rationale only; the coordinator derives the outcome from risk + authorization it
holds (conversation grant / admin / capability / trusted root): low/med → allow;
high → allow iff authorized else ASK; critical → ASK (or rail hard-deny). Import
codex RISK calibration lines verbatim (outside-workspace ≠ high; sandbox-retry ≠
suspicious; benign local FS = low; scoped user-requested `rm -rf` = low/med).
Cache the risk verdict per-conversation.

## Decisions
- `docs/decisions/0042-decision-view-16k-prefix-stripped.md` — the decision path
  (rails/effect-key/classifier) consumes a prefix-stripped 16k command view;
  `toolInput` stays 500-char display-only. (Rejected: raise `toolInput` to 16k
  everywhere — bloats mobile receipts/logs.)
- `docs/decisions/0043-classifier-risk-only-engine-authz.md` — classifier returns
  risk only; engine owns authorization deterministically. (Supersedes the
  two-factor LLM schema in the goal doc's fuller text.)
- Everything else derives from the accepted goal doc + existing decision records
  (0040 two-axis, capabilities framing, cache scoping, birthright, requester/approver).

## Surface Impact
| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | fewer human asks; real-command decisioning; risk-only classifier |
| API | Unchanged by design | no control-route/contract change; internal request fields only |
| Data/schema | Changed | decision-memory cache keyed by conversationId (per-conversation) |
| CLI/ops | Unchanged by design | no CLI surface change |
| UI | Changed | prompt shows real command + risk + conditional "allow for future" |
| Docs | Changed | goal doc already on main; add decisions 0042/0043 |
| Tests | Changed | update incomplete-input/classifier suites to real-command behavior; add F1/F3/F4/F5 tests |

## Task Decomposition (bounded, capability-driven, disjoint scope)
- **T-F1** — real-command decision view: prefix-strip at ipc-parse + rails/effect-key
  consume 16k view + `inputIsIncomplete` refinement + tests. → verify: AC-1, AC-6.
- **T-F4** — birthright known-safe catalog + first-party benign MCP allow-set + tests.
  → verify: AC-3.
- **T-F3** — capability→bundle resolution + skip-unknown/no-poison + tests. → verify: AC-2.
- **T-F5** — risk-only classifier verdict + engine-owned authorization derivation +
  calibration lines + per-conversation risk cache + tests. → verify: AC-4, AC-5.
T-F1 lands first (unblocks the others); F4/F3 are independent; F5 last (depends on F1).

## Risks
- Under-stripping/over-stripping the host prefix → a real command mis-normalized.
  Mitigation: `stripHostInjectedEnvPrefix` is value-validated (loopback proxies,
  `netdns=go`, trusted CA paths only); pin with a byte-equality test.
- Relaxing `inputIsIncomplete` could let a truncated shell command through.
  Mitigation: keep truncation→incomplete for the 16k command; only redaction/display
  truncation is relaxed; test the destructive-past-16k case still asks.
- Risk-only classifier + engine authz must not weaken high/critical gating.
  Mitigation: high/critical never auto-allows without held authorization; test.
- Capability resolution must be source-type-agnostic. Mitigation: test each source type.

## Verify Plan
```bash
npm run typecheck
npm run test:unit        # focused permission suites per task; full at closeout
python3 .agents/scripts/verify.py
```
Per-task: the implementer writes + records the tests. Closeout: full `npm test` +
postgres integration + a fresh-empty-cache conversation reaching the human only a
handful of times (AC-4 smoke).
