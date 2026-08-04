import { type Browser, type ConsoleMessage, type Page, type Request } from 'playwright-core';
interface BrowserConsoleEntry {
    type: string;
    text: string;
    timestamp: string;
    location?: ReturnType<ConsoleMessage['location']>;
}
interface BrowserNetworkEntry {
    id: string;
    method: string;
    url: string;
    resourceType: string;
    timestamp: string;
    status?: number;
    ok?: boolean;
    failureText?: string;
}
export interface BrowserPageState {
    console: BrowserConsoleEntry[];
    pageErrors: Array<{
        message: string;
        timestamp: string;
    }>;
    network: BrowserNetworkEntry[];
    requestIds: WeakMap<Request, string>;
    nextRequestId: number;
}
export interface BrowserConnection {
    key: string;
    browser: Browser;
    idleTimer?: ReturnType<typeof setTimeout>;
    onDisconnected?: () => void;
}
export declare function getBrowserConnection(input: {
    key: string;
    cdpEndpoint: string;
    deadline: number;
    remainingMs: (deadline: number) => number;
    withTimeout: <T>(promise: Promise<T>, timeoutMs: number, message: string) => Promise<T>;
}): Promise<BrowserConnection>;
export declare function scheduleConnectionIdleClose(key: string): void;
export declare function closeCachedConnection(key: string): Promise<void>;
export declare function closeBrowserDirectConnections(profileName?: string): Promise<void>;
export declare function allPages(browser: Browser): Promise<Page[]>;
export declare function firstContext(browser: Browser): import("playwright-core").BrowserContext;
export declare function observePage(page: Page): void;
export declare function pageState(page: Page): BrowserPageState;
export declare function safeTitle(page: Page): Promise<string>;
export {};
