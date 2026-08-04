export interface RuntimePreflightFailure {
    summary: string;
    details: string[];
}
export interface RuntimePreflightResult {
    ok: boolean;
    failure?: RuntimePreflightFailure;
}
export declare function validateRuntimePreflight(runtimeHome: string): RuntimePreflightResult;
export declare function validateRuntimePreflightWithStorage(runtimeHome: string): Promise<RuntimePreflightResult>;
export declare function formatRuntimePreflightFailure(failure: RuntimePreflightFailure): string;
