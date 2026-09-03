---
slug: web-providers-2-credential-setup
title: Correct registry-driven credential setup
status: draft
saved: 2026-09-03T10:52:01+00:00
---

# Correct registry-driven credential setup

## Why

The shared Model Providers dialog silently selects the first authentication
method. This hides supported alternatives such as Amazon Bedrock API keys,
submits blank fields during credential rotation, and describes Gantry's local
credential projection check as upstream verification.

## Behaviour

- Multi-method providers require an explicit authentication-method selection
  during first setup. Single-method providers keep the compact form without a
  selector.
- Authentication method labels, help text, field labels, required state, and
  multiline presentation come from the executable provider registry.
- Editing the current method sends only non-empty fields so omitted stored
  values remain unchanged. Re-enabling a disabled provider follows the same
  partial-update rule.
- Changing authentication method warns that the stored credential will be
  replaced, requires a complete new payload, and atomically replaces it through
  the existing set operation.
- Stored field names may be shown, but stored secret values remain write-only
  and never return to the browser.
- The existing provider preflight action is presented as a Gantry configuration
  check. It does not claim to contact or authenticate against the upstream
  provider.

## Provider coverage

- Anthropic: API key and Claude Code OAuth.
- Amazon Bedrock: AWS default credential chain, AWS Secrets Manager reference,
  and Bedrock API key.
- Google Vertex AI: Google ADC, service-account reference, and service-account
  JSON. The JSON field uses a visible native textarea while being entered.
- OpenRouter, OpenAI, Groq, DeepSeek, xAI, Together AI, Fireworks AI, Cerebras,
  Perplexity, and Gemini retain their single API-key form.

## Non-goals

- No provider-specific form components, new endpoint, provider SDK, network
  probe, background check, or browser-readable secret API.
- No changes to model selection, provider execution, credential encryption,
  settings, persistence schema, CLI, or Gantry MCP tools.

## Acceptance criteria

- First setup for every multi-method provider shows no credential fields until
  the administrator explicitly selects a method; all registry-declared methods,
  help text, fields, and required state render correctly.
- Same-method edits and re-enables use sparse `PATCH` payloads, while method
  changes require all new fields and use complete `PUT` payloads with the new
  `authMode`.
- Switching methods or closing the dialog clears unsaved values. Stored secret
  values never enter browser responses or client state.
- Vertex service-account JSON renders as a textarea using registry metadata;
  other secret fields retain password inputs.
- The action and feedback say `Check configuration` and describe only Gantry
  credential availability, never upstream access.
- Registry, request-construction, UI smoke, typecheck, architecture, and local
  functional checks pass without real credentials or upstream calls.
