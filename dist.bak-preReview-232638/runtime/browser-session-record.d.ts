export interface BrowserSessionRecord {
    pid: number;
    port: number;
    targetId?: string;
    startedAt: string;
    lastUsedAt: string;
    headless: boolean;
}
export interface PersistableBrowserSession {
    pid: number;
    port: number;
    targetId?: string;
    lastUsedAt: number;
    headless: boolean;
}
export declare function readBrowserSessionRecord(profile: {
    dir: string;
}): BrowserSessionRecord | null;
export declare function writeBrowserSessionRecord(profile: {
    dir: string;
}, session: PersistableBrowserSession): void;
export declare function clearBrowserSessionRecord(profile: {
    dir: string;
}): void;
