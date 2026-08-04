export interface RuntimeLayoutPaths {
    runtimeHome: string;
    storeDir: string;
    agentsDir: string;
    dataDir: string;
    logsDir: string;
}
export declare function getRuntimeLayoutPaths(runtimeHome: string): RuntimeLayoutPaths;
export declare function ensureRuntimeLayoutDirectories(runtimeHome: string): void;
