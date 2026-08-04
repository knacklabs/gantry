# Goal: Model management — unify first, then UX

**Status: FINALIZED 2026-07-19 (user grilling session — all 8 decisions
locked below). Queue position: see goals-index.** Implementation via
gantry-goal-pipeline with a Codex plan-validation pass before stage 1.

## Locked decisions (grilling 2026-07-19)

| #   | Decision         | Choice                                                                                                                                                                                                                      |
| --- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | V1 features      | ALL FOUR: chat switching, session stats, models view, modality+thinking                                                                                                                                                     |
| 2   | Knob strategy    | Collapse aggressively (no old users)                                                                                                                                                                                        |
| 3   | Surviving shape  | `models.default` + sparse `models.overrides.{memory_embed, memory_query, consolidation, classifier, jobs}` + per-install override; `autoMode.model` dies into the classifier override; families/provider accounts unchanged |
| 4   | Switch scope     | Sticky per conversation (canonical install-override revision); "switch back" reverts                                                                                                                                        |
| 5   | Switch authz     | Existing settings-approval gate (switch = request_settings_update revision; no new authz concept)                                                                                                                           |
| 6   | Stats units      | Tokens + cache detail per model from OTel spans; dollar cost stays in the OTel backend                                                                                                                                      |
| 7   | Modality default | Auto-upgrade ON, disclosed in reply; knob to disable; honest refusal when no capable sibling                                                                                                                                |
| 8   | Upgrade rule     | Cheapest capable sibling on the same provider account                                                                                                                                                                       |

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
  concrete model + provider account **+ capabilities**. One precedence chain,
  documented in the service, all current call sites route through it.
- **Capabilities facet** (user question 2026-07-19: "what if user sends an
  image to a text-only model?"): the resolution result carries what the
  resolved model can accept/do — `modalities_in` (text/image/audio/document),
  `tool_use`, context budget. Source: a small built-in map keyed on model-id
  pattern with a per-model settings override; no giant speculative registry.
  This is the inbound mirror of the outbound-attachments incident — today a
  modality mismatch either silently drops the media or surfaces an opaque
  provider 400; both are the silent-failure family.
- Settings shape COLLAPSES per locked decision 3 (aggressive; no old users):
  `models.default` + sparse `models.overrides.*` purpose map + per-install
  override. `agent.defaultModel`, both job defaults, the three memory model
  knobs, and `autoMode.model` are deleted — their values move into the new
  shape. Parser rejects the dead keys loudly (strict unknown-key rule).
- Invariant tests: precedence fixtures per purpose; a settings round-trip per
  surviving knob proving the service is the only reader (grep-proof: no other
  call site parses model settings directly).

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
5. **Modality mismatch handling** (needs the Stage A capabilities facet):
   pre-flight inbound attachments against the resolved model's `modalities_in`
   at turn admission — BEFORE the provider call. On mismatch, deterministic
   ladder: (a) if the install's family has a capable sibling on the same
   provider account and auto-upgrade is enabled, per-turn switch (disclosed in
   the reply, same per-turn override seam as the thinking hint); else (b) honest
   immediate reply naming the limitation and the fix ("I can't view images with
   my current model X — describe it in text, or say 'switch to a vision model'"),
   plus a logger.warn. NEVER a silent drop or a raw provider 400. First audit
   what happens today per channel (Telegram photo/voice, Slack file, Discord,
   Teams) — one read-only pass before building. Transcription/description
   sidecar (routing media through a capable model to feed a text-only agent) is
   explicitly v2 — do not build until asked.

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
