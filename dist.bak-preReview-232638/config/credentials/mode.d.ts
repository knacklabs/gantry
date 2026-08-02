export type HostCredentialMode = 'none' | 'gantry';
export declare function parseHostCredentialMode(raw: string | undefined): HostCredentialMode | undefined;
export declare function resolveHostCredentialMode(rawMode: string | undefined): HostCredentialMode;
