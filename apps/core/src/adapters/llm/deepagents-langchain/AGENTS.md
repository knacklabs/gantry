# DeepAgents (LangChain) Execution Adapter

`deepagents:langchain` execution adapter + adapter-owned runner. Selected for
agents whose engine is DeepAgents (`agent_engine: deepagents`) on OpenAI-endpoint
and Anthropic-API-key model routes. This is an **approved provider-boundary
path** (`.codex/architecture-map.json` + `architecture_rules.py`): DeepAgents /
LangChain imports and `ANTHROPIC_`/`OPENAI_` env keys live only here.

## Layout

- `execution-adapter.ts` — `AgentExecutionAdapter`. Resolves the dist runner
  (`<runnerDistDir>/../adapters/llm/deepagents-langchain/runner/index.js`),
  validates the credential projection, projects gateway model env, points the
  runner at an adapter-owned sessions dir.
- `credential-validation.ts` — credential-mode guard. Selected only for this
  engine, so it enforces `supportedCredentialModes: ['api_key']` here: Claude
  OAuth is rejected with the locked copy; missing Model Access uses the
  setup-required copy.
- `model-credential-env.ts` — allowlist (`OPENAI_*`, `ANTHROPIC_*`,
  `NODE_EXTRA_CA_CERTS`) projected to `runnerInputPatch.modelCredentialEnv` only.
- `runner/` — the child process. `model-factory.ts` builds `ChatOpenAI`
  (`configuration.baseURL`) / `ChatAnthropic` (`anthropicApiUrl`, env is NOT read
  by ChatAnthropic) explicitly from gateway env. `stream-normalizer.ts` is a pure
  function over `streamEvents(..., {version:'v2'})` → neutral runner frames
  (unit-tested without network). `session-store.ts` is the adapter-private live
  session projection. `deep-agent-runner.ts` wires `createDeepAgent`.

## Locked v1 constraints

- Tool-less: no custom tools, no MCP, no skills, no `interruptOn`/HITL (later
  packets D/F). Raw authority disabled: default `StateBackend` (no `execute`),
  deny-all filesystem `permissions` block every built-in FS tool. Never pass
  `LocalShellBackend` or any sandbox backend.
- Model credentials reach the runner ONLY via the loopback gateway env
  (`runnerInputPatch.modelCredentialEnv`); never via `toolNetworkEnv`. Tokens are
  run-scoped `gtw_` gateway tokens, never raw provider secrets.
- Context-window figures are reported at runtime from `model.profile`
  (`maxInputTokens`); never hardcode them (catalog deepagents entries omit them).
- Frames must match the host parser (`runner/runner-frame.ts`, mirrors
  `AgentOutput` in `agent-spawn-types.ts`): live turns emit `newSessionId` first,
  stream text deltas, then a final usage/contextUsage frame. Scheduled jobs are
  ephemeral (no session persistence).
