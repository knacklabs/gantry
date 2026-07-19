# Goal: Model management — unify first, then UX

**Status: PROPOSED (2026-07-19) — queue position awaiting user decision.**
Written up from the model/provider UX analysis so the scope survives context
loss. Implementation via gantry-goal-pipeline with a Codex plan-validation pass
before stage 1.

## Why

Model selection is spread across ~7 knobs with more than one resolver reading
them, so every UX feature (switching model in chat, seeing what a session cost,
tuning thinking) currently has to understand all of them:

1. `agent.defaultModel` (settings)
2. Job-level default models (two: scheduler job default + async-task default)
3. Memory models (three: embedding, query, consolidation)
4. Per-install `installed_agents.*` model overrides
5. `autoMode.model` (permission classifier)
6. Model families / aliases (provider-account resolution)
7. Per-turn thinking level (exists only as SDK plumbing, no user knob)

Multiple resolution code paths re-implement the precedence chain. This is
pattern family 1 (same fact, multiple lifecycles) applied to configuration:
the "which model runs this turn" fact has N readers each with its own merge.

## Stage A — Unification (the enabler, do first)

- ONE model-resolution service: input = (app, agent, install, purpose:
  turn|job|memory-embed|memory-query|memory-consolidate|classifier), output =
  concrete model + provider account. One precedence chain, documented in the
  service, all current call sites route through it.
- Settings shape stays; only the READ side unifies. No knob removal in Stage A
  (knob simplification falls out later if the service shows some knobs unread).
- Invariant tests: precedence fixtures per purpose; a settings round-trip per
  knob proving the service is the only reader (grep-proof: no other call site
  parses model settings directly).

## Stage B — UX (cheap once Stage A lands)

1. **One models view**: CLI/API surface showing effective model per purpose for
   the current conversation/agent, with the source knob for each (why this
   model).
2. **Session stats**: tokens/cost per session surfaced in chat on request —
   reads the EXISTING OTel gen_ai spans/usage data; fold in
   `status-cost-cache-visibility-goal-prompt.md` rather than running it
   separately.
3. **Model switching in chat**: "use opus for this" / "switch back" — rides the
   V3 phrase→reviewed-settings-flow seam from the conversation-quality cycle
   (canonical revision write on the install override; no new machinery).
4. **Per-turn thinking hint**: "think harder on this one" — new SMALL knob:
   per-turn thinking level passed through spawn options; no persistence beyond
   the turn unless the user asks to make it the default (then it is a normal
   settings revision via the same seam).

## Non-goals

- No provider onboarding changes (covered by
  `multi-agent-provider-onboarding-goal-prompt.md`).
- No pricing tables in the runtime (cost math stays server-side in the OTel
  backend; session stats display token counts + backend-computed cost when
  available).
- No new persistence for stats (OTel data is the source).

## Verification

Stage A: full unit + the precedence fixture matrix; grep-proof single-reader.
Stage B: per-feature focused tests; V3-seam tests extended for the model-switch
phrases; manual smoke on Telegram for stats + switch + thinking hint.
