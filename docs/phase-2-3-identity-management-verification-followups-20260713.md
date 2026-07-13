# Phase 2-3 Identity Management Verification Follow-ups - 2026-07-13

This file records issues discovered during local feature verification and the
decision taken for each issue. Items marked resolved are part of the feature
patch; items marked deferred are operator-tooling follow-ups and do not change
identity runtime correctness.

## 1. Local migration timestamp collision after rebasing onto latest main

- **Observed:** `npm run db:migrate` failed on `0094_brain_dreaming` because `brain_pages` did not exist.
- **Cause found:** the local database had a previously applied migration timestamp that now belongs to upstream `0093_company_brain_core`, so Drizzle treated the upstream migration as already applied.
- **Verification workaround used:** manually applied `0093_company_brain_core.sql` once to the local `gantry` schema, then reran `npm run db:migrate` successfully.
- **Risk:** developers who rebased while the branch migration timestamp overlapped upstream can hit the same broken local migration history.
- **Future fix decision needed:** define a safe local-development migration recovery playbook or add a migration-history sanity check that detects timestamp/name drift before applying later migrations.

## 2. Runtime startup crashed when People API routes lacked OpenAPI schemas - resolved

- **Observed:** `gantry service restart` crashed with `Missing OpenAPI response schema for resolveIdentity`.
- **Cause found:** People API route docs referenced operation IDs that did not have request/response schema mappings.
- **Verification fix applied:** added OpenAPI request/response schemas for identity resolve, people read/list, alias link/retire, and merge preview/apply.
- **Risk:** route registration fails at runtime if operation schema coverage is incomplete, so API docs drift can break startup.
- **Decision:** keep complete People route request/response mappings in the
  generated OpenAPI gate. Focused OpenAPI and SDK contract tests are mandatory.

## 3. Local verification helper must handle escaped JSON env values

- **Observed:** the temporary Control API verification helper failed parsing `GANTRY_CONTROL_API_KEYS_JSON` because the local `.env` value stores escaped quotes.
- **Cause found:** the helper used a simple `.env` parser, while Gantry itself accepts the escaped JSON value in runtime loading.
- **Verification fix applied:** updated only the temporary helper to unescape JSON-style quoted values before parsing.
- **Risk:** ad hoc local verification scripts can produce misleading failures if they do not parse Gantry `.env` the same way the runtime does.
- **Future fix decision needed:** prefer a repo-owned local Control API helper or documented command for safe Unix-socket calls instead of one-off parsers.

## 4. Local verification helper assumed one People response id shape

- **Observed:** the temporary helper attempted `POST /v1/people/undefined/aliases`.
- **Cause found:** the helper assumed the list response always exposes `id`, while the current People API object can expose the canonical person id under a different field shape.
- **Verification fix applied:** updated only the temporary helper to normalize person ids from `id` or `personId`.
- **Risk:** API consumers can make incorrect assumptions without an example-backed People API contract doc.
- **Future fix decision needed:** add a small People API examples section to the implementation doc or public API docs showing the actual list/get/alias response shape.

## 5. Slack MCP cannot send a real user DM to the Gantry bot

- **Observed:** sending a DM to the Gantry Slack bot through Slack MCP failed
  with `restricted_action_read_only_channel`, both through the bot identity and
  an opened bot-DM conversation.
- **Cause found:** the Slack connector can open/read the DM container but cannot write into this app/bot DM channel as a real user message.
- **Verification impact:** Slack channel verification can be automated through MCP, but Slack DM personal-memory verification cannot be fully automated through this connector.
- **Risk:** using the Gantry Slack bot token as a workaround would create the wrong sender identity and would not test personal memory for the human Slack user.
- **Future fix decision needed:** document the personal-memory verification path as a mixed manual/automated test: the human sends the Slack DM manually, then Codex verifies runtime events, triggers user-scoped dreaming, and the human verifies Telegram recall.

## 6. Local Control API scope update can corrupt escaped JSON env format

- **Observed:** after widening local Control API key scopes for verification, runtime restart failed with `GANTRY_CONTROL_API_KEYS_JSON must be valid JSON`.
- **Cause found:** the temporary helper rewrote `.env` with escaped JSON but without shell/env quoting compatible with Gantry's strict parser.
- **Verification fix applied:** update the temporary helper to write the Control API key JSON as a single-quoted raw JSON value without printing the token.
- **Risk:** ad hoc `.env` mutation can break runtime startup even when the underlying key data is correct.
- **Future fix decision needed:** provide a first-party `gantry control keys` or `gantry dev auth` helper for local scope changes instead of editing `.env` manually.

## 7. Conversation install can partially succeed before settings sync fails - resolved

- **Observed:** enabling the discovered Slack DM conversation returned HTTP 500, while runtime logs still showed the DM route was registered.
- **Cause found:** the live route projection completed before `syncSettingsFromProjection`; settings sync then failed validation because existing projected settings contained provider/conversation entries missing runtime secret refs or approvers.
- **Verification impact:** the DM route may work until restart, but the install is not cleanly persisted through desired state.
- **Risk:** operators see a failed API response even though part of the runtime state changed, and a restart may lose or reshape the route.
- **Decision:** synchronize and validate desired state before registering the
  live route. If sync fails, the request fails with no live-only route mutation.

## 8. Runtime event test expects stale conversation id field - resolved

- **Observed:** focused unit verification failed in `group-processing.test.ts` for the sandbox blocked event assertion.
- **Cause found:** the emitted event carries `payload.conversationJid`, while the test expected top-level `conversationId`.
- **Verification impact:** this does not block the Telegram alias persistence fix, but it leaves the focused unit suite red.
- **Risk:** event shape expectations are split between older `conversationId` assertions and newer `conversationJid` payloads.
- **Decision:** provider route ids remain payload context. Top-level ids are
  reserved for canonical database foreign keys, and tests enforce that split.

## 9. Telegram message persistence conflicts with People alias rows - resolved

- **Observed:** Telegram received the user's message but Gantry did not reply.
- **Cause found:** canonical message persistence tried to create a legacy `user_aliases` row for the Telegram sender even though a verified People API alias already existed for the same provider account and external user.
- **Verification fix applied:** message persistence now looks up the active exact alias first and attaches the conversation participant to that canonical person id instead of creating a duplicate alias.
- **Risk:** any provider with a People API alias could fail message persistence if the older canonical graph path tries to create a second active alias.
- **Decision:** exact active aliases are reused for canonical participants. A
  Postgres regression test covers `ensureParticipant` with an existing alias.

## 10. Telegram alias verification used provider display name instead of runtime provider id - resolved

- **Observed:** after Slack DM personal memory was created, Telegram replied that it had no saved preferences.
- **Cause found:** provider display/registry ids and short JID prefixes were used
  inconsistently during live resolution. The live turn therefore hydrated a
  different, empty personal-memory scope.
- **Fix applied:** live ingress normalizes `tg` to canonical provider id
  `telegram` and `sl` to `slack` before exact alias lookup.
- **Risk:** operator/API callers can create aliases that look semantically correct but are invisible to live runtime resolution if provider ids are not normalized or documented.
- **Decision:** identity alias storage uses canonical provider registry ids;
  short forms remain JID routing prefixes only.
- **Verification:** after canonical alias merge and a clean patched-runtime
  restart, a real user-authored Telegram DM recalled all three personal
  preferences created from the Slack DM. The turn emitted a resolved Telegram
  identity decision and an eligible DM personal-memory hydration decision.

## 11. Development dependency audit found vulnerable build-tool pins - resolved

- **Observed:** production dependency audit passed, but the full development
  audit reported Windows development-server advisories through `tsx`,
  `drizzle-kit`, and Vitest.
- **Cause found:** the repository-wide override pinned `esbuild` to `0.28.0`,
  and Vitest resolved a vulnerable Vite `8.0.x` release.
- **Decision:** advance the central overrides to patched `esbuild 0.28.1` and
  `vite 8.1.4` instead of accepting unrelated transitive upgrades proposed by
  `npm audit fix`.
- **Verification:** rerun full and production audits, typecheck, tests, and build
  after refreshing the lockfile.

## 12. People list performed unbounded N+1 hydration - resolved

- **Observed:** `GET /v1/people` loaded every person and then queried aliases and
  memory counts separately for each result.
- **Risk:** response latency and database load grew linearly with both people
  and query count, making the admin surface unsafe for a large app.
- **Decision:** use opaque cursor pagination with a default of 50 and maximum of 200. Hydrate each page with three fixed queries: people, aliases, and memory
  counts. Keep `people.list()` with no SDK arguments valid.
- **Verification:** unit/API/SDK tests cover defaults, limits, cursors, and bad
  cursors; disposable Postgres integration covers ordering and page traversal.

## 13. Admin aliases could use routing prefixes instead of provider ids - resolved

- **Observed:** live ingress normalized `tg` and `sl`, but People API calls could
  persist those short JID prefixes as provider ids.
- **Risk:** an API-created alias could exist but never match the canonical
  `telegram` or `slack` lookup used by a live turn, splitting one human into
  different people.
- **Decision:** normalize provider ids at both ingress and People API seams.
  Short forms remain routing syntax only; durable aliases use canonical provider
  registry ids.

## 14. Re-adding a same-person alias did not verify it - resolved

- **Observed:** an existing unverified alias for the requested person was
  returned unchanged by the admin add-alias operation.
- **Risk:** explicit administrative review appeared successful without changing
  the alias verification state or evidence.
- **Decision:** same-person add-alias promotes the row to verified and replaces
  evidence. An alias owned by another person remains a conflict and is never
  silently moved.

## 15. People path decoding and query indexes needed hardening - resolved

- **Observed:** malformed percent-encoded person paths could escape normal route
  handling, and People/alias/personal-memory query shapes lacked targeted index
  proof.
- **Decision:** malformed People paths return deterministic
  `400 INVALID_REQUEST`. Migration `0099_people_identity_query_indexes` adds
  cursor, batched-alias, and partial personal-memory indexes.
- **Verification:** route tests cover malformed paths and disposable Postgres
  EXPLAIN tests prove all three intended indexes are selected.

## 16. Identity evidence could delay first live progress - resolved

- **Observed:** identity resolution and two durable runtime-event writes ran
  before the first progress notification.
- **Risk:** a healthy channel turn could look unresponsive while audit storage
  was slow.
- **Decision:** notify first progress before identity resolution. Identity and
  hydration decisions remain durable before model execution, but do not block
  the initial acknowledgement.

## 17. Telegram canonical messages omitted provider account metadata - resolved

- **Observed:** Telegram runtime routing knew the provider account, but text and
  media `NewMessage` records did not carry it into canonical persistence.
- **Risk:** multi-bot installations could lose the provider-account portion of
  the exact identity key during participant persistence.
- **Decision:** attach the active Telegram provider account id to both text and
  media ingress records. Focused Telegram adapter tests enforce this metadata.

## 18. Over-broad Postgres invocation enabled unrelated opt-in suites - documented

- **Observed:** running every integration file with
  `GANTRY_TEST_DATABASE_URL` enabled an inline-provider runtime test and a live
  metrics test that are not part of `test:integration:postgres`; one timed out
  and the other lacked its opt-in fixture state.
- **Decision:** stop that non-authoritative run and use the checked-in Postgres
  script plus the explicit identity repository suite. Do not redefine the
  feature gate around unrelated opt-in tests.
- **Future follow-up:** each opt-in integration family should have an explicit
  command and prerequisite guard so setting a database URL alone does not make
  unrelated suites look like required Postgres failures.

## 19. Postgres client concurrency deprecation warning - documented

- **Observed:** the complete identity repository file can emit the `pg` warning
  about calling `client.query()` while the client is already executing a query.
- **Scope found:** isolated identity concurrency and EXPLAIN tests are clean;
  the warning appears when the file also runs an older async-task backlog test.
- **Decision:** do not change unrelated repository scheduling code in this
  identity feature. Keep the warning visible as a future `pg@9` compatibility
  cleanup rather than suppressing it.

## 20. Active DM `/new` used the raw provider sender - resolved

- **Observed:** normal DM turns keyed session state by canonical `personId`, but
  the active `/new` path passed the raw Slack/Telegram sender id into session
  capture and deletion.
- **Risk:** `/new` could clear a different session key, leaving the canonical
  provider session active and finalizing the wrong memory boundary.
- **Decision:** active DM `/new` uses the same canonical resolver as a normal
  live turn. Group/channel `/new` passes no personal memory user. A focused test
  proves the resolver result reaches both session capture and deletion.

## 21. Retired exact-alias lookup lacked an index - resolved

- **Observed:** every active alias miss checks for an exact retired alias, but
  only the active exact-key lookup had an index.
- **Risk:** first turns for new or retired senders could scan `user_aliases` as
  identity history grows.
- **Decision:** migration `0099` also adds a partial retired exact-key index in
  repository order. Disposable Postgres EXPLAIN coverage verifies its use.

## 22. Merge preview/audit detail was unbounded - resolved

- **Observed:** merge apply built full alias and conflict arrays while holding
  person locks and persisted them in the merge audit result.
- **Risk:** unusually large identities could create long transactions and large
  in-memory/audit payloads.
- **Decision:** reject merges that exceed 1,000 alias or conflict detail rows.
  Set-based moves remain efficient; an operator must reduce an exceptional
  identity graph before merging it.

## 23. Missing People resources and success schemas - verified, no code defect

- **Review concern:** a missing person or alias appeared capable of producing a
  nullable success body or null dereference.
- **Code path found:** `PersonIdentityService` converts both repository misses to
  the existing non-disclosing `FORBIDDEN` application error before the route can
  construct a success response or publish an event.
- **Decision:** retain the cross-app-safe error copy and non-null success schema.
  Add explicit route tests for missing person and missing alias retirement.

## 24. SDK sender creation authority and memory scope - intentional boundary

- **Review concern:** a key with `sessions:write` can submit an explicit
  `senderId`, causing an unverified `web_user` alias to be created without
  `people:admin`.
- **Decision:** this is authenticated app ingress, equivalent to authenticated
  provider ingress creating an unverified sender on first contact. It is not
  verified identity administration: linking verified aliases, retiring aliases,
  and merging people still require `people:admin`.
- **Scope clarification:** SDK sessions are app-channel turns. They resolve
  explicit senders for identity evidence but do not hydrate personal memory;
  omitted senders remain the `sdk` system sentinel and create no person.

## 25. Runtime preflight test mock missed the identity resolver - resolved

- **Observed:** the first full unit rerun failed because
  `start-runtime-preflight.test.ts` fully mocked `runtime-store` without the new
  `resolveRuntimePersonIdentity` composition export.
- **Decision:** update the test fixture to model the production composition
  surface. The complete unit and integration suite was rerun after the fix.

## 26. Generated SDK check must not race the clean build - documented

- **Observed:** running `npm run build` and the generated SDK check in parallel
  let the build's clean phase temporarily remove the contracts `dist` directory
  while the generator imported it.
- **Decision:** generated-contract verification runs after `build:contracts` or
  the complete build, not concurrently with the clean phase. The sequential
  generated SDK check passed.

## 27. People app selector drifted from the shared contracts - resolved

- **Observed:** alias-add and person-merge requests accepted `appId` in the
  Control API and SDK, but the shared Zod request schemas omitted the field.
- **Risk:** a caller that parses through `@gantry/contracts` could have `appId`
  stripped and accidentally target the API key's default app.
- **Decision:** `appId` remains the optional, canonical cross-app selector on
  these request bodies. Add it to both shared schemas, remove redundant SDK
  type intersections, and test that parsing preserves the value.

## 28. Person merge audit migration omitted the result payload - resolved

- **Observed:** live merge preview succeeded, but merge apply failed when the
  repository selected `person_merge_audit.result_json` from a database created
  by the checked-in migrations.
- **Root cause:** the active Drizzle schema and repository use `result_json`,
  but migration `0097_person_identity_management` did not create that column.
- **Decision:** add additive migration
  `0100_person_merge_audit_result.sql` so both fresh and already-migrated
  databases converge on the active schema. Keep runtime migration-free and add
  a migration-contract test that asserts the required column is present in the
  migration chain.

## 29. Legacy person ids leaked raw provider aliases into events - resolved

- **Observed:** identity events had no `externalUserId`, phone, email, or memory
  fields, but an older canonical person id used the shape
  `user:<app>:<provider>:<external-id>`. Publishing that id still disclosed the
  raw alias value.
- **Decision:** keep the legacy id internally so session and memory routing are
  not changed during this feature, but omit legacy alias-derived person ids from
  `identity.resolved` and `memory.hydration.decision`. Current opaque
  `person:<hash>` ids continue to be published. A focused runtime test proves
  the full id still routes personal memory while the events contain no raw
  alias value.

## 30. Telegram UI automation lacked macOS permission - documented

- **Observed:** the local runtime, API merge, provider resolution, and Telegram
  bot connection were ready, but the desktop automation layer did not have
  macOS accessibility permission to type into Telegram.
- **Decision:** do not bypass the UI or impersonate a Telegram user through the
  bot API. Complete all automated gates and leave one real user-authored
  Telegram DM as the final cross-provider presentation check.

## 31. Memory tools still advertised cross-scope group writes - resolved

- **Observed:** live-turn hydration correctly kept personal memory out of
  groups, but `memory_save` still told an agent it could request `scope=user`
  from a shared conversation. `procedure_save` exposed the same scope override.
- **Risk:** an agent could write sender-person memory from a group even though
  the product contract says group conversations produce only group/channel
  memory.
- **Decision:** memory writes are fixed to the trusted conversation boundary.
  Runner payloads always use the host-projected default scope, the two tool
  schemas no longer advertise a scope selector, and the host rejects forged
  IPC requests whose requested scope differs from the signed conversation
  scope. Focused tests cover both normal payload construction and host-side
  rejection for DM-to-group and group-to-user overrides.

## 32. Cross-provider personal-memory presentation gate - passed

- **Verification:** a human sent a fresh Telegram DM asking which personal
  preferences were remembered from the Slack DM. The agent recalled the saved
  work routine, response-format preference, and preferred name.
- **Runtime evidence:** persisted inbound and outbound Telegram messages prove
  the real channel path completed. `identity.resolved` recorded canonical
  Telegram provider evidence with successful resolution and eligible memory;
  `memory.hydration.decision` recorded a DM, `reason=resolved`, and eligible
  personal hydration.
- **Privacy evidence:** neither event contained the raw external alias, memory
  contents, or a legacy alias-derived person id.
- **Decision:** this closes the final manual presentation gate. Delivery alone
  is not accepted as identity verification; the persisted assistant response
  and durable identity/hydration decisions must all agree.

## 33. Fresh database setup required explicit Postgres extensions - resolved

- **Observed:** after deleting and recreating the local `gantry` database,
  guided setup failed while preparing memory storage because the `vector` type
  was unavailable. The new database had no database-local extensions.
- **Cause:** `vector` and `pg_trgm` are required capabilities of a Gantry
  Postgres database, but creating a blank database does not install them.
- **Fix applied:** created `vector` and `pg_trgm` in the fresh database, then
  restarted guided setup. The wizard advanced through memory configuration and
  recognized the preserved encrypted OpenRouter credential.
- **Decision:** fresh local database verification must install both extensions
  before guided setup or migrations. This is an environment bootstrap
  prerequisite, not an identity-runtime compatibility path.

## 34. Fresh credential and routing-state preservation - verified

- **Requirement:** reset the local runtime database without losing the Slack,
  Telegram, and OpenRouter setup needed for cross-provider verification.
- **Preservation boundary:** encrypted OpenRouter model credentials, encrypted
  Slack capability secrets, provider-account records, and the non-secret
  settings projection were preserved outside the database and restored into
  the new database. Telegram's runtime bot secret remained in the protected
  runtime `.env`; no secret values were copied into this repository or printed.
- **Verification:** `gantry provider doctor slack`, `gantry doctor`, and
  `gantry status` all passed after restoration. Slack and Telegram connected,
  and the runtime reported the OpenRouter credential as ready.
- **Decision:** future disposable resets must preserve secrets through the
  credential stores/runtime secret lane and restore routing settings through
  `gantry settings import`; do not recreate or paste provider secrets into
  source-controlled files.

## 35. Fresh Slack DM install returned a generic control-plane error - tracked

- **Observed:** discovery found the direct Slack conversation for the preserved
  human sender, but the first `PUT` conversation-install request returned HTTP
  500 with the generic `Control server request failed` response.
- **Scope:** this occurred while adding the fresh DM route for personal-memory
  verification. The already configured Slack channel remained healthy and
  processed live MCP messages.
- **Decision:** do not treat a generic 500 as a successful install. Persist the
  DM route through the supported desired-state settings import path, restart,
  and verify that the route survives startup before using it for personal
  memory tests. The underlying control-plane error remains a follow-up until a
  focused route test exposes its specific cause.

## 36. DM setup API partially persisted before desired-state sync - repaired

- **Observed:** the DM install and approver API calls returned HTTP 500, but
  their database writes were already present. The failure happened afterward
  during desired-state validation/synchronization, leaving the fresh database
  with a DM install but without its canonical live-route projection.
- **Cause:** the preserved database projection contained duplicate/stale Slack
  conversation records and incomplete approver state. Settings export then
  generated an invalid DM conversation entry and rejected the whole mutation.
- **Repair:** removed only the stale duplicate Slack account/conversation graph,
  restored the approvers from the preserved non-secret settings, and rebuilt the
  canonical Slack DM route for the active provider account. The active Slack
  channel, Telegram DM, credentials, person, and aliases were not removed.
- **Verification:** after launchd restart, startup loaded three conversation
  routes; the Slack DM received a real message, spawned Kimi/OpenRouter, and
  returned a reply. This proves the DM route is live and restart-surviving.
- **Follow-up:** expose the underlying desired-state sync error and make
  conversation install/approver mutations transactional so a 500 cannot leave
  partial configuration behind.
