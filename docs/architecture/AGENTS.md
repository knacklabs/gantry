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
- For outside-app realtime docs, keep Gantry's public realtime channel as HTTP SSE plus SDK list/wait over durable runtime events. WebSocket may appear only as the outside product backend's own UI fanout choice, not as a Gantry core response protocol.
- Prefer `Conversation` plus optional `Thread/Topic` over generic `Channel` unless referring to provider-native Slack/Teams channel names. Memory is app/agent/subject scoped and jobs use `execution_context` plus `notification_routes`.
- Identity docs must use the public noun `person` and public field `personId`.
  The existing `users` and `user_aliases` table names are implementation
  details until an explicit schema rename task changes them.
