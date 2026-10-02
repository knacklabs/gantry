Six findings verified by static call tracing. No files changed. An attempted executable check was blocked by command policy; no runtime-test claims are made below. Locations are under `apps/core/src/`.

1. **Disabled connections still count as ready — UX / parallel**

   **Today:** With a provider enabled and its only account disabled, the status model reports that provider as ready. The connection code excludes that same account, so status and actual connection eligibility disagree.

   **Locations:** [control-plane-settings-inputs.ts:16](../../../../apps/core/src/application/control-plane/control-plane-settings-inputs.ts#L16) ignores account status; [provider-account-channel-connect.ts:77](../../../../apps/core/src/channels/provider-account-channel-connect.ts#L77) and [runtime-settings-validation.ts:151](../../../../apps/core/src/config/settings/runtime-settings-validation.ts#L151) exclude disabled accounts.

   **Survive:** The runtime’s active-account rule, because disabled accounts cannot connect.

   **Delete/merge:** Remove the status model’s existence-only readiness rule; derive readiness from active accounts.

   **Size:** Small. **Risk:** Preserve the distinction between configured readiness and live connection health.

2. **Skill receipts request credentials without checking whether they exist — UX**

   **Today:** Installing a skill with declared credentials always produces credential-setup instructions—even when those credentials are already stored. One receipt also says “It is available now” immediately before saying credentials are needed before use.

   **Locations:** [user-visible-messages.ts:1](../../../../apps/core/src/shared/user-visible-messages.ts#L1) and [:15](../../../../apps/core/src/shared/user-visible-messages.ts#L15); approval outcome [ipc-skill-permission-review.ts:228](../../../../apps/core/src/jobs/ipc-skill-permission-review.ts#L228), approval details [:345](../../../../apps/core/src/jobs/ipc-skill-permission-review.ts#L345), and command receipt [skill-install-assets.ts:76](../../../../apps/core/src/jobs/skill-install-assets.ts#L76).

   **Survive:** The installation confirmation and existing credential resolution in [capability-secret-service.ts:92](../../../../apps/core/src/application/capability-secrets/capability-secret-service.ts#L92).

   **Delete/merge:** Stop treating declared requirements as missing credentials. Use the resolved missing set for setup instructions; reserve availability claims for verified readiness.

   **Size:** Medium, because both installation paths need consistent readiness context. **Risk:** Credential checks must retain capability restrictions and expose no values.

3. **Credential-binding setup is a wired no-op — dead / over-complicated**

   **Today:** Startup and conversation registration run credential-binding setup, maintain promise state, and handle timeouts and failures. The production operation at the bottom ignores its input and returns `undefined`; it creates no binding.

   **Locations:** Application wrappers [agent-credential-service.ts:171](../../../../apps/core/src/application/credentials/agent-credential-service.ts#L171) and [:183](../../../../apps/core/src/application/credentials/agent-credential-service.ts#L183); adapter wrappers [agent-credential-broker-factory.ts:48](../../../../apps/core/src/adapters/credentials/agent-credential-broker-factory.ts#L48) and [:70](../../../../apps/core/src/adapters/credentials/agent-credential-broker-factory.ts#L70); orchestration [runtime-app.ts:231](../../../../apps/core/src/app/bootstrap/runtime-app.ts#L231), [:306](../../../../apps/core/src/app/bootstrap/runtime-app.ts#L306), [:433](../../../../apps/core/src/app/bootstrap/runtime-app.ts#L433); callers [startup.ts:447](../../../../apps/core/src/app/bootstrap/startup.ts#L447) and [group-registry.ts:121](../../../../apps/core/src/runtime/group-registry.ts#L121).

   **Survive:** Actual broker creation and credential injection, which serve real execution.

   **Delete/merge:** Remove the ensure-binding functions, promise map, registration hooks, startup wait, and tests devoted to that empty operation.

   **Size:** Medium. **Risk:** Keep the broker getter used by execution; remove only binding setup.

4. **The remote skill cache only writes — over-complicated**

   **Today:** S3 skill reads and writes also await local cache warming. Reads always fetch from S3; the wrapper never reads its cache. Developers maintain another copy of the artifacts without gaining a cache hit.

   **Locations:** Write warming [remote-first-skill-artifact-store.ts:21](../../../../apps/core/src/adapters/artifacts/skills/remote-first-skill-artifact-store.ts#L21), read warming [:32](../../../../apps/core/src/adapters/artifacts/skills/remote-first-skill-artifact-store.ts#L32), and production construction [factory.ts:250](../../../../apps/core/src/adapters/storage/postgres/factory.ts#L250).

   **Survive:** `S3SkillArtifactStore` as remote authority; `LocalSkillArtifactStore` for the local driver.

   **Delete/merge:** Delete the 79-line wrapper and return the S3 store directly.

   **Size:** Small. **Risk:** Preserve verified runner projection and fleet materialization, which have separate paths.

5. **Skill frontmatter parsing exists three times — duplicate**

   **Today:** Installation, package review, and runtime helpers maintain identical parsing code for CRLF normalization, quoted values, and multiline blocks. A parser change requires editing three copies.

   **Every copy:** [skill-service.ts:433](../../../../apps/core/src/application/skills/skill-service.ts#L433), [skill-package-ipc.ts:169](../../../../apps/core/src/jobs/skill-package-ipc.ts#L169), [skill-artifact-helpers.ts:102](../../../../apps/core/src/shared/skill-artifact-helpers.ts#L102).

   **Survive:** The existing exported shared parser, already consumed by runtime skill projection.

   **Delete/merge:** Import it in installation and package review; delete both private copies—about 60 lines.

   **Size:** Small. **Risk:** Keep review and installation interpreting the same bytes.

6. **Skill artifact path validation exists three times — duplicate**

   **Today:** Local storage, S3 storage, and shared bundle handling separately implement the same rejection rules for traversal, absolute paths, hidden segments, empty segments, and NULs.

   **Every asset-path copy:** [local-skill-artifact-store.ts:89](../../../../apps/core/src/adapters/artifacts/skills/local-skill-artifact-store.ts#L89), [s3-skill-artifact-store.ts:238](../../../../apps/core/src/adapters/artifacts/skills/s3-skill-artifact-store.ts#L238), [skill-artifact-helpers.ts:54](../../../../apps/core/src/shared/skill-artifact-helpers.ts#L54). Storage-reference validation is also duplicated at [local:121](../../../../apps/core/src/adapters/artifacts/skills/local-skill-artifact-store.ts#L121) and [S3:260](../../../../apps/core/src/adapters/artifacts/skills/s3-skill-artifact-store.ts#L260).

   **Survive:** Shared asset-path validation and one shared storage-reference validator.

   **Delete/merge:** Delete the adapter copies. Keep filesystem confinement and symlink checks at their actual boundaries.

   **Size:** Small. **Risk:** These are security checks; preserve every rejection case.

Covered items noticed:

- **covered by PERMFLOW-1:** Separate engine permission gates: [Claude:610](../../../../apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.ts#L610), [DeepAgents:147](../../../../apps/core/src/adapters/llm/deepagents-langchain/runner/third-party-mcp-gate.ts#L147).
- **covered by PERMFLOW-4:** Job setup-state plumbing: [job-management-readiness.ts:47](../../../../apps/core/src/application/jobs/job-management-readiness.ts#L47).
- **covered by MSG-1:** Alternative ingress persistence branches: [conversation-message-ingress.ts:228](../../../../apps/core/src/application/external-ingress/conversation-message-ingress.ts#L228) and [:253](../../../../apps/core/src/application/external-ingress/conversation-message-ingress.ts#L253).

Ranked by value: **1 → 2 → 3 → 4 → 5 → 6**. Fix misleading status and credential instructions first; then remove empty orchestration, the unused cache, and repeated parsers.
