import { formatBrowserProfileLabel, resolveConversationBrowserProfile, } from '../shared/browser-profile-scope.js';
import { getProfile } from './browser-profiles.js';
import { getBrowserStatus } from './browser-capability.js';
import { hasPersistentBrowserState, inferAuthMarkers, } from './browser-profile-state.js';
export async function getGroupBrowserStatus(input) {
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
        profilePersistent: status.profilePersistent,
        userDataDir: status.userDataDir,
        chromeExecutable: status.chromeExecutable,
        hasState: status.hasState ??
            (profile ? hasPersistentBrowserState(profile) : undefined),
        authMarkers: status.authMarkers && status.authMarkers.length > 0
            ? status.authMarkers
            : authMarkers,
        headless: status.headless,
        error: status.error,
    };
}
