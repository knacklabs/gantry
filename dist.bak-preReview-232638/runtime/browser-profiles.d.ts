export interface BrowserProfileMetadata {
    created_at: string;
    last_used: string;
    cdp_port?: number;
    chrome_pid?: number;
    auth_markers?: string[];
}
export interface BrowserProfile {
    name: string;
    dir: string;
    userDataDir: string;
    statePath: string;
    metadata: BrowserProfileMetadata;
}
export interface BrowserProfileLock {
    name: string;
    lockPath: string;
    release: () => void;
}
export declare function getBrowserProfilesRoot(): string;
export declare function isValidBrowserProfileName(name: string): boolean;
export declare function createProfile(name: string): BrowserProfile;
export declare function getProfile(name: string): BrowserProfile | null;
export declare function listProfiles(): BrowserProfile[];
export declare function updateProfileMetadata(name: string, patch: Partial<BrowserProfileMetadata>): BrowserProfileMetadata;
export declare function acquireProfileLock(name: string, timeoutMs?: number): Promise<BrowserProfileLock>;
