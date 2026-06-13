# Boondi Support Agent

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
- Keep `boondi-crm.get_open_records` reserved for bare returning greetings.
  Substantive order, product, and gifting turns should use the Shopify path and
  rely on background extraction for buying-interest capture.
- Boondi guardrails must not rely on a separate classifier LLM in the default
  path. Use deterministic pre-agent screening plus the inline scope block in the
  main Boondi payload. Pre-agent deterministic replies should stay limited to
  hard known cases such as a bare greeting, empty clarification, or off-topic /
  internal-prompt rejection.
