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
- When driving Boondi scenario webhooks for admin-panel review, configure
  `runtime.runner.idle_timeout_ms` in `settings.yaml` to a short value such as
  `2500`. The production default keeps warm LLM sessions open for 30 minutes
  and can fill the message queue's active-run slots, making later fake-phone
  chats appear unanswered.
- For live-flow tool-routing regressions, use `mcpMustNotCall` in
  `scripts/boondi-scenarios.json` to forbid a specific MCP `serverName` /
  `toolName` pair. The regression runner enforces it from `flow:mcp.request`
  events.
- Use `mcpMustCall` to require a specific MCP `serverName` / `toolName` pair
  when a scenario must prove routing to a newly introduced aggregate tool.
- Use `mcpMaxCallCount` when a regression needs to cap a repeated tool call,
  such as keeping `shopify-api.search_products` fanout to one targeted call for
  qualified gifting flows.
- For local server readiness, prefer `npm run dev:boondi-runtime` in one
  terminal and the exact `Next:` smoke command it prints in another over the
  full scenario runner. This proves signed webhook ACK, guardrail entry, MCP
  proxy request/response for `shopify-api` and `boondi-crm`, and outbound
  dry-run without judging Boondi CRM/Shopify behavior semantics. The stack
  writes a 0600 `GANTRY_RUNTIME_SMOKE_ENV` sidecar with a short-lived local
  control token; the smoke must use it to verify authenticated runtime worker
  inventory. The smoke should also resend the same provider message id and fail
  if that duplicate produces another guardrail, MCP, or outbound event for the
  chat.
- Local runtime stack child processes must strip wrong-lane raw model
  credentials from the inherited environment, including `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, and
  `OPENAI_API_KEY`. Gantry model credentials belong in the credential lanes, not
  in ambient process env.
- When building local smoke control-key JSON with `node -e`, pass generated
  bearer tokens through an environment variable, not a positional argument. A
  base64url token can start with `-`, and Node will parse that as an option.
- When `scripts/boondi-runtime-smoke.mjs` runs with `SMOKE_CONCURRENCY`, log
  matching must stay scoped to parsed JSON flow records for the same chat JID.
  Loose substring checks can mix events from different fake phones and send the
  duplicate probe before the first turn for that chat has actually finished.
- For local multi-core runtime-plumbing checks, use
  `GANTRY_CORE_COUNT=2 npm run dev:boondi-runtime`. The stack must give each
  Gantry core a distinct control port, log, smoke env file, and
  `GANTRY_IPC_SOCKET_PATH`; otherwise the shared runtime-home IPC socket
  election hides the second core's runner path and makes the smoke misleading.
- Keep `scripts/boondi-test-setup.sh` warning against anything other than
  `BOONDI_TEST_IDLE_TIMEOUT_MS=2500` for broad scenario suites, but raise both
  that variable and `runtime.runner.idle_timeout_ms`, for example to `20000`,
  when measuring warm-follow-up retention. The short suite default intentionally
  frees active-run slots and will force delayed follow-ups onto SDK-session
  resume instead of the live `MessageStream` path.
