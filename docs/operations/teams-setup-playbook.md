# Connect a Gantry bot to Microsoft Teams

Follow these steps to mention your bot in a Teams channel and receive a Gantry reply. Teams web is enough; you do not need the desktop app.

Use a Gantry runtime reserved for this test bot. This guide connects its **Default Agent**. Keep other bots and business teams separate.

Allow about **30 to 60 minutes** when accounts and permissions are ready. This is a planning estimate; waiting for an administrator can take longer.

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

> Please open this link using the administrator account for our Microsoft tenant. Check that the app is [your bot name] and the requested Microsoft Graph application permissions are Team.ReadBasic.All and Channel.ReadBasic.All. Select “Grant admin consent for our organization” and confirm. Please tell me when both show Granted. I will handle Teams and the rest of the setup.

The administrator does not need to install Teams or configure the bot. They need a role permitted to grant these application permissions. After they finish, refresh your page: both permissions should show **Granted** in green. A faded consent button usually means your account cannot grant that consent. [Microsoft consent instructions](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent).

These permissions support Gantry's team/channel selection. Live bot messages use the Teams bot connection.

## 5 Enable the Teams channel in Azure

1. Return to your **Azure Bot** resource.
2. Open **Channels** and select **Microsoft Teams**.
3. Choose the commercial Microsoft Teams option for an ordinary work tenant.
4. Review any displayed terms, apply the configuration, and confirm that Microsoft Teams appears in the connected channels list.

## 6 Connect the bot in Gantry

First confirm that **Model providers** in Gantry shows a configured provider, and the Default Agent uses a model available through it. For OpenAI, enter your API key in its **Add credential** form if needed.

Then open a terminal in your Gantry folder and run:

```bash
gantry provider connect teams
```

Answer its questions in this order:

| Question                   | What to enter                            |
| -------------------------- | ---------------------------------------- |
| Teams client ID            | Microsoft App ID from Azure.             |
| Teams client secret        | The secret **Value** you saved.          |
| Teams tenant ID            | App Tenant ID from Azure.                |
| Channel selection          | Your **Gantry Test / Testing** channel.  |
| Admin or approver user IDs | Your Microsoft Entra user **Object ID**. |

To find your user Object ID, open **Microsoft Entra ID → Users → your user → Overview**. Copy the Object ID, which looks like a GUID. Use the identity of a person who belongs to the test team. It is different from the app ID and bot-scoped IDs beginning with `29:`.

When setup finishes, copy the **messaging endpoint path** it prints. For example:

```text
/v1/providers/teams/YOUR-GANTRY-ACCOUNT-ID/activities
```

Use the exact account ID printed by Gantry. It is different from Azure's app ID. Gantry stores the bot secret encrypted. Restart your Gantry test runtime after changing its connection settings.

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
7. For the newer channel experience, open **Configure → App package editor**, find `manifest.json`, and select its **… → Edit** menu. Set the top-level `supportsChannelFeatures` value to `"tier1"`. Keep the existing app ID and bot ID unchanged.
8. Save and validate the app. A manifest editor **Save** may only stage the edit: complete the surrounding app **Update** and confirmation too. Increase the app version when updating an installed package.
9. Select **Preview in Teams**, then **Add to a team** when offered.
10. Select **Gantry Test / Testing** and confirm **Add** or **Go**.
11. In that team's **Manage team → Apps**, confirm that **Gantry Teams Test** is listed.

The Teams package contains configuration and icons; Gantry runs the bot. [Microsoft app package instructions](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/apps-package), [channel feature settings](https://learn.microsoft.com/en-us/microsoftteams/platform/build-apps-for-shared-private-channels).

## 10 Send one tiny test

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

Keep the computer awake and the three local services running during the test. Replace the bot secret before its expiry date. Update Azure after recreating a free tunnel. For regular use, give the bot a stable hosted HTTPS endpoint so it does not depend on an open laptop and temporary address.

The live setup verified a native Teams mention, an authenticated activity, a real OpenAI response, and a reply in the original thread. Live approval cards, proactive messages and Slack are separate follow-up checks.
