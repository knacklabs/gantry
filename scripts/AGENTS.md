# Scripts

- Boondi regression phone numbers must stay fake unless the number is explicitly
  supplied by the operator in `GANTRY_TEST_OPERATOR_PHONE`.
- Do not use broad unlisted-phone bypasses for signed webhook replay. The safe
  test sender set is the checked-in fake numbers plus the runtime operator
  allowlist.
- CRM lifecycle regressions should send `/digest-session` and
  `/extract-leads-queries` through the signed
  webhook path, then prove extraction through `boondi_business_records`.
- Boondi scenario runs are also admin-panel review artifacts. Do not send a
  teardown `/new` by default or otherwise clear scenario transcripts after they
  run; rely on the pre-run DB reset for clean fake-phone state.
- When driving Boondi scenario webhooks for admin-panel review, start the dev
  runtime with a short `IDLE_TIMEOUT` such as `2500`. The production default
  keeps warm LLM sessions open for 30 minutes and can fill the message queue's
  active-run slots, making later fake-phone chats appear unanswered.
- For live-flow tool-routing regressions, use `mcpMustNotCall` in
  `scripts/boondi-scenarios.json` to forbid a specific MCP `serverName` /
  `toolName` pair. The regression runner enforces it from `flow:mcp.request`
  events.
- Use `mcpMustCall` to require a specific MCP `serverName` / `toolName` pair
  when a scenario must prove routing to a newly introduced aggregate tool.
- Use `mcpMaxCallCount` when a regression needs to cap a repeated tool call,
  such as keeping `shopify-api.search_products` fanout to one targeted call for
  qualified gifting flows.
- Keep `scripts/boondi-test-setup.sh` defaulted to a short
  `BOONDI_TEST_IDLE_TIMEOUT_MS=2500` for broad scenario suites, but raise it
  explicitly, for example to `20000`, when measuring warm-follow-up retention.
  The short suite default intentionally frees active-run slots and will force
  delayed follow-ups onto SDK-session resume instead of the live `MessageStream`
  path.
