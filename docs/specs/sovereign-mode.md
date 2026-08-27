---
slug: sovereign-mode
title: Sovereign mode
status: confirmed
saved: 2026-08-27T07:38:53+00:00
---



# Sovereign mode

## Capability

A regulated organisation runs Gantry entirely on its own infrastructure against an
on-prem model, and can prove no component reaches a host it did not allow. "Self-hosted,
any model" is enforced, not advised.

## Why

'Self-hosted, any model' is in the tagline; regulated buyers will test it. Today there is no on-prem provider and egress is a denylist.

## Behaviour

### Model provider

- A constrained `openai_compatible` provider id accepts an operator-supplied base URL
  (vLLM, Ollama, LM Studio) with URL validation and a credential mode via secret
  reference; it participates in the catalog, aliases, and routing like registered
  providers. Decision 0135's exclusion of custom providers is amended for this single
  constrained kind; the browser facade exposes it as a normal provider.
- Quickstart documented with vLLM.

### Egress allowlist

- Policy owned by host bootstrap: when configured, default-deny with an explicit host
  allowlist. Enforcement covers the model gateway, embeddings, browser backend, remote
  MCP proxy, provider SDK telemetry, and both sandboxed and direct runner modes. The
  existing denylist remains for non-sovereign deployments.
- OTLP/tracing export is covered and never carries message content off-box;
  SECURITY states plainly that Gantry never phones home.
- Boot fails with a named violation when any component cannot be constrained to the
  allowlist; there is no advisory mode in sovereign configuration. A doctor probe
  reports the effective policy but is not the enforcement.

## Acceptance criteria

- **EGRESS-1** — Host-owned egress allowlist
  - Allowlist policy owned by host bootstrap; default-deny when configured
  - Enforcement covers model gateway, embeddings, browser backend, remote MCP proxy, telemetry, and both sandbox and direct runner modes
  - Boot fails with a named violation when any component cannot be constrained
  - Read-only effective egress policy surface: /ui/api/runtime/egress-policy (viewer) showing default-deny state, allowlist, protected components, named violations; replaces the preview Diagnostics/Guardrails cards for egress
  - OTLP/tracing export is covered by the allowlist and never carries message content off-box; SECURITY states plainly that Gantry never phones home
- **SOV-1** — Sovereign mode: generic OpenAI-compatible provider and no-egress check
  - ADR 0135 amended: constrained openai_compatible provider id with URL validation, credential mode via secret ref, catalog/route behaviour, gateway tests
  - No-egress boot check is EGRESS-1 enforcement, not a doctor probe
  - Quickstart documented with vLLM
  - openai_compatible appears in the existing Model Providers page and dialog with Base URL + secret reference + verify; no bespoke UI

## Source

Grill 2026-08-26 (Q7, Q13) and gap sweep (egress is denylist/default-allow; direct mode
advisory; remote MCP bypasses the runner proxy). Stories: EGRESS-1, SOV-1.
