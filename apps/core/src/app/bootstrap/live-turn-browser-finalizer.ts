import { resolveConversationBrowserProfile } from '../../shared/browser-profile-scope.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import { getProfile } from '../../runtime/browser-profiles.js';
import {
  parseAgentThreadQueueKey,
  parseThreadQueueKey,
} from '../../shared/thread-queue-key.js';
import {
  consumeBrowserProfileActivity,
  isBrowserProfileSyncEnabled,
  snapshotBrowserProfile,
} from '../../runtime/browser-profile-sync.js';
type WarnLog = (context: Record<string, unknown>, message: string) => void;

export interface LiveTurnBrowserFinalizer {
  (input: {
    queueJid: string;
    runId?: string | null;
    fencingVersion?: number;
  }): Promise<void>;
}

function resolveConversationRouteFolder(
  routes: Record<string, { folder: string }>,
  queueJid: string,
): string | undefined {
  const parsedQueue = parseAgentThreadQueueKey(queueJid);
  const candidates = Object.entries(routes)
    .map(([routeKey, route]) => {
      const parsedRoute = parseAgentThreadQueueKey(routeKey);
      return {
        routeKey,
        folder: route.folder,
        chatJid: parsedRoute.chatJid,
        agentId: parsedRoute.agentId,
      };
    })
    .filter((candidate) => candidate.chatJid === parsedQueue.chatJid);

  if (candidates.length === 0) return undefined;
  if (parsedQueue.agentId) {
    const exactMatch = candidates.find(
      (candidate) =>
        (candidate.agentId ?? agentIdForFolder(candidate.folder)) ===
        parsedQueue.agentId,
    );
    if (exactMatch) return exactMatch.folder;
    return undefined;
  }
  candidates.sort((a, b) => {
    const aHasAgent = Boolean(a.agentId);
    const bHasAgent = Boolean(b.agentId);
    if (aHasAgent !== bHasAgent) return aHasAgent ? -1 : 1;
    return a.routeKey.localeCompare(b.routeKey);
  });
  return candidates[0]?.folder;
}

export function buildLiveTurnBrowserFinalizer(deps: {
  getConversationRoutes: () => Record<string, { folder: string }>;
  closeBrowserSession?: (profileName: string) => Promise<unknown>;
  closeBrowserToolBackends?: (profileName: string) => Promise<void>;
  warn: WarnLog;
}): LiveTurnBrowserFinalizer {
  return async (input) => {
    const { chatJid } = parseThreadQueueKey(input.queueJid);
    const folder = resolveConversationRouteFolder(
      deps.getConversationRoutes(),
      input.queueJid,
    );
    if (!folder) return;
    const profileName = resolveConversationBrowserProfile({
      agentId: folder,
      workspaceKey: folder,
      conversationId: chatJid,
    });
    const used = consumeBrowserProfileActivity(profileName);
    if (!used) return;
    try {
      if (!isBrowserProfileSyncEnabled()) return;
      await deps.closeBrowserToolBackends?.(profileName);
      await deps.closeBrowserSession?.(profileName);
      const profile = getProfile(profileName);
      if (!profile) return;
      await snapshotBrowserProfile({
        profileName,
        profileDir: profile.dir,
        userDataDir: profile.userDataDir,
        snapshotRunId: input.runId ?? null,
        snapshotFencingVersion: input.fencingVersion ?? 0,
      });
    } catch (err) {
      deps.warn(
        { err, queueJid: input.queueJid, profileName },
        'Failed to snapshot live-turn browser profile after finalize',
      );
    }
  };
}
