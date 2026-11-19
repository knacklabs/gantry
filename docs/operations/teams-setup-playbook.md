# Connect a Gantry bot to Microsoft Teams

Follow these steps to mention your bot in a Teams channel and receive a Gantry reply. Teams web is enough; you do not need the desktop app.

Use a Gantry runtime reserved for this test bot. Create a separate agent and channel account for the new bot. Keep other bots and business teams separate.

Allow about **45 to 75 minutes** when accounts and permissions are ready. This is a planning estimate; waiting for an administrator can take longer.

## What each part does

| Part             | Simple meaning                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Gantry           | Runs your agent and generates replies.                                                        |
| Azure Bot        | Gives Microsoft the bot's identity and delivery address.                                      |
| App registration | Holds the bot's app ID, password and permissions. Azure can create it while creating the bot. |
| Teams app        | Adds that bot to your team. It does not run the bot itself.                                   |
| Tunnel           | Gives a running local Gantry a temporary public HTTPS address.                                |

## Before you start

Have these ready:

- Your work or school Microsoft account with Teams access.
- An Azure subscription where you may create an Azure Bot and app registration.
- Permission to upload a custom Teams app and add it to your own test team.
- A running Gantry with its console open and a model credential configured.
- A tenant administrator who can approve the requested Microsoft Graph application permissions.

Keep a private setup note with the bot name, app ID and tenant ID. Save passwords in a password manager and enter them directly into Gantry's credential fields.

## 1 Create a separate test team

1. Open [Teams web](https://teams.microsoft.com/).
2. Select **Chat** on the left, or **Teams** if you use the separate view. Above the chat/channel list, select **New items → New team**.
3. Name it **Gantry Test**, or another clear test name, and choose **Private**.
4. Name its first channel **Testing**, then select **Create**. If you need to add it afterward, use the test team's **… → Add channel** and choose **Standard**.
5. Keep that team and channel open. You will select them again later.

A private **team** with a standard **channel** is the combination used here. [Microsoft team creation instructions](https://support.microsoft.com/en-us/teams/teams-channels/create-a-team-from-scratch-in-microsoft-teams).

## 2 Create the Azure Bot

1. Open [Azure Portal](https://portal.azure.com/).
2. Select **Create a resource**, search for **Azure Bot**, and select **Create**.
3. Give the bot a unique name, such as **my-gantry-test**.
4. Choose your subscription and a resource group reserved for this test.
5. Select the **F0** free pricing tier.
6. Under **Microsoft App ID**, choose **Single Tenant** and **Create new Microsoft App ID**. If your organization requires an existing registration, use the app ID your administrator provides.
7. Select **Review + create**, review the details and terms, then select **Create**.
8. When deployment finishes, select **Go to resource → Configuration**.
9. Copy **Microsoft App ID** and **App Tenant ID** into your setup note.

Creating the app ID here creates the app registration behind the scenes. You can skip creating it separately. You still use that registration to manage the secret and permissions. [Microsoft Azure configuration instructions](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/teams/azure-configuration).

## 3 Create the bot password

1. In the bot's **Configuration** page, select **Manage** beside Microsoft App ID. If that link is absent, open **Microsoft Entra ID → App registrations**, then find this exact bot by its app ID.
2. Open **Certificates & secrets → New client secret**.
3. Enter a description and choose an expiry allowed by your organization.
4. Select **Add**. Copy the secret's **Value** immediately and save it privately.
5. Record its expiry date.

**Value** is the password Gantry needs. **Secret ID** is a different field and will not work. [Microsoft credential instructions](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration#to-generate-a-new-password).

You now have three values: **client ID** (the Microsoft App ID), **tenant ID**, and **client secret Value**.

## 4 Prepare the administrator's short step

Do this preparation yourself:

1. In this bot's app registration, open **API permissions → Add a permission → Microsoft Graph → Application permissions**.
2. Add **Team.ReadBasic.All** and **Channel.ReadBasic.All**.
3. Copy the browser link to this exact app's **API permissions** page.
4. Send that link to your administrator with the message below. Replace the bracketed bot name.

> Please approve permissions for a test application:
>
> 1. Open [Azure Portal](https://portal.azure.com) and select our organization.
> 2. Open **App registrations → All applications**.
> 3. Search by **Application ID: [the new bot’s client ID]**.
> 4. Open it → **API permissions**.
> 5. Review **Team.ReadBasic.All** and **Channel.ReadBasic.All**, then click **Grant admin consent** and confirm.

Replace the bracketed client ID before sending. You prepare the requests; the administrator only reviews and approves them.

The administrator does not need to install Teams or configure the bot. They need a role permitted to grant these application permissions. After they finish, refresh your page: both permissions should show **Granted** in green. A faded consent button usually means your account cannot grant that consent. [Microsoft consent instructions](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent).

These permissions support Gantry's team/channel selection. Live bot messages use the Teams bot connection.

## 5 Enable the Teams channel in Azure

1. Return to your **Azure Bot** resource.
2. Open **Channels** and select **Microsoft Teams**.
3. Choose the commercial Microsoft Teams option for an ordinary work tenant.
4. Review any displayed terms, apply the configuration, and confirm that Microsoft Teams appears in the connected channels list.

## 6 Connect the bot in Gantry

Allow **5–10 minutes**, excluding the private secret step and approval waits.

1. Check that **Model providers** shows an approved provider with a saved credential. Enter a model API key privately if needed.
2. Open **Directory → Onboard an AI employee**. Enter a new name and choose a small model available through your configured provider. Choose **Generalist** for the connection test, then **Continue & save**.
3. Select **Skip for now** for optional **Sources** and **Capabilities**.
4. In **Channel account**, choose **Teams** and a new account label. Enter the new Azure client ID and tenant ID. Privately paste the client secret **Value** and select **Save account**.
5. Leave the wizard at **Conversation** while preparing the public endpoint and Teams app. Do not choose an unrelated channel.

The messaging endpoint path is:

```text
/v1/providers/teams/YOUR-GANTRY-ACCOUNT-ID/activities
```

Use the new Gantry account ID from the saved account’s details. It is different from Azure’s client ID. Gantry stores the secret encrypted. The computer owner must use a build containing current Teams onboarding fixes; account creation alone does not install the agent in a conversation.

## 7 Start a free tunnel for local testing

If Gantry already has a hosted HTTPS bot endpoint, use that address and skip the local tunnel commands below.

For local Gantry, install `cloudflared` using [Cloudflare's official download instructions](https://developers.cloudflare.com/tunnel/downloads/). You also need Node.js, already required by Gantry.

Find Gantry's port in your console address. For example, `http://127.0.0.1:3941/ui/...` means its port is **3941**.

Open a terminal in your Gantry folder. Start the included bot-only proxy:

```bash
node docs/operations/examples/teams-activity-proxy.mjs "/v1/providers/teams/YOUR-GANTRY-ACCOUNT-ID/activities" 3941 3942
```

Replace the path with the exact one printed by Gantry. Replace **3941** if your Gantry uses another port. **3942** is the proxy port; choose another unused port if needed. Leave this terminal running.

In a second terminal, start the free tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:3942 --protocol http2
```

If you changed the proxy port, use that same port here. Copy the printed `https://...trycloudflare.com` address. Leave this terminal running too.

The proxy forwards only the exact bot activity endpoint. Gantry still verifies Microsoft's authentication. Other paths, including Gantry's console, return **404** through this tunnel.

Quick Tunnels need no Cloudflare account or domain. Their address is temporary and changes when recreated. [Cloudflare Quick Tunnel instructions](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## 8 Save the full messaging endpoint in Azure

1. Combine the tunnel address and Gantry's path. The result looks like:

   `https://YOUR-TUNNEL-HOST/v1/providers/teams/YOUR-GANTRY-ACCOUNT-ID/activities`

2. Open **Azure Bot → Configuration**.
3. Paste that complete HTTPS address into **Messaging endpoint** and save.
4. Keep Gantry, the proxy and the tunnel running while testing.

When a free tunnel expires or is recreated, save its new address here again. Keep the path unchanged unless the Gantry account changes.

## 9 Create and install the Teams app

1. Open [Developer Portal for Teams](https://dev.teams.microsoft.com/apps).
2. Create a new app with a recognizable test name, such as **Gantry Teams Test**.
3. Complete its required basic information, including developer name, website, privacy policy URL, and terms of use URL. Use your organization's real pages.
4. Keep valid default icons or supply the required color and outline icons.
5. Open **App features → Bot**, choose **Enter a bot ID**, and paste Azure's **Microsoft App ID**.
6. Enable **Team** scope. Keep **notification-only** mode off so the bot can receive messages.
7. Open **App content → Channel support**, select **My app supports all channels (tier1)** and save. This declaration does not mean private/shared channels have been tested; use a standard channel here.
8. Under **Basic information**, set **Application (client) ID** to the Azure bot’s client ID. Under **Permissions → Team permissions**, request **ChannelMember.Read.Group** with type **Application**. Save. Gantry uses it to verify that the approver belongs to the selected channel.
9. An authorized team owner reviews this member-read access during installation. It applies only to the installed team and does not grant message reading. If organization policy blocks consent, stop for the Teams administrator; do not add organization-wide member permissions as a workaround.
10. Save and validate the app. An editor **Save** may only stage the edit; complete the app **Update** and confirmation too. Increase the version when updating an installed package. Keep the same app ID and bot ID.
11. Download this app’s ZIP from **App package editor**. It must contain `manifest.json`, the color icon and the outline icon at the ZIP root.
12. In the separate test team, open **More team options → Manage team → Apps → Upload an app**, and choose the ZIP. Review the exact app name, developer, policies and permissions. An authorized person accepts any displayed agreement.
13. Select the visible **Add** button, choose **Gantry Test / Testing**, check both names, then **Go**. Confirm that the app is listed under that team’s **Apps**.

The two Entra discovery permissions do not grant channel-member access. [Microsoft’s channel-members permission reference](https://learn.microsoft.com/en-us/graph/api/channel-list-members?view=graph-rest-1.0) identifies **ChannelMember.Read.Group** as the least privileged application permission. [Microsoft’s scoped-consent instructions](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/declare-resource-specific-consent-requirements) explain the client ID and installation grant.

An updated ZIP alone does not prove a new permission is granted. If member verification still fails, check this exact team’s consent. Reinstall only a clearly disposable test app with its owner’s approval; preserve production apps and other bots.

## 10 Finish Gantry onboarding

Allow **3–6 minutes** after permissions are ready.

1. Return to **Conversation**, select **Discover conversations**, then choose only the new test team’s **Testing** channel. Keep memory scope **Conversation**.
2. Continue to **Approvals**. Enter the Microsoft Entra user **Object ID** of a real team member authorized to approve actions. Find it under **Microsoft Entra ID → Users → that user → Overview**, or ask the identity administrator for it. It differs from the app ID, team ID, email address and bot-scoped IDs beginning with `29:`.
3. Select **Verify member IDs**. Continue only when verification succeeds. A Graph access error needs the scoped permission or policy fixed; do not bypass verification or seed database records.
4. Review the new agent, small model, account, channel and approver. Select **Save installation**.
5. Verify one active installation for the selected channel and that the chosen role/model remain selected. If the save fails or duplicates appear, update Gantry with the onboarding repairs before proceeding.

The Teams package contains configuration and icons; Gantry runs the bot. [Microsoft app package instructions](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/apps-package), [channel feature settings](https://learn.microsoft.com/en-us/microsoftteams/platform/build-apps-for-shared-private-channels).

## 11 Send one tiny test

1. Open your **Testing** channel in Teams.
2. Type `@`, start typing the bot's name, and select **Gantry Teams Test** from the suggestions. This creates a real bot mention.
3. Add `Reply only OK.` and send.
4. Check for the bot's **OK** reply in the same thread. The successful live check during this setup took about five seconds after Gantry started the run; allow longer for the first request.

Mention the bot in every channel message you want it to receive. Plain text that merely looks like a bot name is not a native mention. [Microsoft bot troubleshooting](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/troubleshoot).

## If something goes wrong

| What you see                                                    | What to do                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Manifest says developer URLs are missing                        | Add website, privacy and terms URLs, then save and update the package.                                                                     |
| No teams or channels in Gantry                                  | Recheck the Graph application permissions and green admin consent status.                                                                  |
| Bot absent from mention suggestions                             | Confirm it is installed in this exact team's Apps list.                                                                                    |
| Tunnel address no longer works                                  | Restart the free tunnel and save its new address in Azure.                                                                                 |
| Proxy reports 401 for an unsigned manual request                | Authentication is active; real Teams requests need Microsoft's token.                                                                      |
| Proxy reports 503                                               | Check Gantry is running with Teams enabled and an inbound-capable `all` or `live-worker` process.                                          |
| Proxy reports 502                                               | Recheck Gantry's local port and whether its service is running.                                                                            |
| Azure Web Chat does not reply                                   | This Gantry endpoint accepts Teams activities. Use the installed bot in Teams for the reply test.                                          |
| Native mentions produce no proxy activity, but the tunnel works | Check bot ID and full endpoint. Then refresh the existing Azure Teams channel as described below.                                          |
| Gantry receives the message and sends an error                  | Check the model connection and Gantry's diagnostics. During this setup, a missing OpenAI `/v1` request segment required a Gantry code fix. |

## Refresh a stuck Azure Teams channel

This resolved the live test where the tunnel was healthy but Teams sent no activity. Microsoft recommends restarting the existing Teams channel; deleting and recreating it can invalidate stored bot identity references. [Microsoft restart guidance](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/troubleshoot#my-bot-doesnt-receive-messages-when-testing-locally-over-a-dev-tunnel).

If the portal offers **Restart** for the existing Teams channel, use it. If it has no restart control, ask the person managing Azure to briefly set that existing channel's `isEnabled` property to `false`, then restore it to `true` through a narrowly scoped resource update. Preserve all other settings and verify the restored deployment succeeds. Do not delete the channel. The [ARM channel reference](https://learn.microsoft.com/en-us/azure/templates/microsoft.botservice/botservices/channels) documents that property.

After restoration, send one new native bot mention and check the proxy for a response.

## Keep it working

Keep the computer awake and Gantry, its database, the proxy and tunnel running during the test. Replace the bot secret before its expiry date. Update Azure after recreating a free tunnel. For regular use, give the bot a stable hosted HTTPS endpoint so it does not depend on an open laptop and temporary address.

Completion means this new bot receives its own native Teams mention and replies in the same thread. Live approval cards, proactive messages and Slack are separate follow-up checks.
