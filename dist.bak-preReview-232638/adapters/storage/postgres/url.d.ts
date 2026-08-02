export declare function parsePostgresConnectionUrl(url: string): URL;
export declare function fleetRehearsalPlaintextPostgresHosts(env?: Partial<Record<string, string | undefined>>): readonly string[];
export declare function isLocalPostgresHost(hostname: string, plaintextHostAllowlist?: readonly string[]): boolean;
export interface ValidatePostgresConnectionUrlOptions {
    allowLocalhost?: boolean;
    plaintextHostAllowlist?: readonly string[];
}
export declare function validatePostgresConnectionUrl(url: string, options?: ValidatePostgresConnectionUrlOptions): void;
