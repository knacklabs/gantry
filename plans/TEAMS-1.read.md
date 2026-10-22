---
reader: claude (opus)
read_at: 2026-10-22T17:34:19+00:00
read_hash: 7bf50a1892e55417c0341bf414594c9f595bfe3f
round: 4
passed: yes
doc_seen: 7bf50a1892e55417c0341bf414594c9f595bfe3f
spec_seen: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
notes_seen: cc62909feef57575b6de21b69d01c0f7b7b6b142
---
# Cold read notes

Written by `forge read`. Under every finding, write one disposition line, amend the doc, then run
`forge read <doc>` again for the next round, until a round finds nothing:

- `Disposition: cut` when the doc was edited to remove it;
- `Disposition: defer` when the item moved to the spec's Out of scope;
- `Disposition: keep <one-line reason>` otherwise.

Only a genuine trade-off goes to the human, as a question with options.

## Round 1

1. Teams is still marked as a setup-only placeholder in a file that no task is allowed to change.
   - `apps/core/src/channels/register-builtins.ts:209` gives Teams the `runtime-placeholder` flag. Because of it, `provider-account-channel-connect.ts:197` stops startup with "transport is not implemented", and `browser-channel-accounts.ts:185/390` shows the channel as disabled.
   - Done-when 1 promises the end of "a configured channel that cannot start", so the flag has to go.
   - Existing tests check for the flag (`channel-wiring.test.ts:1450`, `control-provider-catalog.test.ts:470`).
   - Give the flag removal to T2 alongside the factory cutover, add `register-builtins.ts` to its scope, and add the flag to the cleanup search.

   Disposition: keep T2 now owns the flag removal, affected tests, scope, and cleanup search.

2. Nothing pins how the T3 endpoint reaches the right running Teams client, and the wiring files are outside every scope.
   - T2 and T3 both depend on four things no task defines: the endpoint path, how a request picks its provider account (a path segment or the bot id in the token), the method the route calls on the transport, and the port that hands that method to the control server.
   - The Manipal client used one process-wide `activeClient` behind a single `/v1/providers/teams/activities` path. With two Teams accounts, that design sends both bots' traffic to whichever client started last.
   - The wiring lives in `apps/core/src/app/**` and `control/server/handler-context.ts`, and neither is in scope.
   - T2 must pin all four and take those files into scope.

   Disposition: keep the plan now pins the account-specific path, alias registry, raw-request method, app-root control port, and wiring scope.

3. "Full and live-ingress server profiles" doesn't match the code, and the doc never says which process may answer Teams.
   - Only `'full' | 'ops'` exist. The live-worker runs `ops` and mounts only `/webhooks/...` through `isLiveIngressRoute`. The `control` role runs `full` but has `providerInbound: false`, so its Teams client can only send.
   - Pin one rule: the endpoint processes activities only where the Teams client started with inbound enabled. That means extending `isLiveIngressRoute` for the live-worker. Everywhere else it answers 503 without reading the body.
   - The T3 route test should cover the outbound-only case. As written, a `control` process would accept and silently drop activities.

   Disposition: keep the profile/readiness rule and outbound-only 503 proof are now explicit.

4. Unproven: item 2: routing records keyed by provider account miss accounts that share one bot connection.
   - `connectProviderAccountChannels` groups accounts that use the same credentials. Only the first opens inbound; the others can only send.
   - If T2 writes the record only for the receiving account, a scheduled send from a sibling account fails with "missing route" for a conversation Gantry has seen. T1's "isolate by provider account" test still passes.
   - Pin one rule: write the record for every entry in `inboundProviderAccountIds`, or key it by bot id or connection, as MSG-1 does. Add that case to T1's test.

   Disposition: keep records now fan out to every inbound account alias and the repository test covers shared credentials.

5. T1 doesn't pin the routing record's columns, repository methods or canonical key, but T2 writes and reads them.
   - "The minimum remaining Gantry-owned values" is not a schema. T1 must list the columns (for example: account, canonical conversation id, service URL, tenant id, bot id, channel id, conversation type, updated-at) and the repository method signatures.
   - T1 must also pin the canonical conversation rule. Teams channel-thread replies arrive as `<channel id>;messageid=<root id>`. The suffix is stripped and the root becomes the thread id. Without this rule, T1's key and T2's lookup can disagree.

   Disposition: keep the table columns, primary key, store signatures, and suffix/thread canonicalization are now pinned.

6. Inbound handling has to follow the save-before-acknowledge rule from MSG-1, which is approved and in progress, but this story never mentions it.
   - MSG-1 requires Teams to save a message "before its response" and to pass a failed save back to the transport.
   - Pin it here: the HTTP response goes out only after `onMessage` resolves, and a failed save returns a non-2xx status.
   - Say which story lands first and which one adapts. Add one adapter test where the save fails and no 200 is sent.

   Disposition: keep MSG-1/T16 is now a dependency and the response ordering plus failure case are explicit.

7. Trap: no network in CI: items 1–3. No fake for Microsoft's authentication or message service is pinned, so token checking is unproven.
   - BotBuilder fetches signing keys from `login.botframework.com`, gets outbound tokens from `login.microsoftonline.com`, and posts to the activity's service URL.
   - "Authentication delegation" tests that stub the validator would pass while a wrong app id or audience setting accepts another bot's tokens.
   - T2 must own one local fake: signing keys, a token endpoint and a connector, wired in through BotBuilder's configurable OpenID metadata and OAuth endpoints. T3's end-to-end test reuses it.
   - Include one test with a properly signed token for the wrong audience and one with an unsigned token. Both must get 401 and never reach `onMessage`.

   Disposition: keep T2 now owns the local Microsoft-service fake and both negative authentication cases.

8. Unproven: items 1–2: nothing says what happens to activities from a tenant other than the configured one.
   - The credentials carry a tenant id, but no rule uses it on inbound activities. If the bot registration is multi-tenant, another tenant's users can reach the agent and write routing records.
   - Add one blunt rule: drop any activity whose tenant differs from the configured tenant, before normalizing it or storing a route. One test proves it.

   Disposition: keep tenant equality is now a pre-normalization and pre-storage rule with a focused test.

9. Unproven: item 3: the doc doesn't say what an unauthorized submitter sees, or that the waiting flow keeps waiting.
   - A bug that settles the approval as "deny" when an unauthorized person submits would still pass "unauthorized action refused".
   - Pin it: the refused person gets an invoke response with a short refusal, the card stays unchanged, and the flow is still waiting.
   - The end-to-end case should then have a permitted person approve that same card.

   Disposition: keep the refusal response, unchanged card, pending flow, and later permitted approval are now one owner case.

10. Adding a control-server route requires an `openapi.ts` update, and that file isn't in T3's scope.
    - `control/server/AGENTS.md` requires every new or changed route to update `openapi.ts`.
    - Either add `openapi.ts` to T3's scope, or state why a public Bot Framework endpoint is exempt.

   Disposition: keep the final wiring task now owns the OpenAPI route description.

11. The "existing Teams setup documentation" doesn't exist.
    - Outside the CLI text at `cli/teams.ts:255`, no doc describes Teams setup.
    - Name the doc file to create, or drop docs from T3 and the Surface Impact Matrix and treat the CLI output as the guide.

   Disposition: keep the plan now names `docs/operations/microsoft-teams.md` as the new guide.

12. The doc doesn't name which Manipal branch to port from, which BotBuilder adapter to use, or which credentials the bot uses.
    - Two branches carry `teams-bot-framework-client.ts`: `manipal-changes` and `manipal-uat-changes`.
    - That client used the legacy `BotFrameworkAdapter` with `channelAuthTenant` and read extra `botAppId`, `botAppPassword` and `botTenantId` values. Current `readTeamsCredentials` doesn't read them.
    - Pin the source branch, the adapter (`BotFrameworkAdapter` or `CloudAdapter` set up for a single tenant), and that `client_id`, `client_secret` and `tenant_id` are the bot's own app registration. If the bot needs separate credentials, the "`settings.yaml` unchanged" line is wrong.

   Disposition: keep the plan now pins `manipal-changes`, legacy `BotFrameworkAdapter`, and the existing single-tenant bot app credentials.

13. Split: T2 → two tasks: receiving activities and sending through stored routes.
    - T2 covers authentication, normalization, invoke responses, thread targeting, proactive sends, card sends and updates, log redaction and the Microsoft fake. The historical client alone was 458 lines before tests.
    - T2a "Receive Teams activities": authentication, normalization, invoke responses, writing the routing record and log redaction (items 1, 3). It pins the adapter skeleton and the fake.
    - T2b "Send through stored routes": text, thread replies, proactive sends and cards (items 1, 2).

   Disposition: keep receiving and sending are now separate dependent tasks with the receiving task pinning the shared adapter seam.

14. Trap: the archived SDK meets the PR image vulnerability gate: Risks.
    - `.github/workflows/image.yml` fails a PR on any fixable HIGH or CRITICAL vulnerability.
    - An archived `botbuilder` won't release patched dependencies, so fixes will have to go through root `overrides`.
    - Add this to Risks, and add the image scan to the dependency task's checks.

   Disposition: keep the vulnerability/override risk and image scan are now explicit.

## Round 2

15. T2 adds the control port but can't connect it to the control server, because the file that does that belongs to T4.
    - The app passes control ports through `startControlServer`'s input (`control/server/index.ts:240`), and the same file copies them into the route context (`:465`). `index.ts` is only in T4's scope.
    - As written, T2 changes `app/index.ts` and `handler-context.ts` but can't make them compile together.
    - Simplest fix: T2 builds the adapter-owned inbound-client registry and its `processTeamsActivity` method. T4, which already owns `index.ts` and mounts the route, takes the app-root port, `handler-context.ts` and the server input. This also removes three app and control files from T2, which is the largest task.

    Disposition: keep T2 now owns only the adapter registry while T4 owns the complete app-root and control-server port wiring.

16. T4's scope names the wrong OpenAPI file.
    - `control/server/routes/openapi.ts` only serves the Swagger page.
    - Route paths are documented in `control/server/openapi-routes-core.ts`, where `/v1/providers` lives, and are assembled by `control/server/openapi.ts`.
    - Put the file that holds the paths in T4's scope instead.

    Disposition: keep T4 now owns `control/server/openapi-routes-core.ts`.

17. The check T2 runs for the image vulnerability risk doesn't scan for vulnerabilities.
    - `npm run security:images` runs `scripts/check_runtime_images.py`. That script checks the image for forbidden files such as `.git`, `.env` and private keys. It doesn't run Trivy.
    - The high and critical vulnerability gate runs only in `.github/workflows/image.yml` on the pull request.
    - Name that gate, the image workflow passing on T2's pull request, as T2's proof, and fix the cleanup line to match.

    Disposition: keep the plan now names the Trivy image workflow and explicitly rejects the local image-content check as vulnerability proof.

18. Nothing says how the Teams adapter gets the routing store, and the file that builds Postgres stores is outside every scope.
    - Postgres repositories are constructed in `adapters/storage/postgres/runtime-store.ts`, which no task's scope includes. T1's scope names only the new repository file.
    - Pin who constructs the store and how it reaches the adapter. One option is to build it in `channel-wiring.ts` and pass it through `TeamsChannelDependencies`. T2 and T3 both read it, so T2 must pin this, and add `runtime-store.ts` to T1's scope if the store is registered there.

    Disposition: keep T1 registers the repository in runtime storage and the Teams factory injects its Gantry-owned interface into the SDK client; the BotBuilder client never imports Postgres.

## Round 3

19. T1 implements a store type that no task's scope gives a file to.
    - Done-when 2 pins the store's method signatures, and T2 injects them as `TeamsConversationRouteStore` returning `TeamsConversationRoute`.
    - T1 must implement and register that interface first, but T1's scope covers only the Postgres schema, the repository file and `runtime-store.ts`. The natural home, `channels/teams/types.ts`, belongs to T2, which runs after T1.
    - T1 must name the file that defines both types, and that file must be in T1's scope. For example, it could export them from the repository file or from a new `domain/ports/` file. T2 and T3 then import from there.

    Disposition: keep T1 now owns new adapter-port file `channels/teams/conversation-route-store.ts`, which defines both Gantry-owned route and store types before the Postgres implementation.

20. Trap: the end-to-end test's file name isn't pinned, so it could miss the required database gate.
    - The restart and proactive-send case reads the new Postgres route table.
    - `npm run test:e2e:postgres` only picks up `apps/core/test/e2e/**/*.postgres.e2e.test.ts`, and `apps/core/AGENTS.md` requires every database-backed end-to-end test to run through it.
    - A file named `teams-live-transport.e2e.test.ts` would silently fall into the database-free end-to-end config.
    - Pin the path in T4 as `apps/core/test/e2e/teams-live-transport.postgres.e2e.test.ts`.

    Disposition: keep T4 and verification now pin the Postgres end-to-end file and `test:e2e:postgres` command.

## Round 4

No findings.
