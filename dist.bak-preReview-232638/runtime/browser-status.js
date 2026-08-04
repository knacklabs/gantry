import { hasPersistentBrowserState, inferAuthMarkers, } from './browser-profile-state.js';
export function browserProfileState(profile) {
    return {
        hasState: hasPersistentBrowserState(profile),
        authMarkers: [
            ...new Set([
                ...(profile.metadata.auth_markers || []),
                ...inferAuthMarkers(profile),
            ]),
        ].sort(),
    };
}
export function stoppedBrowserStatus(input) {
    const state = input.profile ? browserProfileState(input.profile) : undefined;
    return {
        profile: input.profileName,
        profileName: input.profileName,
        running: false,
        cdpReady: false,
        profilePersistent: Boolean(input.profile),
        ...(input.profile ? { userDataDir: input.profile.userDataDir } : {}),
        chromeExecutable: input.chromeExecutable,
        hasState: state?.hasState,
        authMarkers: state?.authMarkers ?? [],
        ...(input.error ? { error: input.error } : {}),
    };
}
export function runningBrowserStatus(input) {
    const idleExpiresAt = input.session.lastUsedAt + input.session.keepAliveMs;
    const state = browserProfileState(input.profile);
    return {
        profile: input.session.profileName,
        profileName: input.session.profileName,
        running: true,
        cdpReady: true,
        cdpUrl: `http://127.0.0.1:${input.session.port}`,
        port: input.session.port,
        pid: input.session.pid,
        targetId: input.session.targetId,
        lastUsedAt: new Date(input.session.lastUsedAt).toISOString(),
        headless: input.session.headless,
        keepAliveMs: input.session.keepAliveMs,
        idleExpiresAt: new Date(idleExpiresAt).toISOString(),
        profilePersistent: true,
        userDataDir: input.profile.userDataDir,
        chromeExecutable: input.chromeExecutable,
        hasState: state.hasState,
        authMarkers: state.authMarkers,
    };
}
export function persistedBrowserStatus(input) {
    const state = browserProfileState(input.profile);
    return {
        profile: input.profileName,
        profileName: input.profileName,
        running: true,
        cdpReady: true,
        cdpUrl: `http://127.0.0.1:${input.record.port}`,
        port: input.record.port,
        pid: input.record.pid,
        targetId: input.record.targetId,
        lastUsedAt: input.record.lastUsedAt,
        headless: input.record.headless,
        profilePersistent: true,
        userDataDir: input.profile.userDataDir,
        chromeExecutable: input.chromeExecutable,
        hasState: state.hasState,
        authMarkers: state.authMarkers,
    };
}
