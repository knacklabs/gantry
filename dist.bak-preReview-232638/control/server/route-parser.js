export function parseSessionRoute(pathname) {
    const baseMatch = /^\/v1\/sessions\/([^/]+)$/.exec(pathname);
    if (baseMatch) {
        return { sessionId: decodeURIComponent(baseMatch[1]), action: 'get' };
    }
    const respondMatch = /^\/v1\/sessions\/([^/]+)\/interactions\/([^/]+)\/respond$/.exec(pathname);
    if (respondMatch) {
        return {
            sessionId: decodeURIComponent(respondMatch[1]),
            action: 'interaction-respond',
            interactionId: decodeURIComponent(respondMatch[2]),
        };
    }
    const match = /^\/v1\/sessions\/([^/]+)\/(messages|events|wait|interactions)$/.exec(pathname);
    const runsMatch = /^\/v1\/sessions\/([^/]+)\/runs$/.exec(pathname);
    if (runsMatch) {
        return {
            sessionId: decodeURIComponent(runsMatch[1]),
            action: 'runs',
        };
    }
    if (!match)
        return null;
    return {
        sessionId: decodeURIComponent(match[1]),
        action: match[2],
    };
}
export function parseJobRoute(pathname) {
    const eventsMatch = /^\/v1\/jobs\/([^/]+)\/events$/.exec(pathname);
    if (eventsMatch) {
        return {
            jobId: decodeURIComponent(eventsMatch[1]),
            action: 'events',
        };
    }
    const actionMatch = /^\/v1\/jobs\/([^/]+)\/(pause|resume|trigger)$/.exec(pathname);
    if (actionMatch) {
        return {
            jobId: decodeURIComponent(actionMatch[1]),
            action: actionMatch[2],
        };
    }
    const baseMatch = /^\/v1\/jobs\/([^/]+)$/.exec(pathname);
    if (!baseMatch)
        return null;
    return {
        jobId: decodeURIComponent(baseMatch[1]),
        action: 'get',
    };
}
export function parseTriggerWaitRoute(pathname) {
    const match = /^\/v1\/triggers\/([^/]+)\/wait$/.exec(pathname);
    return match ? decodeURIComponent(match[1]) : null;
}
export function parseRunRoute(pathname) {
    const match = /^\/v1\/runs\/([^/]+)$/.exec(pathname);
    return match ? decodeURIComponent(match[1]) : null;
}
export function parseRunEventsRoute(pathname) {
    const match = /^\/v1\/runs\/([^/]+)\/events$/.exec(pathname);
    return match ? decodeURIComponent(match[1]) : null;
}
export function parseWebhookRoute(pathname) {
    const actionMatch = /^\/v1\/webhooks\/([^/]+)\/(test|replay-dead-letter|purge-dead-letter)$/.exec(pathname);
    if (actionMatch) {
        return {
            webhookId: decodeURIComponent(actionMatch[1]),
            action: actionMatch[2],
        };
    }
    const baseMatch = /^\/v1\/webhooks\/([^/]+)$/.exec(pathname);
    if (!baseMatch)
        return null;
    return {
        webhookId: decodeURIComponent(baseMatch[1]),
        action: 'delete',
    };
}
export function parseProviderAccountRoute(pathname) {
    const discoverMatch = /^\/v1\/provider-accounts\/([^/]+)\/discover-conversations$/.exec(pathname);
    if (discoverMatch) {
        return {
            providerAccountId: decodeURIComponent(discoverMatch[1]),
            action: 'discover',
        };
    }
    const baseMatch = /^\/v1\/provider-accounts\/([^/]+)$/.exec(pathname);
    if (!baseMatch)
        return null;
    return {
        providerAccountId: decodeURIComponent(baseMatch[1]),
        action: 'get',
    };
}
export function parseConversationRoute(pathname) {
    const actionMatch = /^\/v1\/conversations\/([^/]+)\/(threads|messages)$/.exec(pathname);
    if (actionMatch) {
        return {
            conversationId: decodeURIComponent(actionMatch[1]),
            action: actionMatch[2],
        };
    }
    const baseMatch = /^\/v1\/conversations\/([^/]+)$/.exec(pathname);
    if (!baseMatch)
        return null;
    return {
        conversationId: decodeURIComponent(baseMatch[1]),
        action: 'get',
    };
}
export function parseConversationInstallRoute(pathname) {
    const installMatch = /^\/v1\/agents\/([^/]+)\/conversation-installs\/([^/]+)$/.exec(pathname);
    if (installMatch) {
        return {
            agentId: decodeURIComponent(installMatch[1]),
            conversationId: decodeURIComponent(installMatch[2]),
            action: 'install',
        };
    }
    const listMatch = /^\/v1\/agents\/([^/]+)\/conversation-installs$/.exec(pathname);
    if (!listMatch)
        return null;
    return {
        agentId: decodeURIComponent(listMatch[1]),
        action: 'list',
    };
}
