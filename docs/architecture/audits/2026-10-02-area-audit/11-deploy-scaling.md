Read-only audit complete; no files changed. These findings are verified from code tracing, without running services.

1. **Encryption-key loading diverges between credentials and background tasks — duplicate / UX**

   **Today:** With the encryption key saved only in `GANTRY_HOME/.env`, stored credentials can work while background command, MCP, and delegated-agent tasks fail with “bad payload key.” Their encryption code reads only `process.env`.

   **Locations, every copy:** Credential key loading and keyring parsing: [credential-secret-crypto.ts:42](../../../../apps/core/src/adapters/storage/postgres/repositories/credential-secret-crypto.ts#L42), [185](../../../../apps/core/src/adapters/storage/postgres/repositories/credential-secret-crypto.ts#L185). External-ingress equivalents: [control-plane-external-ingress.postgres.ts:422](../../../../apps/core/src/adapters/storage/postgres/repositories/control-plane-external-ingress.postgres.ts#L422), [460](../../../../apps/core/src/adapters/storage/postgres/repositories/control-plane-external-ingress.postgres.ts#L460). Background-task equivalents: [async-task-execution-payload.ts:215](../../../../apps/core/src/jobs/async-task-execution-payload.ts#L215), [254](../../../../apps/core/src/jobs/async-task-execution-payload.ts#L254). The working environment/file resolver is [env-runtime-secret-provider.ts:58](../../../../apps/core/src/adapters/credentials/env-runtime-secret-provider.ts#L58).

   **Survive:** The existing secret provider and one keyring decoder, because every consumer uses the same encryption-key settings.
   **Delete/merge:** Merge the three key-loading/parser implementations. Keep their purpose-specific authenticated data and ciphertext handling.
   **Size:** Medium story.
   **Risk:** Key rotation and decryption must retain the correct key IDs and authentication context.

2. **Two fallback service launchers have different process-safety rules — parallel / UX**

   **Today:** On Linux without user systemd, `gantry service start` kills an already-running PID from its file and starts again. The other background launcher verifies ownership and returns “already running.” A stale PID reused by another program therefore receives a termination signal on the Linux path.

   **Locations, both copies:** Shell launcher: [manager.ts:268](../../../../apps/core/src/infrastructure/service/manager.ts#L268), selected at [387](../../../../apps/core/src/infrastructure/service/manager.ts#L387). Ownership-checked launcher: [manager.ts:418](../../../../apps/core/src/infrastructure/service/manager.ts#L418). Shared stop already checks ownership at [550](../../../../apps/core/src/infrastructure/service/manager.ts#L550).

   **Survive:** The ownership-checked detached Node launcher; it already handles logging, migration, PID persistence, and platform-specific termination.
   **Delete/merge:** Remove the generated `nohup` script and route both fallback modes through that launcher.
   **Size:** Small fix.
   **Risk:** Preserve Windows termination behavior and verify that the detached Linux process survives CLI exit.

3. **Four gateway owners divide the same model-provider budget — duplicate / parallel**

   **Today:** Chat/API calls and memory calls create separate model gateways, each with its own rate window. They can collectively exceed the configured provider cap even within one process. Embeddings create another gateway without supplying the limits getter, so that gateway applies no configured cap.

   **Locations, every persistent owner:** [runtime-app.ts:204](../../../../apps/core/src/app/bootstrap/runtime-app.ts#L204), [memory-query.ts:218](../../../../apps/core/src/adapters/llm/anthropic-claude-agent/memory-query.ts#L218), [memory-gateway-injection.ts:44](../../../../apps/core/src/adapters/llm/openai-memory/memory-gateway-injection.ts#L44), and [memory-embeddings.ts:448](../../../../apps/core/src/memory/memory-embeddings.ts#L448), with the missing getter at [474](../../../../apps/core/src/memory/memory-embeddings.ts#L474). Each broker constructs its own limiter at [gantry-model-gateway.ts:145](../../../../apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts#L145); windows are stored at [gantry-model-gateway-rate-limit.ts:20](../../../../apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway-rate-limit.ts#L20).

   **Survive:** The gateway implementation, run-scoped tokens, and one runtime-owned broker lifecycle.
   **Delete/merge:** Merge the four caches and replacement/close routines. Share model-provider admission accounting across processes before treating the cap as deployment-wide.
   **Size:** Medium story.
   **Risk:** Preserve app isolation, token revocation, and active requests during configuration changes.

4. **Hosted `all` mode retains a weaker readiness policy — parallel**

   **Today:** Split workers report worker-registration and scheduler readiness; `all` omits both checks and live-capacity reporting. This exception also affects the hosted support deployment, which explicitly runs `all`, not just workstations.

   **Locations, every policy:** Capability-derived requirements: [role-readiness.ts:27](../../../../apps/core/src/app/bootstrap/roles/role-readiness.ts#L27). The all-false override: [app/index.ts:456](../../../../apps/core/src/app/index.ts#L456), repeated as a server default at [control/server/index.ts:385](../../../../apps/core/src/control/server/index.ts#L385). Checks are conditional at [system-health.ts:142](../../../../apps/core/src/control/server/system-health.ts#L142). Hosted use: [support/main.tf:76](../../../../ops/terraform/envs/support/main.tf#L76).

   **Survive:** Requirements derived from the subsystems actually enabled.
   **Delete/merge:** Remove the historical `all` exceptions and duplicated default table.
   **Size:** Small fix.
   **Risk:** Respect deliberately disabled execution features; saturation should remain informational. I verified the omitted checks, not a live false-ready incident.

5. **Credential-binding setup still runs around a no-op — dead / over-complicated**

   **Today:** Startup and route registration maintain binding promises, invoke two binding paths, and retain timeout/error machinery, but the production binding implementation always returns `undefined` and creates nothing.

   **Locations, every layer:** No-op and forwarding function: [agent-credential-service.ts:171](../../../../apps/core/src/application/credentials/agent-credential-service.ts#L171). Both adapter wrappers: [agent-credential-broker-factory.ts:48](../../../../apps/core/src/adapters/credentials/agent-credential-broker-factory.ts#L48), [70](../../../../apps/core/src/adapters/credentials/agent-credential-broker-factory.ts#L70). Cache and dispatch: [runtime-app.ts:231](../../../../apps/core/src/app/bootstrap/runtime-app.ts#L231), route-registration helper at [306](../../../../apps/core/src/app/bootstrap/runtime-app.ts#L306), startup sweep at [433](../../../../apps/core/src/app/bootstrap/runtime-app.ts#L433). Startup wait: [startup.ts:447](../../../../apps/core/src/app/bootstrap/startup.ts#L447).

   **Survive:** Actual credential validation when issuing gateway access.
   **Delete/merge:** Delete the binding wrappers, cache, callbacks, sweep, and startup wait.
   **Size:** Small fix.
   **Risk:** Low; retain real credential checks rather than replacing the no-op with another setup step.

Already covered:

- Inline scheduled permission refusal ([inline-agent-loop-tools.ts:426](../../../../apps/core/src/app/bootstrap/inline-agent-loop-tools.ts#L426)) — covered by **PERMFLOW-1/3**.
- Separate scheduler “Running” cards ([scheduler-lifecycle-notification.ts:61](../../../../apps/core/src/app/bootstrap/scheduler-lifecycle-notification.ts#L61)) — covered by **PERMFLOW-3/4**.
- Local-folder host/runner IPC ([agent-spawn.ts:332](../../../../apps/core/src/runtime/agent-spawn.ts#L332)) — covered by **MSG-4**.

Ranked by user impact, then deletion value:

1. **#1:** Background tasks fail under otherwise working secret configuration.
2. **#2:** Starting Gantry can terminate an unrelated process.
3. **#3:** Model-provider caps differ by execution path.
4. **#4:** Hosted health reporting omits execution checks.
5. **#5:** Largest straightforward deletion with low behavioral risk.
