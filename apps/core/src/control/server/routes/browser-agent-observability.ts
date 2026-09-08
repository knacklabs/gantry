import type { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import { sendError, sendJson } from '../http.js';

const AGENT_AUDIT_PATH = /^\/ui\/api\/agents\/([^/]+)\/audit$/;
const AGENT_USAGE_PATH = /^\/ui\/api\/agents\/([^/]+)\/usage$/;

type RuntimeStorage = ReturnType<typeof getRuntimeStorage>;

export async function handleBrowserAgentObservabilityRoutes(input: {
  res: import('node:http').ServerResponse;
  pathname: string;
  url: URL;
  storage: RuntimeStorage;
  appId: AppId;
}): Promise<boolean> {
  const auditMatch = input.pathname.match(AGENT_AUDIT_PATH);
  if (auditMatch) {
    const agentId = decodeURIComponent(auditMatch[1]!) as AgentId;
    const agent = await input.storage.repositories.agents.getAgent(agentId);
    if (!agent || agent.appId !== input.appId)
      return (sendError(input.res, 404, 'NOT_FOUND', 'Agent not found.'), true);
    const events =
      await input.storage.repositories.runtimeEvents.listRuntimeEvents({
        appId: input.appId,
        agentId,
        limit: 100,
      });
    sendJson(input.res, 200, {
      events: events.map((event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        actor: event.actor,
        conversationId: event.conversationId ?? null,
        createdAt: event.createdAt,
      })),
    });
    return true;
  }
  const usageMatch = input.pathname.match(AGENT_USAGE_PATH);
  if (!usageMatch) return false;
  const agentId = decodeURIComponent(usageMatch[1]!) as AgentId;
  const agent = await input.storage.repositories.agents.getAgent(agentId);
  if (!agent || agent.appId !== input.appId)
    return (sendError(input.res, 404, 'NOT_FOUND', 'Agent not found.'), true);
  const now = new Date();
  const from = new Date(now);
  if (input.url.searchParams.get('range') === 'today') {
    from.setUTCHours(0, 0, 0, 0);
  } else {
    from.setUTCDate(from.getUTCDate() - 6);
    from.setUTCHours(0, 0, 0, 0);
  }
  const usage = await input.storage.repositories.runtimeEvents.queryUsage({
    appId: input.appId,
    agentId,
    from: from.toISOString(),
    to: now.toISOString(),
    groupBy: 'day',
  });
  sendJson(input.res, 200, { usage });
  return true;
}
