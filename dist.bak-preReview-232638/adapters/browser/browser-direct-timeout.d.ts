export declare const BROWSER_ACTION_TIMEOUT_MS = 30000;
export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T>;
export declare function browserActionTimeoutMs(value: number | undefined): number;
export declare function remainingBrowserActionTimeoutMs(deadline: number): number;
export declare function actionOperationTimeout(deadline: number): number;
