import { nowIso } from '../../shared/time/datetime.js';
import { findConversationRoutesForChat } from '../../shared/thread-queue-key.js';
import { buildTriggerPattern, triggerForRoute, } from '../../shared/trigger-pattern.js';
export async function ingestSlackSlashCommand(input) {
    const channelId = input.command.channel_id;
    if (!channelId)
        return;
    const jid = `sl:${channelId}`;
    const chatName = await input.resolveChannelName(channelId);
    await input.opts.onChatMetadata(jid, nowIso(), chatName, 'slack', input.isLikelyGroupConversation(channelId), { providerAccountId: input.opts.providerAccountId });
    const routes = input.opts.conversationRoutes();
    const providerAccountIds = input.opts.inboundProviderAccountIds?.length && input.opts.providerAccountId
        ? input.opts.inboundProviderAccountIds
        : [input.opts.providerAccountId];
    const routeMatches = providerAccountIds.flatMap((providerAccountId) => findConversationRoutesForChat(routes, jid, null, providerAccountId).map((match) => [...match, providerAccountId]));
    const text = input.command.text?.trim();
    let content = text ? `/gantry ${text}` : '/gantry';
    let selectedRouteMatches = routeMatches;
    if (input.isLikelyGroupConversation(channelId)) {
        if (routeMatches.length === 0)
            return;
        if (routeMatches.length > 1) {
            if (!text)
                return;
            const selector = text.split(/\s+/, 1)[0];
            const selected = routeMatches.filter(([, route]) => buildTriggerPattern(triggerForRoute(route)).test(selector));
            if (selected.length !== 1)
                return;
            selectedRouteMatches = selected;
            const rest = text.slice(selector.length).trim();
            content = `${triggerForRoute(selected[0][1])} /gantry${rest ? ` ${rest}` : ''}`;
        }
    }
    const selectedProviderAccountIds = new Set(selectedRouteMatches.map(([, , providerAccountId]) => providerAccountId));
    const messageProviderAccountId = selectedProviderAccountIds.size === 1
        ? [...selectedProviderAccountIds][0]
        : input.opts.providerAccountId;
    const id = input.command.command_id ||
        input.command.trigger_id ||
        `gantry:${channelId}:${Date.now()}`;
    await input.opts.onMessage(jid, {
        id,
        chat_jid: jid,
        provider: 'slack',
        ...(messageProviderAccountId
            ? { providerAccountId: messageProviderAccountId }
            : {}),
        sender: input.command.user_id || 'unknown',
        sender_name: (input.command.user_id
            ? await input.resolveUserName(input.command.user_id)
            : input.command.user_name) ||
            input.command.user_name ||
            input.command.user_id ||
            'unknown',
        content,
        timestamp: nowIso(),
        is_from_me: false,
        external_message_id: id,
    });
}
