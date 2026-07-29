---
status: accepted
confirmed_by: "vrknetha"
date: 2026-04-30
---

# 2026-04-30 - External Ingress vs Outbound Webhooks

## Context

Sidecar systems need to push work into Gantry without holding a control API key.
The existing `/v1/webhooks` surface already means host-owned outbound callback
delivery for runtime events.

## Decision

1. External ingress is a separate inbound authority surface under
   `/v1/ingresses`.
2. Signed ingress requests derive `appId` from the ingress record.
3. Request-body `appId` is optional and only an assertion; mismatches fail.
4. Ingress HMAC-SHA256 covers method, path, timestamp, nonce, body hash, and raw
   body.
5. Nonces and invocations are durable Postgres records so replay and duplicate
   active invocation checks survive restart.
6. Ingress records are scoped capabilities. Their target policy is default-deny
   and must explicitly allow target kinds plus concrete sessions,
   conversations, jobs, or templates.
7. `/v1/webhooks` remains outbound callback registration, retry, dead-letter,
   replay, and purge only.
8. Job-template ingress uses Gantry-owned templates. Callers supply variables and
   metadata, not arbitrary prompt, model, or schedule.

## Consequences

- Sidecar examples omit `appId`; API keys and ingress records own scope.
- External ingress and outbound webhooks can use similar HMAC mechanics without
  sharing authority or route names.
- Cleanup searches should treat old webhook-as-ingress wording as stale active
  guidance unless it appears in this decision as historical context.
