export declare const DEFAULT_CHROME_ARGS: readonly ["--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-features=OmniboxPopup", "--window-size=1280,900", "--remote-debugging-address=127.0.0.1"];
export interface ChromeLaunchArgsInput {
    userDataDir: string;
    port: number;
    platform?: NodeJS.Platform;
    uid?: number;
}
export declare function buildChromeLaunchArgs(input: ChromeLaunchArgsInput): string[];
export declare const DEFAULT_BROWSER_KEEPALIVE_MS: number;
