# Slack app installation

Gantry's Slack bot installation requests these bot scopes:

`chat:write`, `files:read`, `files:write`, `canvases:read`,
`canvases:write`, `app_mentions:read`, `channels:read`, `channels:history`,
`groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, and
`mpim:history`.

The canonical machine-readable list is `SLACK_APP_MANIFEST` in
`apps/core/src/cli/slack-install-scopes.ts`; both setup flows render that same
list. Existing workspace installations do not automatically receive newly
added scopes. Add the missing scopes in Slack app settings, reinstall the app
to the workspace, copy the new Bot User OAuth token, and run `gantry doctor`
again.

For installer-based channel onboarding, merge these exact entries into the
Slack app manifest. Keep the existing bot events and scopes alongside them:

```yaml
oauth_config:
  scopes:
    bot:
      - channels:read
      - groups:read
settings:
  event_subscriptions:
    bot_events:
      - member_joined_channel
```

`member_joined_channel` supplies `event.inviter` when Slack knows who invited
the bot. Gantry auto-registers the channel only when that inviter is already a
DM-established person. If `inviter` is absent or unrecognised, Gantry posts the
manual-setup message in the channel and seeds nobody. After changing the event
subscription or scopes, reinstall the app so Slack applies the manifest.

Canvas reads use Slack's canvas-as-file export: Gantry obtains `url_private`
through `files.info`, downloads it with the bot bearer token, and returns only
bounded text. The live export smoke remains deferred until the test workspace
is reinstalled with `files:read`; runtime `missing_scope` and export failures
remain explicit rather than silently returning partial content.
