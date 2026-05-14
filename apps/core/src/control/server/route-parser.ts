export type SessionRoute = {
  sessionId: string;
  action: 'get' | 'messages' | 'events' | 'wait' | 'runs';
};

export type JobRoute =
  | { jobId: string; action: 'pause' | 'resume' | 'trigger' }
  | { jobId: string; action: 'get' | 'delete' | 'update' | 'events' };

export type WebhookRoute = {
  webhookId: string;
  action: 'delete' | 'test' | 'replay-dead-letter' | 'purge-dead-letter';
};

export type ProviderConnectionRoute = {
  providerConnectionId: string;
  action: 'get' | 'discover';
};

export type ConversationRoute = {
  conversationId: string;
  action: 'get' | 'threads' | 'messages';
};

export type AgentBindingRoute = {
  agentId: string;
  conversationId?: string;
  action: 'list' | 'binding';
};

export function parseSessionRoute(pathname: string): SessionRoute | null {
  const baseMatch = /^\/v1\/sessions\/([^/]+)$/.exec(pathname);
  if (baseMatch) {
    return { sessionId: decodeURIComponent(baseMatch[1]!), action: 'get' };
  }
  const match = /^\/v1\/sessions\/([^/]+)\/(messages|events|wait)$/.exec(
    pathname,
  );
  const runsMatch = /^\/v1\/sessions\/([^/]+)\/runs$/.exec(pathname);
  if (runsMatch) {
    return {
      sessionId: decodeURIComponent(runsMatch[1]!),
      action: 'runs',
    };
  }
  if (!match) return null;
  return {
    sessionId: decodeURIComponent(match[1]!),
    action: match[2] as SessionRoute['action'],
  };
}

export function parseJobRoute(pathname: string): JobRoute | null {
  const eventsMatch = /^\/v1\/jobs\/([^/]+)\/events$/.exec(pathname);
  if (eventsMatch) {
    return {
      jobId: decodeURIComponent(eventsMatch[1]!),
      action: 'events',
    };
  }
  const actionMatch = /^\/v1\/jobs\/([^/]+)\/(pause|resume|trigger)$/.exec(
    pathname,
  );
  if (actionMatch) {
    return {
      jobId: decodeURIComponent(actionMatch[1]!),
      action: actionMatch[2] as 'pause' | 'resume' | 'trigger',
    };
  }
  const baseMatch = /^\/v1\/jobs\/([^/]+)$/.exec(pathname);
  if (!baseMatch) return null;
  return {
    jobId: decodeURIComponent(baseMatch[1]!),
    action: 'get',
  };
}

export function parseTriggerWaitRoute(pathname: string): string | null {
  const match = /^\/v1\/triggers\/([^/]+)\/wait$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function parseRunRoute(pathname: string): string | null {
  const match = /^\/v1\/runs\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function parseRunEventsRoute(pathname: string): string | null {
  const match = /^\/v1\/runs\/([^/]+)\/events$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function parseWebhookRoute(pathname: string): WebhookRoute | null {
  const actionMatch =
    /^\/v1\/webhooks\/([^/]+)\/(test|replay-dead-letter|purge-dead-letter)$/.exec(
      pathname,
    );
  if (actionMatch) {
    return {
      webhookId: decodeURIComponent(actionMatch[1]!),
      action: actionMatch[2] as
        | 'test'
        | 'replay-dead-letter'
        | 'purge-dead-letter',
    };
  }
  const baseMatch = /^\/v1\/webhooks\/([^/]+)$/.exec(pathname);
  if (!baseMatch) return null;
  return {
    webhookId: decodeURIComponent(baseMatch[1]!),
    action: 'delete',
  };
}

export function parseProviderConnectionRoute(
  pathname: string,
): ProviderConnectionRoute | null {
  const discoverMatch =
    /^\/v1\/provider-connections\/([^/]+)\/discover-conversations$/.exec(
      pathname,
    );
  if (discoverMatch) {
    return {
      providerConnectionId: decodeURIComponent(discoverMatch[1]!),
      action: 'discover',
    };
  }
  const baseMatch = /^\/v1\/provider-connections\/([^/]+)$/.exec(pathname);
  if (!baseMatch) return null;
  return {
    providerConnectionId: decodeURIComponent(baseMatch[1]!),
    action: 'get',
  };
}

export function parseConversationRoute(
  pathname: string,
): ConversationRoute | null {
  const actionMatch = /^\/v1\/conversations\/([^/]+)\/(threads|messages)$/.exec(
    pathname,
  );
  if (actionMatch) {
    return {
      conversationId: decodeURIComponent(actionMatch[1]!),
      action: actionMatch[2] as 'threads' | 'messages',
    };
  }
  const baseMatch = /^\/v1\/conversations\/([^/]+)$/.exec(pathname);
  if (!baseMatch) return null;
  return {
    conversationId: decodeURIComponent(baseMatch[1]!),
    action: 'get',
  };
}

export function parseAgentBindingRoute(
  pathname: string,
): AgentBindingRoute | null {
  const bindingMatch =
    /^\/v1\/agents\/([^/]+)\/conversation-bindings\/([^/]+)$/.exec(pathname);
  if (bindingMatch) {
    return {
      agentId: decodeURIComponent(bindingMatch[1]!),
      conversationId: decodeURIComponent(bindingMatch[2]!),
      action: 'binding',
    };
  }
  const listMatch = /^\/v1\/agents\/([^/]+)\/conversation-bindings$/.exec(
    pathname,
  );
  if (!listMatch) return null;
  return {
    agentId: decodeURIComponent(listMatch[1]!),
    action: 'list',
  };
}
