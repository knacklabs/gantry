# Shopify MCP

## Customer-Facing Privacy Denials

- Customer identity and ownership denials must use plain customer-facing wording.
- Do not expose internal guard names, MCP/tool details, signed-header mechanics, admin/back-office instructions, bypass language, or diagnostic identifiers in tool content that can be shown to an end user.
- For customer messaging flows, say that the requested phone number, email, customer, or order does not match the phone number the customer is messaging from.
- Keep internal denial codes and developer diagnostics inside typed errors, logs, and tests; strip them from `customerSafe` tool responses.

## Latency-Sensitive Tool Payloads

- Default live customer-support tools to the smallest payload that answers the common question; require an explicit `limit` or detail lookup for wider history.
- Search/list tools should return compact summaries. Put bulky descriptions, images, tags, and deep detail behind specific detail tools so agent compose rounds do not carry unnecessary catalogue context.
- Keep `get_gifting_context` tolerant of live-model shorthand such as `limit`
  without `productQueries`. Strong qualified gifting briefs without a targeted
  query should not run speculative default product search; Boondi can ask or
  route the brief instead.
- For qualified gifting briefs, keep `get_gifting_context` output compact,
  structured, and customer-safe. Returned fields are source data for Boondi, not
  final customer copy; never include internal MCP, Shopify Admin, identity, or
  diagnostic wording in returned content.
