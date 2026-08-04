export declare const PROFILE_MIRROR_HEADER = "<!-- Managed by Gantry. Direct edits are not active until imported or approved. -->";
export declare function stripProfileMirrorHeader(content: string): string;
export declare function profileMirrorFileName(fileName: string): string;
export declare function createProfileFileMirrorWriter(runtimeHome: string): typeof writeProfileFileMirror;
export declare function createProfileFileMirrorExists(runtimeHome: string): typeof profileFileMirrorExists;
export declare function profileMirrorPath(agentFolder: string, fileName: string, options?: {
    runtimeHome?: string;
}): string;
export declare function writeProfileFileMirror(input: {
    agentFolder: string;
    fileName: string;
    content: string;
    runtimeHome?: string;
}): Promise<void>;
export declare function profileFileMirrorExists(input: {
    agentFolder: string;
    fileName: string;
    runtimeHome?: string;
}): Promise<boolean>;
export declare function readProfileFileMirror(input: {
    agentFolder: string;
    fileName: string;
    runtimeHome?: string;
}): string | null;
