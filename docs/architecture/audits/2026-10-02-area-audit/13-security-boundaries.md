Read-only static audit; no files changed. These are code-path findings, not evidence that real credentials have already leaked.

1. **Sandbox errors use a weaker redaction fork — duplicate**

   SDK sandbox-event reasons preserve bare AWS access-key IDs, GitLab tokens and PEM private keys that the shared redactor catches. Host sandbox failures use a different sanitizer. Event forwarding passes the payload through unchanged.

   **Locations:** [SDK redactor:41](../../../../apps/core/src/adapters/llm/anthropic-claude-agent/runner/sandbox-events.ts#L41), [shared rules:22](../../../../apps/core/src/shared/sensitive-material.ts#L22), [host sanitizer:24](../../../../apps/core/src/runtime/agent-spawn-log-sanitization.ts#L24), [logger rules:120](../../../../apps/core/src/infrastructure/logging/logger.ts#L120); [unchanged forwarding:120](../../../../apps/core/src/runtime/runtime-event-forwarding.ts#L120).

   **Survive:** shared secret recognition, with host logging’s structured-error handling and existing output limits. **Delete/merge:** replace the SDK’s private regex chain with the shared helper. **Size:** small. **Risk:** credential material can enter durable audit events; preserve masking before truncation.

2. **Completed runs retain sandbox policies indefinitely — over-complicated**

   Every worker spawn registers a policy under a newly generated run handle. The registry only supports insertion and lookup; finalization removes other credentials and resources but leaves this entry. A long-running host therefore retains completed runs’ principals, paths and network projections.

   **Locations:** [registry:18](../../../../apps/core/src/runtime/async-command-sandbox-policy.ts#L18), [unique handles:269](../../../../apps/core/src/runtime/agent-spawn-helpers.ts#L269), [registration:701](../../../../apps/core/src/runtime/agent-spawn.ts#L701), [finalization:799](../../../../apps/core/src/runtime/agent-spawn.ts#L799). Both consumers are [command-task lookup:189](../../../../apps/core/src/jobs/ipc-agent-task-lifecycle-handlers.ts#L189) and [MCP-task lookup:456](../../../../apps/core/src/jobs/ipc-mcp-tool-handlers.ts#L456).

   **Survive:** host-owned policies for live parent runs. **Delete/merge:** release completed entries through the existing spawn finalizer. **Size:** small. **Risk:** unbounded memory retention and stale policy state; an unauthorized invocation was not demonstrated. Confirm launched child tasks already own their execution policy before releasing the parent entry.

3. **Public-address classification is copied wholesale — duplicate**

   Developers must maintain two copies of IPv4/IPv6 parsing and private-address classification. Egress and DNS-pinned fetch use the shared copy; webhook and MCP validation use the domain copy. The duplicated rules currently agree.

   **Every copy:** [domain policy:10](../../../../apps/core/src/domain/network/public-address-policy.ts#L10) and [shared policy:104](../../../../apps/core/src/shared/network-host-declaration.ts#L104), including their `parseIpv4`, `parseIpv6Bytes`, `isIpAddress` and `isPrivateNetworkAddress` implementations.

   **Survive:** the domain policy, which also supplies loopback classification; keep declaration parsing in its existing shared module. **Delete/merge:** import the classifiers instead of copying approximately 123 lines. **Size:** small. **Risk:** preserve invalid-address rejection and IPv4-mapped IPv6 handling.

4. **Shell-child environment construction has two copies — duplicate**

   DeepAgents shell commands and host async commands separately enumerate the same network/CA and POSIX environment keys, then copy allowed values. Adding a required networking variable requires updating both.

   **Every copy:** DeepAgents [lists:80](../../../../apps/core/src/adapters/llm/deepagents-langchain/runner/gantry-shell-tool.ts#L80) and [builder:117](../../../../apps/core/src/adapters/llm/deepagents-langchain/runner/gantry-shell-tool.ts#L117); async commands [list:19](../../../../apps/core/src/jobs/async-command-sandbox-runner.ts#L19) and [builder:309](../../../../apps/core/src/jobs/async-command-sandbox-runner.ts#L309).

   **Survive:** the strict whitelist and [shared network contract:13](../../../../apps/core/src/shared/tool-network-env.ts#L13). **Delete/merge:** share whitelist selection and copying, passing environment sources explicitly. **Size:** small. **Risk:** DeepAgents deliberately takes network values from host-projected `toolNetworkEnv`; preserve that distinction rather than copying ambient runner credentials.

5. **Provider-session redaction duplicates an existing helper — duplicate**

   Logs and persisted/user-visible summaries maintain identical session-field regexes and handle-shape patterns independently. A new sensitive session field needs changes in both.

   **Every copy:** [shared patterns and redactor:15](../../../../apps/core/src/shared/provider-session-redaction.ts#L15); logger [field patterns:83](../../../../apps/core/src/infrastructure/logging/logger.ts#L83), [handle patterns:121](../../../../apps/core/src/infrastructure/logging/logger.ts#L121), and [replacement loop:200](../../../../apps/core/src/infrastructure/logging/logger.ts#L200).

   **Survive:** `redactProviderSessionHandlesInText`, already used outside logging. **Delete/merge:** call it from `redactString`; remove the logger’s copied session patterns and loop. Keep structured-key masking. **Size:** small. **Risk:** preserve quoted, unquoted and bare-handle coverage.

6. **IPC envelope validation is repeated per lane — duplicate**

   General, browser and memory requests each copy payload preparation, signature verification, freshness checking and replay reservation. Only key derivation, binding and permitted lifetimes need lane-specific behavior.

   **Every copy:** [general validator:505](../../../../apps/core/src/runtime/ipc-auth-validation.ts#L505), [browser validator:578](../../../../apps/core/src/runtime/ipc-auth-validation.ts#L578), [memory validator:617](../../../../apps/core/src/runtime/ipc-auth-validation.ts#L617).

   **Survive:** lane-specific authenticated bindings and purpose-limited extended lifetimes. **Delete/merge:** one internal envelope verifier with explicit signing key, replay scope and lifetime parameters; retain the three binding parsers. **Size:** small. **Risk:** accidentally sharing replay namespaces or extending browser/memory lifetimes.

7. **IPC cryptography is split, with unused verification APIs — parallel**

   Request signing has two identical implementations. Response verification also has two copies, but production callers use only the shared one. The older bearer-token checker has only test callers.

   **Every copy:** request signers [infrastructure:7](../../../../apps/core/src/infrastructure/ipc/request-signing.ts#L7) and [shared:44](../../../../apps/core/src/shared/ipc-signing.ts#L44); response verifiers [infrastructure:39](../../../../apps/core/src/infrastructure/ipc/response-signing.ts#L39) and [shared:97](../../../../apps/core/src/shared/ipc-signing.ts#L97); unused [bearer checker:255](../../../../apps/core/src/runtime/ipc-auth.ts#L255).

   **Survive:** shared signing/verification primitives, host-only response private-key operations, and authenticated request validation. **Delete/merge:** the duplicate request signer, unused infrastructure response verifier and test-only bearer checker. **Size:** medium when including affected test files. **Risk:** preserve the current signed bytes: requests use canonical JSON; responses use `JSON.stringify`.

Already covered:

- **covered by PERMFLOW-1:** engine-owned permission decisions in [DeepAgents:147](../../../../apps/core/src/adapters/llm/deepagents-langchain/runner/third-party-mcp-gate.ts#L147) and [inline execution:305](../../../../apps/core/src/app/bootstrap/inline-agent-loop-tools.ts#L305).
- **covered by PERMFLOW-2:** parallel command-prefix interpretation in [display sanitization:59](../../../../apps/core/src/shared/runtime-env-command.ts#L59) and [command matching:106](../../../../apps/core/src/shared/tool-rule-runtime-command.ts#L106).
- **covered by MSG-4:** shared-file runner transport, including [response-file polling:154](../../../../apps/core/src/runner/mcp/ipc.ts#L154).

Ranked value, user impact first, then deletion potential:

1. **#1:** close the sandbox-event redaction gap.
2. **#2:** bound retained per-run security state.
3. **#3:** remove approximately 123 duplicated address-policy lines.
4. **#4:** remove duplicate environment lists and copying loops.
5. **#6:** merge repeated authenticated-envelope processing.
6. **#7:** consolidate crypto and remove unused verification paths.
7. **#5:** remove the copied session-redaction catalog.
