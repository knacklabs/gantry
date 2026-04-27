export type SessionRoute = {
  sessionId: string;
  action: 'get' | 'messages' | 'events' | 'wait' | 'runs';
};

export type JobRoute =
  | { jobId: string; action: 'pause' | 'resume' | 'trigger' }
  | { jobId: string; action: 'get' | 'delete' | 'update' };

export type WebhookRoute = {
  webhookId: string;
  action: 'delete' | 'test' | 'replay-dead-letter' | 'purge-dead-letter';
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
  const selected = match ?? runsMatch;
  if (!selected) return null;
  return {
    sessionId: decodeURIComponent(selected[1]!),
    action: selected[2] as SessionRoute['action'],
  };
}

export function parseJobRoute(pathname: string): JobRoute | null {
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
