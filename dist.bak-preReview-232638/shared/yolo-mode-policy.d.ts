export interface YoloModeSettings {
    enabled: boolean;
    denylist: string[];
    denylistPaths: string[];
}
export interface YoloModeMatch {
    kind: 'command' | 'path';
    pattern: string;
    toolName: string;
}
export declare function yoloModeDenylistDenyReason(match: YoloModeMatch): string;
export declare const DEFAULT_YOLO_MODE_DENYLIST: readonly ["sudo *", "rm -rf /", "rm -rf /*", "rm -rf ~", "rm -rf $HOME", "rm -rf ~/*", "git push --force * main|master", "git push -f * main|master", ":(){ :|:& };:"];
export declare const DEFAULT_YOLO_MODE_DENYLIST_PATHS: readonly ["/etc/*", "/System/*", "/usr/*", "/bin/*", "/sbin/*"];
export declare function effectiveYoloModeSettings(settings: YoloModeSettings): YoloModeSettings;
export declare function evaluateYoloModeDenylist(input: {
    settings?: YoloModeSettings;
    toolName: string;
    toolInput: unknown;
}): YoloModeMatch | undefined;
