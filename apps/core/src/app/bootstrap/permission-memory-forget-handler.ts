import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import type {
  MemoryForgetMessageActionInput,
  MessageActionOutcome,
  OnMemoryForgetMessageAction,
} from '../../domain/message-actions.js';
import type { ConversationRoute } from '../../domain/types.js';
import { appIdFromConversationJid } from '../../shared/app-conversation-jid.js';
import { resolveConversationRoute } from './runtime-app-routes.js';
import {
  PERMISSION_MEMORY_NOT_FOUND,
  permissionMemoryForgot,
  permissionMemoryListView,
  permissionMemoryScopeLabel,
  resolvePermissionMemoryAgentRouteKey,
  type UsedByJobReader,
} from '../../application/permissions/permission-memory-listing.js';
import { HumanDecisionMemoryService } from '../../application/permissions/human-decision-memory-service.js';

const alreadyForgotten = (): MessageActionOutcome => ({
  state: 'stale',
  receipt: 'Already forgotten.',
});
const notFound = (): MessageActionOutcome => ({
  state: 'invalid',
  receipt: PERMISSION_MEMORY_NOT_FOUND,
});

export function createMemoryForgetHandler(input: {
  getConversationRoutes: () => Record<string, ConversationRoute>;
  resolvePerson: (
    action: MemoryForgetMessageActionInput,
    route: ConversationRoute,
  ) => Promise<string | undefined>;
  resolvePermissionMode: (route: ConversationRoute) => string;
  service: HumanDecisionMemoryService;
  usedBy: UsedByJobReader;
  timezone: string;
}): OnMemoryForgetMessageAction {
  return async (action) => {
    const routes = input.getConversationRoutes();
    const agentId = resolvePermissionMemoryAgentRouteKey(
      action.agentRouteKey,
      new Set(
        Object.values(routes).map(
          (route) => route.agentId ?? agentIdForFolder(route.folder),
        ),
      ),
    );
    if (!agentId) return notFound();
    const route = resolveConversationRoute(
      routes,
      action.conversationJid,
      action.threadId,
      agentId,
      action.providerAccountId,
    );
    if (!route || route.conversationKind !== 'dm') return notFound();
    const appId = appIdFromConversationJid(action.conversationJid);
    if (!appId) return notFound();
    const personId = await input.resolvePerson(action, route);
    if (!personId) return notFound();
    const rows = await input.service.list({
      appId,
      agentFolder: route.folder,
      actingPersonId: personId,
      includeRevoked: true,
    });
    const row = rows.find((entry) => entry.id === action.recordId);
    if (!row) return notFound();
    if (row.revokedAt) return alreadyForgotten();
    const revoked = await input.service.revoke({
      appId,
      agentFolder: route.folder,
      actingPersonId: personId,
      recordId: row.id,
    });
    if (revoked === 'already_revoked') return alreadyForgotten();
    if (revoked !== 'applied') return notFound();
    const activeRows = await input.service.list({
      appId,
      agentFolder: route.folder,
      actingPersonId: personId,
    });
    return {
      state: 'applied',
      receipt: permissionMemoryForgot(permissionMemoryScopeLabel(row)),
      permissionMemoryListView: permissionMemoryListView({
        modeLine: input.resolvePermissionMode(route),
        rows: activeRows,
        agentId,
        timezone: input.timezone,
        usedBy: await input.usedBy(activeRows.map((entry) => entry.id)),
      }),
    };
  };
}
