declare const HOST_PHASE_LABELS: {
    readonly workspacePrepMs: "Workspace Prep";
    readonly modelResolutionMs: "Model Resolution";
    readonly preSpawnAdmissionMs: "Pre-Spawn Admission";
    readonly promptCompileMs: "Prompt Compile";
    readonly credentialProjectionMs: "Credential Projection";
    readonly adapterPrepareMs: "Adapter Prepare";
    readonly mcpProjectionMs: "MCP Projection";
    readonly egressGatewayMs: "Egress Gateway";
    readonly runnerEnvMs: "Runner Env";
    readonly selectedSkillEnvMs: "Selected Skill Env";
    readonly mcpConfigMs: "MCP Config";
    readonly sandboxTemplateMs: "Sandbox Template";
    readonly sandboxSpecMs: "Sandbox Spec";
};
export type RunnerStartupHostPhase = keyof typeof HOST_PHASE_LABELS;
export type RunnerStartupHostPhaseTimings = Partial<Record<RunnerStartupHostPhase, number>>;
export type RunnerStartupTimingPayload = {
    hostPreSpawnMs: number;
    hostPhases?: RunnerStartupHostPhaseTimings;
    sandboxStartCallMs?: number;
    stdinWriteMs?: number;
    firstStdoutMs?: number;
    firstStderrMs?: number;
    firstStructuredOutputMs?: number;
    firstVisibleOutputMs?: number;
    providerSessionMs?: number;
};
export declare function createRunnerHostStartupTiming(input: {
    nowMs: () => number;
}): {
    start(): number;
    finish(phase: RunnerStartupHostPhase, startedAt: number): void;
    measure<T>(phase: RunnerStartupHostPhase, run: () => T): T;
    measureAsync<T>(phase: RunnerStartupHostPhase, run: () => Promise<T>): Promise<T>;
    payload(): RunnerStartupHostPhaseTimings;
};
export declare function createRunnerStartupTiming(input: {
    startTime: number;
    nowMs: () => number;
    hostPhases?: RunnerStartupHostPhaseTimings;
}): {
    markSandboxStartReturned(): void;
    measureStdinWrite(write: () => void): void;
    markFirstStdout(): void;
    markFirstStderr(): void;
    markFirstStructuredOutput(): void;
    markFirstVisibleOutput(): void;
    markProviderSession(): void;
    lines(): string[];
    payload(): RunnerStartupTimingPayload;
};
export {};
