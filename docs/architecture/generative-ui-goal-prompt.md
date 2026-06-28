# Goal Prompt: Generative UI Rich Interaction Implementation

You are implementing Gantry rich generative UI. Follow this prompt exactly.

## Operating Mode

- Use the `ponytail` skill everywhere, at full intensity, for every implementation decision.
- Stop at the first solution that works: existing code, native platform feature, already-installed dependency, shortest diff.
- Do not add speculative abstractions, wrapper-only files, broad utility buckets, or new dependencies unless repo evidence proves the existing stack cannot do the job.
- Use implementation subagents for code generation. The parent session coordinates, assigns leaf tasks, verifies, reviews, and closes out.
- During code generation, produce no commentary. Tool/status output only.
- Do not bypass Gantry permission/capability flows, settings authority, channel adapter boundaries, or runtime event contracts.

## Product Goal

Make Gantry responses render as native rich UI across Slack, Telegram, Discord, Teams, and App/Web/API while preserving a provider-neutral Gantry contract.

Implement all v1 rich content:

- status
- facts
- list
- table
- form
- media
- progress

The user experience must feel native in each provider, but authority and meaning must stay Gantry-owned.

## Locked Decisions

- Extend the existing `InteractionDescriptor`; do not create a competing `UISpec` authority.
- Agents emit Gantry rich descriptors through tools; they never emit Slack blocks, Discord embeds, Telegram payloads, Teams cards, or React components directly.
- The host validates every descriptor and renders provider-native payloads.
- Every descriptor must include `fallbackText`.
- If native rendering fails, show exactly:
  `Rich view unavailable in this conversation. Showing text version.`
- App/Web/API is in v1. Emit structured session events so embedded clients can render rich UI instead of receiving flattened text.
- Web may use existing libraries, but only outside the core protocol. Preferred web path: an optional React renderer/example using `assistant-ui` as the chat shell and Gantry-owned components for descriptors. Do not make `assistant-ui`, Vercel AI SDK, AG-UI, CopilotKit, or OpenAI Apps SDK the Gantry wire protocol.
- Teams is included in renderer/test scope, but do not claim installable live Teams runtime unless the current transport/catalog contract supports it and verification proves it.
- Do not expose raw model reasoning. Rich progress and receipts must use authored operational language only.

## Exact UX Copy

- Native render fallback: `Rich view unavailable in this conversation. Showing text version.`
- Form open button: `Open form`
- Form submit button: `Submit`
- Form cancel button: `Cancel`
- Required-field validation: `Complete the required fields before submitting.`
- Form submit receipt: `Submitted by <display name>.`

Provider behavior:

- Slack: Block Kit for cards/lists/tables where practical; free-text and multi-field forms use `Open form` button to modal.
- Discord: classic embeds plus v1 action rows for display/action cards; free-text and multi-field forms use interaction-triggered modal.
- Telegram: HTML text plus inline keyboards; forms degrade to a wizard when one-screen input is not available.
- Teams: Adaptive Cards and `Action.Execute`/`Action.Submit` through the current `TeamsSdkClient` seam.
- App/Web/API: structured runtime/session events carrying descriptors plus fallback text.

## Implementation Scope

Implement the smallest coherent vertical system:

- Add descriptor validation/parsing for the v1 rich kinds.
- Add Gantry MCP tools:
  - `render_status`
  - `render_facts`
  - `render_list`
  - `render_table`
  - `render_form`
  - `render_media`
  - `render_progress`
- Add a signed rich-interaction IPC lane parallel to permission/question IPC.
- Add host-side dispatch from rich IPC requests to channel surfaces.
- Add a `RichInteractionSurface` channel capability and capability-port helper.
- Add provider renderers using existing permission/question/todo/message primitives.
- Add App channel structured event support for rich descriptors.
- Add docs and prompt guidance only where implementation behavior needs it.
- Remove obsolete active paths introduced by the change; do not add compatibility shims for old local state.

## Web Library Guidance

Use existing web libraries only where they reduce code in an optional web renderer package/example.

Preferred:

- `assistant-ui` for React chat/thread shell if a React example is created.
- Gantry-owned React components for `InteractionDescriptor` rendering.

Allowed only as optional adapters/examples:

- Vercel AI SDK / AI Elements
- AG-UI / CopilotKit
- OpenAI Apps SDK

Rejected for core:

- Any library-specific message format as Gantry's durable wire contract.
- Any renderer that requires agents to choose client components directly.

## Task Graph

Use subagents for implementation leaf tasks:

1. Contracts and validation
   - Extend `InteractionDescriptor` minimally.
   - Add rich descriptor validation.
   - Add fallback text enforcement.

2. Runner tools and IPC
   - Register rich render tools.
   - Write signed rich IPC files.
   - Add response waiting only for forms.

3. Host dispatch
   - Parse rich IPC requests.
   - Validate signatures.
   - Route to bound channel rich surface.
   - Emit runtime events for requested, delivered, fallback, and failed.

4. Channel renderers
   - Slack, Telegram, Discord, Teams, and App.
   - Reuse existing builders before adding new code.

5. App/Web/API
   - Emit structured session events for rich descriptors.
   - Preserve ordered envelope sequencing with text/progress/streaming events.
   - Add optional React rendering guidance/example only if it stays small.

6. Prompt/docs
   - Update agent guidance so agents know when to use each render tool.
   - Update architecture docs for the rich descriptor contract.

## Verification

Run focused checks after each slice. At minimum:

- Unit tests for descriptor validation and malformed-spec rejection.
- Unit tests for each provider renderer and exact fallback text.
- IPC tests for signed accepted requests and forged rejected requests.
- Worker-mode test proving rich output does not flatten through `send_message`.
- Form tests:
  - Slack and Discord modals open only after a user interaction.
  - Teams and App/Web render inline.
  - Telegram wizard returns structured answers.
  - Submit receipt uses exact copy.
- App channel tests proving structured events are emitted and ordered with text/progress.

Real Slack acceptance:

- Use the real Slack channel `#gantry-runtime`, where the agent is already added.
- Exercise the feature like a real user in that channel, not with synthetic "test card" or "hello world" copy.
- Use a realistic prompt such as: `Prepare a lead-generation run brief for Knacklabs: show current status, target facts, a prioritized lead list, a qualification form, and next-step progress. Use rich UI where it helps.`
- Verify the actual Slack messages in `#gantry-runtime`:
  - native rich blocks render, not flattened JSON or plain-only fallback
  - the form opens and submits through the real Slack interaction path
  - fallback copy appears only when a native render is intentionally forced to fail
  - the conversation reads like a real workflow, not a harness/demo transcript
- Capture evidence from the channel: message timestamps, visible component types, submit receipt, and any fallback/error copy.

Final gates:

```bash
npm test
npm run build
python3 .codex/scripts/verify.py
```

If Postgres-backed behavior changes, use a disposable Docker Postgres and run the required Postgres integration tests with `GANTRY_TEST_DATABASE_URL`.

## Closeout Sequence

After code generation:

1. Run autoreview.
2. Fix real autoreview findings with the smallest diffs.
3. Run focused checks again.
4. Run final gates.
5. Build and restart local Gantry through launchctl using service label `com.gantry`.
6. Confirm `gantry status`.
7. Run the real Slack acceptance in `#gantry-runtime`.
8. Run the Knacklabs lead gen job from the current local runtime.
9. Capture evidence: tests, build, verify, launchctl/status, Slack acceptance, and Knacklabs job result.
10. Create a PR with:
   - implementation summary
   - tests run
   - autoreview result
   - launchctl/status evidence
   - Slack `#gantry-runtime` real-user evidence
   - Knacklabs lead gen job evidence
   - known follow-ups, if any

## Success Criteria

- Rich output works across Slack, Telegram, Discord, Teams renderer scope, and App/Web/API.
- Slack is verified in the real `#gantry-runtime` channel with realistic workflow copy, not synthetic test strings.
- App/Web/API receives structured descriptors, not flattened text only.
- Provider-native rendering failures degrade to exact fallback copy.
- No raw reasoning is rendered or persisted as user-facing rich output.
- No new core protocol dependency on third-party web UI libraries.
- Final PR is created after verification and runtime/job evidence are collected.
