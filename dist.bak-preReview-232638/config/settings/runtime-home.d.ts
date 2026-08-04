export declare const DEFAULT_RUNTIME_HOME: string;
export declare function resolveRuntimeHome(raw?: string): string;
export declare function ensureRuntimeLayout(runtimeHome: string): void;
export declare function ensureRuntimeWritable(runtimeHome: string): void;
export declare function envFilePath(runtimeHome: string): string;
export declare function settingsFilePath(runtimeHome: string): string;
export declare function onboardingStatePath(runtimeHome: string): string;
export declare function runtimeLogPath(runtimeHome: string): string;
export declare function runtimeErrorLogPath(runtimeHome: string): string;
