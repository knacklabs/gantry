import {
  formatBrowserProfileLabel,
  resolveConversationBrowserProfile,
} from '../shared/browser-profile-scope.js';
import type { BrowserStatusSnapshot } from '../session/session-command-format.js';
import { getProfile } from './browser-profiles.js';
import { getBrowserStatus } from './browser-capability.js';
import {
  hasPersistentBrowserState,
  inferAuthMarkers,
} from './browser-profile-state.js';

interface BrowserStatusGroup {
  name: string;
  folder: string;
  conversationKind?: 'dm' | 'channel';
}

export async function getGroupBrowserStatus(input: {
  group: BrowserStatusGroup;
  chatJid: string;
}): Promise<BrowserStatusSnapshot> {
  const profileName = resolveConversationBrowserProfile({
    agentId: input.group.folder,
    workspaceKey: input.group.folder,
    conversationId: input.chatJid,
  });
  const status = await getBrowserStatus(profileName);
  const profile = getProfile(profileName);
  const authMarkers = profile
    ? [
        ...new Set([
          ...(profile.metadata.auth_markers || []),
          ...inferAuthMarkers(profile),
        ]),
      ].sort()
    : undefined;
  return {
    profileName,
    profileLabel: formatBrowserProfileLabel({
      agentName: input.group.name,
      conversationKind: input.group.conversationKind,
    }),
    running: status.running,
    cdpReady: status.cdpReady,
    hasState: profile ? hasPersistentBrowserState(profile) : undefined,
    authMarkers,
    headless: status.headless,
    error: status.error,
  };
}
