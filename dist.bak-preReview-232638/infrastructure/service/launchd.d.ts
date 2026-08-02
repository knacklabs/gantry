export declare function launchdPlistPath(): string;
export declare function writeLaunchdPlist(runtimeHome: string, runtimeEntry: string, migratorEntry: string): void;
export declare function startLaunchdService(): void;
export declare function stopLaunchdService(): void;
export declare function getLaunchdServiceStatus(): string;
