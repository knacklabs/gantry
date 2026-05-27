# Guardrail Application Notes

- Guardrails make pre-agent routing decisions only. They must not expose
  classifier text directly to customers.
- Keep business-specific rules, prompts, and fixed customer copy inside policy
  implementations under `policies/`. Runtime integrations should depend only
  on configured policy ids and response kinds.
- Do not hard-code agent folder names in guardrail enforcement. Agent selection
  happens in settings and route projection.
- Classifier adapters must return structured decisions only. Customer-visible
  text is always selected by the policy implementation from `responseKind`.
