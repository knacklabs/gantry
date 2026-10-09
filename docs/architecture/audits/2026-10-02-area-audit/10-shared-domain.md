Eight verified findings. No files changed. Locations below are under `apps/core/src/`.

1. **Five canonical JSON implementations — duplicate / parallel**

   Developers get different canonical bytes depending on the helper. A read-only check with `{a:1,A:2}` confirmed that `stableSha256Json(value)` differs from `sha256Hex(canonicalJson(value))`: one sorts with `localeCompare`, the other with ordinary key sorting.

   **Locations:** [shared/stable-hash.ts:15](../../../../apps/core/src/shared/stable-hash.ts#L15), [shared/canonical-json.ts:1](../../../../apps/core/src/shared/canonical-json.ts#L1), [settings-revision-document.ts:246](../../../../apps/core/src/config/settings/settings-revision-document.ts#L246), [chat-batch-state-machine.ts:455](../../../../apps/core/src/memory/chat-batch-state-machine.ts#L455), [outbound-delivery-service.ts:494](../../../../apps/core/src/application/outbound-delivery/outbound-delivery-service.ts#L494).

   **Survive:** shared canonical JSON, with locale-independent ordering. **Merge/delete:** the four local recursive implementations; preserve the distinction between returning a normalized object and returning JSON text. **Size:** medium story. **Risk:** changing serialization changes persisted fingerprints and identities; audit those consumers together.

2. **Artifact files have three identical types and duplicated hashing — duplicate**

   Developers maintain the same five fields in three interfaces. Browser profiles and toolchains also repeat normalization and the same hash framing.

   **Locations:** [BrowserProfileFileModel:8](../../../../apps/core/src/shared/browser-profile-hash.ts#L8), [BrowserProfileArtifactFile:5](../../../../apps/core/src/domain/ports/browser-profile-artifact-store.ts#L5), [ToolchainArtifactFile:5](../../../../apps/core/src/domain/ports/toolchain-artifact-store.ts#L5); normalization/hash copies at [browser-profile-hash.ts:24](../../../../apps/core/src/shared/browser-profile-hash.ts#L24) and [toolchain-artifact-bundle.ts:14](../../../../apps/core/src/adapters/artifacts/toolchains/toolchain-artifact-bundle.ts#L14).

   **Survive:** one shared file shape and normalization/hash implementation. **Merge/delete:** duplicated interfaces and toolchain hashing; keep artifact-specific path validation. **Size:** medium story because shared contracts change. **Risk:** preserve content-hash bytes, default modes and symlink handling exactly. Skill hashing uses different framing and should remain separate.

3. **Artifact path guards are copied seven times — duplicate**

   Developers repeat the same slash normalization and rejection of absolute paths, NULs, empty segments, `.` and `..`, including twice within each bundle module.

   **Locations:** [toolchain-artifact-bundle.ts:67](../../../../apps/core/src/adapters/artifacts/toolchains/toolchain-artifact-bundle.ts#L67) and [:83](../../../../apps/core/src/adapters/artifacts/toolchains/toolchain-artifact-bundle.ts#L83); [browser-profile-bundle.ts:55](../../../../apps/core/src/adapters/artifacts/browser-profiles/browser-profile-bundle.ts#L55) and [:71](../../../../apps/core/src/adapters/artifacts/browser-profiles/browser-profile-bundle.ts#L71); [local-skill-artifact-store.ts:121](../../../../apps/core/src/adapters/artifacts/skills/local-skill-artifact-store.ts#L121), [s3-skill-artifact-store.ts:260](../../../../apps/core/src/adapters/artifacts/skills/s3-skill-artifact-store.ts#L260), [local-file-artifact-bytes.ts:113](../../../../apps/core/src/adapters/artifacts/files/local-file-artifact-bytes.ts#L113).

   **Survive:** the existing traversal guard, moved into one shared function. **Merge/delete:** seven bodies, retaining contextual error messages at callers. **Size:** medium story. **Risk:** security boundary; retain every rejection. Stricter skill-asset and virtual-path policies must remain explicit.

4. **Logger copies the provider-session scrubber — duplicate**

   Session-handle redaction fixes must currently be made in two places. The field-name lists, four regular expressions and replacement loop are duplicated.

   **Locations:** [shared/provider-session-redaction.ts:1](../../../../apps/core/src/shared/provider-session-redaction.ts#L1), [logger.ts:83](../../../../apps/core/src/infrastructure/logging/logger.ts#L83), with duplicate replacement at [logger.ts:200](../../../../apps/core/src/infrastructure/logging/logger.ts#L200) and handle patterns at [logger.ts:121](../../../../apps/core/src/infrastructure/logging/logger.ts#L121).

   **Survive:** the shared scrubber, already used by session recovery and job persistence. **Delete:** logger’s session-specific patterns and loop; call the helper. Keep other credential redaction. **Size:** small fix. **Risk:** preserve redaction markers and structured-key redaction.

5. **IPC signing has duplicated cryptographic helpers — duplicate / dead**

   Request creation and host verification maintain identical HMAC signers. Response verification is implemented twice, but the infrastructure verifier has no production caller.

   **Locations:** request signers at [shared/ipc-signing.ts:44](../../../../apps/core/src/shared/ipc-signing.ts#L44) and [request-signing.ts:7](../../../../apps/core/src/infrastructure/ipc/request-signing.ts#L7); response verifiers at [shared/ipc-signing.ts:97](../../../../apps/core/src/shared/ipc-signing.ts#L97) and [response-signing.ts:39](../../../../apps/core/src/infrastructure/ipc/response-signing.ts#L39).

   **Survive:** shared request signing and response verification, usable by standalone runners. **Merge/delete:** host signer body and unused infrastructure verifier. **Size:** small fix. **Risk:** preserve payload bytes; retain host timing-safe comparison and freshness checks.

6. **Seven timestamp normalizers repeat the same conversion — duplicate**

   Repository mappers independently parse timestamps, convert valid values to ISO and retain invalid strings. The message-service version additionally handles missing values.

   **Locations:** [domain-repositories.postgres.ts:230](../../../../apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts#L230), [permission-decision-memory-repository.postgres.ts:528](../../../../apps/core/src/adapters/storage/postgres/repositories/permission-decision-memory-repository.postgres.ts#L528), [model-credential-repository.postgres.ts:238](../../../../apps/core/src/adapters/storage/postgres/repositories/model-credential-repository.postgres.ts#L238), [message-attachment-repository.postgres.ts:663](../../../../apps/core/src/adapters/storage/postgres/repositories/message-attachment-repository.postgres.ts#L663), [capability-secret-repository.postgres.ts:217](../../../../apps/core/src/adapters/storage/postgres/repositories/capability-secret-repository.postgres.ts#L217), [permission-promotion-repository.postgres.ts:99](../../../../apps/core/src/adapters/storage/postgres/repositories/permission-promotion-repository.postgres.ts#L99), [canonical-message-ops-service.ts:55](../../../../apps/core/src/adapters/storage/postgres/services/canonical-message-ops-service.ts#L55).

   **Survive:** one adapter-level conversion; keep optional-input handling at the message boundary. **Delete:** local conversion bodies. **Size:** medium story. **Risk:** shared `toIso` throws on invalid input, so substituting it directly changes behavior.

7. **Two incompatible interfaces both named Clock — parallel**

   Developers cannot pass the shared fixed clock into application services: shared `now()` returns a `Date`, while application `now()` returns a string. Separate clock implementations are required.

   **Locations:** [shared/time/datetime.ts:1](../../../../apps/core/src/shared/time/datetime.ts#L1), [application/common/clock.ts:3](../../../../apps/core/src/application/common/clock.ts#L3). The application adapter is visible at [job-management-service.ts:588](../../../../apps/core/src/application/jobs/job-management-service.ts#L588).

   **Survive:** one shared clock contract; format timestamps through shared time helpers. **Merge/delete:** the incompatible application contract and adapter implementations. **Size:** medium story. **Risk:** retain injected time for deterministic scheduling and lease behavior.

8. **Formatting baggage has no production consumer — dead / over-complicated**

   Developers maintain a second duration formatter used only by tests, an unused formatting-options interface, and attempt-label branches never supplied by the sole production run-label caller.

   **Locations:** [formatDurationMs:44](../../../../apps/core/src/shared/time/datetime.ts#L44), [DurationFormatOptions:1](../../../../apps/core/src/shared/human-format.ts#L1), [attempt branches:67](../../../../apps/core/src/shared/human-format.ts#L67); production caller [run-event-projection.ts:84](../../../../apps/core/src/control/server/run-event-projection.ts#L84).

   **Survive:** `formatDuration` and run labels containing actual supplied fields. **Delete:** unused formatter, options and attempt fields/branches, plus tests dedicated to them. **Size:** small fix. **Risk:** none identified in production usage.

Observed exclusions:

- **covered by PERMFLOW-4:** job setup/card machinery in [job-types.ts:94](../../../../apps/core/src/domain/job-types.ts#L94).
- **covered by UX-1:** fallback preface in [domain/types.ts:445](../../../../apps/core/src/domain/types.ts#L445).
- **covered by MSG-2:** outbound delivery machinery; finding 1 concerns its copied serializer.

The named UX/provider spec files are absent here; those exclusions follow your supplied descriptions.

Ranked by value, putting user-facing risk before deletion volume:

1. Canonical JSON consistency.
2. IPC signing consolidation.
3. Provider-session redaction consolidation.
4. Artifact path guards.
5. Artifact types and hashing.
6. Timestamp normalizers.
7. Clock contracts.
8. Dead formatting baggage.
