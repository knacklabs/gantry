import type { RunnerSandboxProvider, RunnerSandboxProviderSelection, RunnerSandboxResourceLimits, RunnerSandboxSpawnInput, RunnerSandboxWarmTemplateStatus } from '../../shared/runner-sandbox-provider.js';
export interface SandboxRuntimeWarmTemplate {
    readonly authorityFree: true;
    readonly network: {
        readonly deniedDomains: readonly string[];
        readonly allowLocalBinding: false;
    };
    readonly filesystem: {
        readonly homeSecretDenySuffixes: readonly string[];
        readonly cwdEnvDenyFilename: '.env';
        readonly usesUidScopedToolTemp: boolean;
    };
    readonly enableWeakerNetworkIsolation?: true;
}
export declare function createRunnerSandboxProvider(settings: RunnerSandboxProviderSelection): RunnerSandboxProvider;
export declare class DirectRunnerSandboxProvider implements RunnerSandboxProvider {
    private readonly resourceLimits;
    readonly id: "direct";
    readonly enforcing = false;
    constructor(resourceLimits?: RunnerSandboxResourceLimits);
    warmTemplate(): RunnerSandboxWarmTemplateStatus;
    start(input: RunnerSandboxSpawnInput): import("child_process").ChildProcessWithoutNullStreams;
}
export declare function buildSandboxRuntimeWarmTemplate(): Readonly<SandboxRuntimeWarmTemplate>;
