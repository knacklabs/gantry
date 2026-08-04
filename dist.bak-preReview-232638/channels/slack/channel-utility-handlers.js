import { logger } from '../../infrastructure/logging/logger.js';
export function registerSlackUtilityHandlers(app) {
    app.event('app_home_opened', async (args) => {
        const event = args.event;
        if (!event.user)
            return;
        try {
            await app.client.views.publish({
                user_id: event.user,
                view: {
                    type: 'home',
                    blocks: [
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: '*Gantry Slack Channel*\\nUse threaded replies for the best agent UX.',
                            },
                        },
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: 'Use `gantry agent add sl:<channel-id>` to bind additional Slack chats.',
                            },
                        },
                    ],
                },
            });
        }
        catch (err) {
            logger.debug({ err }, 'Failed to publish Slack App Home');
        }
    });
    app.shortcut('gantry_open_home', async (args) => {
        await args.ack();
        const triggerId = args.shortcut?.trigger_id;
        if (!triggerId)
            return;
        try {
            await app.client.views.open({
                trigger_id: triggerId,
                view: {
                    type: 'modal',
                    title: { type: 'plain_text', text: 'Gantry' },
                    close: { type: 'plain_text', text: 'Close' },
                    blocks: [
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: 'Use `gantry agent add sl:<channel-id>` to bind new Slack chats.',
                            },
                        },
                    ],
                },
            });
        }
        catch (err) {
            logger.debug({ err }, 'Failed to open Slack shortcut modal');
        }
    });
    app.shortcut('gantry_reply_with_context', async (args) => {
        await args.ack();
        const shortcut = args.shortcut;
        const channelId = shortcut.channel?.id;
        const userId = shortcut.user?.id;
        if (!channelId || !userId)
            return;
        try {
            await app.client.chat.postEphemeral({
                channel: channelId,
                user: userId,
                text: shortcut.message?.thread_ts
                    ? 'Reply in this thread to continue with Gantry context.'
                    : 'Start a thread first, then reply to keep context grouped.',
            });
        }
        catch (err) {
            logger.debug({ err }, 'Failed to respond to Slack message shortcut');
        }
    });
}
