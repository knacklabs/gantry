---
status: proposed
confirmed_by: ""
date: 2026-08-26
stories: [SOV-1]
---

# One constrained openai_compatible model provider (amends 0135)

## Context

Model providers are registry-derived and fail closed; decision 0135 explicitly
excludes custom providers from the browser credential façade. The positioning
"self-hosted, any model" and the sovereign-mode capability require running
against on-prem OpenAI-compatible servers (vLLM, Ollama, LM Studio), which have
no fixed upstream origin. Bedrock and Vertex exist but are cloud-sovereign, not
on-prem.

## Decision

Add exactly one generic provider id, `openai_compatible`, whose upstream origin is
operator-supplied and validated (scheme, host, no credentials in URL), with a
credential mode via secret reference. It participates in the catalog, aliases,
routing, verification, and the browser façade like a registered provider.
Decision 0135's exclusion is narrowed to "no arbitrary custom providers";
this single constrained kind is the only exception.

## Consequences

- URL validation and allowlist interaction (EGRESS-1) are part of the provider
  contract; the provider cannot bypass the egress policy.
- No per-model price table; usage stays token-based.
- Further generic kinds (e.g. Anthropic-compatible) need their own decision.
