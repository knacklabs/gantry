# Connect Microsoft Teams

Gantry receives Bot Framework activities on a public HTTPS endpoint, verifies
Microsoft's signature and the bot app audience, checks the configured tenant,
then saves each text message before acknowledging it. The live worker resumes
saved messages through the ordinary agent routing and admission path. Replies
and Adaptive Cards return to the originating conversation and thread.

1. Create a single-tenant Microsoft Entra app and an Azure Bot using its app ID,
   tenant ID and client secret. Enable the Microsoft Teams channel on that bot.
2. Run `gantry provider connect teams`. The command saves encrypted secret
   references and prints the provider account's messaging endpoint path. Existing
   Microsoft Graph discovery permissions and tenant admin consent are used only
   for choosing a channel during setup; Bot Framework handles live messaging.
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
   Only conversation approvers can decide Gantry approval cards.

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

The archived `botbuilder` SDK is confined to the Teams SDK adapter. This slice
supports text, threaded replies, stored-route proactive sends and Adaptive Card
submits. Attachments/files, full history, typing and reactions remain deferred.
No live Teams tenant check was required for this change; automated proof uses
real JWT validation, HTTP, Postgres and the agent runtime, with Microsoft and
model endpoints replaced at their external boundary.
