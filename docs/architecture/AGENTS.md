# Architecture Docs

## Business-Owner Documentation Rules

- Keep `components.md` as an informational architecture overview for technical business owners. Do not turn it back into an image-generation workspace.
- Do not add visual source links, media-generation instructions, generated media paths, or rendering instructions to `components.md`.
- Preserve Gantry boundary names: human chat surfaces use channel adapters, backend apps use `@gantry/sdk` or the control API, signed inbound systems use `/v1/ingresses`, and outbound callbacks use webhooks.
- Use current security terms: `sender policy`, `control approvers`, `Allow once`, `Always allow <granular rule>`, and `Cancel`. Only scheduler job extra-tool reviews should use `Store on this job`.
- Do not describe SSE, outbound webhooks, and external ingress as three response channels. SSE and webhooks are outbound delivery/observation paths; external ingress is inbound signed authority governed by target policy.
- Do not narrow SDK or ingress docs to chat and jobs only. They also support scoped application action requests, where the agent may act through approved capabilities such as app APIs, databases, browser tools, CRM tools, or MCP connectors.
- Do not imply that a message, SDK call, or ingress request grants tool access. Tool access comes only from selected capabilities and policy; the request describes work to attempt.
- When describing Browser for business owners, say it is a policy-gated capability with host-managed persistent profiles scoped by agent/conversation/thread/job context. Do not imply agents can pick arbitrary profile folders, see raw credentials, or attach to unmanaged customer browsers.
- Permission docs must keep the current host decision order explicit: hard deny,
  locked preset, fixed-image restriction, reviewed agent authority,
  deterministic rails, optional cached classifier allow, optional risk
  classifier, then durable human approval. Do not present cache/classifier as
  universal stages on lanes that do not supply them.
- Keep permission scopes distinct. Classifier cache is parent-conversation
  scoped and shared by its threads; only cached classifier allows are reused.
  Human `Allow once` is never reusable, while learned trusted roots and
  `Allow for future` rules are agent-owned durable authority mirrored through
  the settings path.
- `direct` has no inner Claude SDK or Gantry OS sandbox. Describe host
  permission/credential rails and the deployment boundary as its controls.
  Describe `sandbox_runtime` as optional outer whole-runner confinement, not as
  a prerequisite for fleet or production.
- For outside-app realtime docs, keep Gantry's public realtime channel as HTTP SSE plus SDK list/wait over durable runtime events. WebSocket may appear only as the outside product backend's own UI fanout choice, not as a Gantry core response protocol.
- Prefer `Conversation` plus optional `Thread/Topic` over generic `Channel` unless referring to provider-native Slack/Teams channel names. Memory is app/agent/subject scoped and jobs use `execution_context` plus `notification_routes`.
- Identity docs must use the public noun `person` and public field `personId`.
  The existing `users` and `user_aliases` table names are implementation
  details until an explicit schema rename task changes them.
