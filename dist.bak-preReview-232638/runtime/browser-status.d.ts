import type { BrowserSessionRecord } from './browser-session-record.js';
import type { BrowserSessionStatus } from './browser-capability-types.js';
import type { BrowserProfile } from './browser-profiles.js';
export interface BrowserProfileStateSummary {
    hasState: boolean;
    authMarkers: string[];
}
export declare function browserProfileState(profile: BrowserProfile): BrowserProfileStateSummary;
export declare function stoppedBrowserStatus(input: {
    profileName: string;
    profile: BrowserProfile | null;
    chromeExecutable: string;
    error?: string;
}): BrowserSessionStatus;
export declare function runningBrowserStatus(input: {
    session: {
        profileName: string;
        port: number;
        targetId?: string;
        pid: number;
        lastUsedAt: number;
        keepAliveMs: number;
        headless: boolean;
    };
    profile: BrowserProfile;
    chromeExecutable: string;
}): BrowserSessionStatus;
export declare function persistedBrowserStatus(input: {
    profileName: string;
    profile: BrowserProfile;
    record: BrowserSessionRecord;
    chromeExecutable: string;
}): BrowserSessionStatus;
