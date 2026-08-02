export type HostPlatform = 'macos' | 'linux' | 'windows' | 'unknown';
export declare function detectPlatform(): HostPlatform;
export declare function commandExists(command: string): boolean;
export declare function tryExec(command: string, args: string[], options?: {
    input?: string;
    env?: NodeJS.ProcessEnv;
}): {
    ok: boolean;
    stdout: string;
    stderr: string;
};
export declare function getNodeVersion(): string;
export declare function getNodeMajorVersion(): number;
export declare function hasSystemdUser(): boolean;
