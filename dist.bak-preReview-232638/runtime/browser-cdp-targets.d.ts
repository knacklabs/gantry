export interface BrowserCdpTargetOptions {
    deadlineAtMs?: number;
    timeoutMs?: number;
}
export declare function activateBrowserTarget(port: number, targetId: string, options?: BrowserCdpTargetOptions): Promise<void>;
export declare function foregroundBrowserTarget(port: number, targetId: string, options?: BrowserCdpTargetOptions): Promise<void>;
export declare function resizeHeadedBrowserWindow(port: number, targetId: string, width: number, height: number, options?: BrowserCdpTargetOptions): Promise<void>;
export declare function ensureBrowserTarget(port: number, options?: BrowserCdpTargetOptions): Promise<string | undefined>;
