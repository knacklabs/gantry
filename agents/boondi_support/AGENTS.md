# Boondi Support Agent

- For meaningful architecture, runtime, prompt, MCP, agent, or customer-facing
  behavior plans, first use
  `agents/boondi_support/docs/plan-guiding-template.md` and cover its sections
  unless a section is clearly not applicable. Do not assume full live regression;
  ask whether the plan needs full live testing or minimal focused live testing.
- Do not shrink or delete `SOUL.md` or `CLAUDE.md` as part of latency work
  unless the task is explicitly a prompt-shrink/regression project.
- For qualified corporate or bulk gifting turns that also ask for product
  suggestions, steer Boondi to make at most one targeted `search_products` call.
  If that result is empty or partial, stop searching and route the brief to the
  gifting team instead of trying broad query fanout.
- When a qualified gifting turn asks for latest-order context and product
  suggestions together, steer Boondi to `shopify-api.get_gifting_context` as the
  single Shopify call instead of separate order and product-search calls.
- Treat Shopify tool output as structured source data, not a customer answer.
  Boondi must compose the final WhatsApp reply in its own voice after the
  deterministic guardrail has allowed the turn.
- If a Shopify tool returns `customerReplyDraft`, `answerGuidance`, or
  `replyContract.useCustomerReplyDraft`, keep those fields first in the tool
  payload and tell Boondi to adapt them directly. This is the stable way to
  avoid fallback hiccup text and lookup narration under warm-pool load.
- Use `boondi-crm.get_last_query_or_lead({})` as the compact returning-customer
  default when CRM context is needed before a greeting. Use
  `boondi-crm.get_open_records` only when the live turn genuinely needs every
  active opportunity. Substantive order, product, and gifting turns should use
  the Shopify path and rely on background extraction for buying-interest
  capture.
- Explicit phone/email/order lookups that are not clearly for someone else must
  reach the Shopify MCP first; do not let Boondi pre-deny them in the prompt.
  The MCP privacy guard owns the allow/deny decision.
- For bare returning greetings, if verified CRM pre-run context or
  `boondi-crm.get_last_query_or_lead({})` returns an active record, the reply
  must include one concrete returned detail instead of a generic welcome.
- Boondi guardrails must not rely on a separate classifier LLM. Boondi is
  configured `mode: deterministic` + `unresolved: inline`: deterministic
  pre-agent screening plus the inline scope block in the main Boondi payload for
  turns the deterministic stage does not resolve (the inline block is attached
  because `unresolved: inline`, not because the policy exports it). Pre-agent
  deterministic replies should stay limited to hard known cases such as a bare
  greeting, empty clarification, or off-topic / internal-prompt rejection.
- Channel payloads can provide verified customer identity such as name and
  phone; Boondi prompts should use the message sender/customer name naturally,
  including dev labels, and must not ask customers to repeat name or phone for
  gifting handoffs when verified sender context is already available.
- For any sub-25 gifting conversation, the website/self-serve route comes first.
  Customisation or serviceability questions should not erase that route; mention
  the website path first, then route only feasibility confirmation to the team.
- Keep `SOUL.md` and `CLAUDE.md` generic for Boondi support. Gifting,
  customisation, or campaign behavior may appear only as compact scenario rules;
  these files must not become gift/customisation-specific prompts.
- Do not hard-code customisation examples in prompt files. Say
  `customisation` generically unless the customer used the specific term.
