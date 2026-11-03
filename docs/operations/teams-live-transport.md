# Connect Microsoft Teams

Gantry uses Microsoft Teams SDK (`@microsoft/teams.apps` and
`@microsoft/teams.api`, version 2.1.1) to receive Teams activities on a public HTTPS endpoint, verifies
Microsoft's signature and the bot app audience, checks the configured tenant,
then saves each text message before acknowledging it. The live worker resumes
saved messages through the ordinary agent routing and admission path. Replies
and Adaptive Cards return to the originating conversation and thread.

1. Create a single-tenant Microsoft Entra app and an Azure Bot using its app ID,
   tenant ID and client secret. Enable the Microsoft Teams channel on that bot.
2. Run `gantry provider connect teams`. The command saves encrypted secret
   references and prints the provider account's messaging endpoint path. Existing
   Microsoft Graph discovery permissions and tenant admin consent are used only
   for choosing a channel during setup; the Teams SDK handles live messaging.
3. Give the Azure Bot a public HTTPS messaging endpoint:
   `https://<your-public-host>/v1/providers/teams/<providerAccountId>/activities`.
   Use the exact account alias printed by setup. Route this endpoint to an
   inbound-enabled `live-worker` or the `all` process. The live worker's `ops`
   Control profile mounts it. A separate outbound-only control process returns
   503 without reading activity bodies. A workstation needs an HTTPS tunnel;
   a hosted deployment needs ingress to the live worker's Control listener.
4. Install the bot in the intended Teams conversation using your organization's
   approved Teams app package. Send it a text message, mentioning it in a channel
   where required. Configure the Gantry conversation route and its approvers.
   Only conversation approvers can decide Gantry approval cards. Use Microsoft
   Entra object IDs (GUIDs) for sender policies and approvers. The adapter maps
   authenticated `from.aadObjectId` into the shared sender field for messages and
   card actions; the bot-scoped `29:` ID is a different identity. An activity
   without an Entra ID cannot act as an approver configured by Entra GUID. Native
   bot mentions retain the shared trigger signal after mention text is removed.

Every configured account sharing this bot connection has an independently
addressable saved route. Every authenticated activity refreshes the route's
service URL, tenant, bot identity and conversation type in the canonical
conversation record. Routes survive process restarts. A proactive or scheduled
message requires a previously received activity; Gantry never guesses a service
URL. Thread suffixes are removed from conversation identity, and the root ID is
used for replies.

If delivery says there is no saved route, send a new message to this bot in
Teams and retry. A 401 means the Bot Framework token, signature or app audience
was refused; check the Azure Bot app ID and messaging configuration. A 403 means
the activity tenant differs from Gantry's configured tenant. A 503 means no
inbound client owns that account in this process: check the account alias,
provider enablement and live-worker endpoint. A 500 asks Microsoft to retry
because saving or action handling failed; Gantry retains saved messages for
recovery after routing failures.

An unauthorized card submit gets a short refusal. It leaves the card and waiting
flow intact so a permitted person can decide later. Adaptive Card actions return
Microsoft's invoke envelope; failures contain static recovery guidance. Transport
logs contain only redacted activity type/outcome metadata, never card values,
tokens or credentials.

The Teams SDK stays inside the Teams transport adapter; Gantry's `send_message`
and seven `render_*` tools, shared message and interaction formats, agent engines,
authorization, and durable inbox remain unchanged. SDK authentication bypass
settings cannot disable validation. Only connector-issued tokens are accepted on
this endpoint, binding their signed service URL to the activity; Agent365 Entra
activity ingress is outside this bot transport's scope. SDK diagnostic output is
suppressed because it can include entire activities; Gantry logs fixed outcomes.

The SDK sends to the persisted service URL, adding the thread suffix for channel
replies and encoding conversation and activity IDs in URL paths. Cards, streaming
edits, and proactive delivery use the same saved route after restart. No SDK
conversation object is persisted.

The SDK's MSAL dependency is pinned to patched version 7.1.0 for
[CVE-2026-109461](https://github.com/AzureAD/microsoft-authentication-library-for-js/security/advisories/GHSA-xcx6-jx8p-x3h5).
The SDK HTTP dependencies are pinned to patched `body-parser` 2.4.0 and
`follow-redirects` 1.16.2. The existing sandbox dependency also receives the
`node-forge` 1.4.1 patch required by this pull request's image scan. This transport
uses client credentials, with OAuth user sign-in outside its scope.

This slice supports text, threaded replies, stored-route proactive sends and
Adaptive Card submits. Attachments/files, full history, typing and reactions
remain deferred. Automated proof uses real SDK JWT validation, HTTP, Postgres and
the agent runtime, with Microsoft HTTP endpoints and the model runner faked. No
live Teams tenant, Slack or Telegram check is included.

SDK selection follows Microsoft's
[successor guidance](https://learn.microsoft.com/en-us/microsoftteams/platform/legacy-tools-sdks)
and [custom HTTP server support](https://microsoft.github.io/teams-sdk/typescript/in-depth-guides/server/http-server/).

## Verification record — 2026-11-03

Functional check: The final SDK dependency tree was exercised through real Gantry
HTTP, the production inbox/recovery/admission path and a disposable Postgres
instance. An initial native mention in a trigger-required conversation produced
one same-thread agent reply. After disconnect/reconnect, a fresh client sent a
proactive update using the previously stored route. Missing Entra identity and
another member's approval submits left the prompt pending and its card unchanged;
the configured Entra approver then resolved the decision and updated the card.
Only Microsoft's HTTP services and the model runner were faked. All three
end-to-end scenarios passed; no live tenant check was performed.

Proof list:

| Promised result | Owner proof and detailed requirements | Observed result |
|---|---|---|
| Inbound text and same-thread reply | `apps/core/test/e2e/teams-live-transport.postgres.e2e.test.ts`: `answers inbound text in the originating Teams conversation and thread`; requires a native mention and a permitted Entra sender, observes persistence and production recovery/admission. | Passed. |
| Restart-safe proactive delivery | Same end-to-end file: `delivers a proactive message through a fresh client using the previously saved Teams route`. `apps/core/test/integration/teams-conversation-routing.postgres.integration.test.ts`: `remembers refreshed routes for sibling accounts across canonical saves and reloads without crossing connections` owns route refresh, aliases, reload and isolation. | Both passed on disposable Postgres. |
| Authorized approval/action | Same end-to-end file: `keeps an approval pending after an unauthorized card submit and lets a permitted person decide`; distinct bot-scoped and Entra identities, missing/spoofed card identity denial, authorized resolution and card update. | Passed. |
| Authenticated ingress and durable acknowledgement | `apps/core/test/unit/channels/teams/live-transport.test.ts`: token rejection cases cover unsigned, wrong audience, issuer, expiry, service URL and signature; tenant refusal, outbound-only/stopped aliases, and `waits for inbound save and returns a safe non-success response when saving fails`. Real SDK validation is used. | Passed. |
| Delivery, card protocol and private errors | Same transport file: message/invoke envelope cases, HTTP error redaction, 413 split retry and `updates the sent Adaptive Card at its exact conversation, thread and activity path`. | Passed. |
| SDK dependency image gate | Required `.github/workflows/image.yml` Trivy `image` job on [the pull request](https://github.com/knacklabs/gantry/pull/625). Patched MSAL, body-parser, follow-redirects and node-forge pins address its previously reported vulnerabilities. | GitHub scan remains required; its final result must be checked on the latest commit. |

The full local test run passed 9,393 unit tests and 96 integration tests.
Database-dependent suites were skipped in that default run; the route test and
all three Teams end-to-end scenarios above were run separately with a real test
URL. The full build, architecture, formatting, changed-file lint, TypeScript and
migration-history checks passed. Temporarily removing either identity or mention
repair made its end-to-end regression fail; repaired files were restored.
