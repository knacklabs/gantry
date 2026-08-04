import { formatDuration } from '../shared/human-format.js';
const HOST_PHASE_LABELS = {
    workspacePrepMs: 'Workspace Prep',
    modelResolutionMs: 'Model Resolution',
    preSpawnAdmissionMs: 'Pre-Spawn Admission',
    promptCompileMs: 'Prompt Compile',
    credentialProjectionMs: 'Credential Projection',
    adapterPrepareMs: 'Adapter Prepare',
    mcpProjectionMs: 'MCP Projection',
    egressGatewayMs: 'Egress Gateway',
    runnerEnvMs: 'Runner Env',
    selectedSkillEnvMs: 'Selected Skill Env',
    mcpConfigMs: 'MCP Config',
    sandboxTemplateMs: 'Sandbox Template',
    sandboxSpecMs: 'Sandbox Spec',
};
export function createRunnerHostStartupTiming(input) {
    const { nowMs } = input;
    const phases = {};
    return {
        start() {
            return nowMs();
        },
        finish(phase, startedAt) {
            phases[phase] = elapsedSince(startedAt, nowMs);
        },
        measure(phase, run) {
            const startedAt = nowMs();
            try {
                return run();
            }
            finally {
                phases[phase] = elapsedSince(startedAt, nowMs);
            }
        },
        async measureAsync(phase, run) {
            const startedAt = nowMs();
            try {
                return await run();
            }
            finally {
                phases[phase] = elapsedSince(startedAt, nowMs);
            }
        },
        payload() {
            return { ...phases };
        },
    };
}
export function createRunnerStartupTiming(input) {
    const { startTime, nowMs } = input;
    const sandboxStartAt = nowMs();
    const timing = {
        hostPreSpawnMs: elapsedSince(startTime, nowMs),
        ...(input.hostPhases ? { hostPhases: { ...input.hostPhases } } : {}),
    };
    const elapsedFromStart = () => elapsedSince(startTime, nowMs);
    return {
        markSandboxStartReturned() {
            timing.sandboxStartCallMs = elapsedSince(sandboxStartAt, nowMs);
        },
        measureStdinWrite(write) {
            const startedAt = nowMs();
            write();
            timing.stdinWriteMs = elapsedSince(startedAt, nowMs);
        },
        markFirstStdout() {
            timing.firstStdoutMs ??= elapsedFromStart();
        },
        markFirstStderr() {
            timing.firstStderrMs ??= elapsedFromStart();
        },
        markFirstStructuredOutput() {
            timing.firstStructuredOutputMs ??= elapsedFromStart();
        },
        markFirstVisibleOutput() {
            timing.firstVisibleOutputMs ??= elapsedFromStart();
        },
        markProviderSession() {
            timing.providerSessionMs ??= elapsedFromStart();
        },
        lines() {
            return [
                `Host Pre-Spawn: ${formatTiming(timing.hostPreSpawnMs)}`,
                ...formatHostPhaseLines(timing.hostPhases),
                `Sandbox Start Call: ${formatTiming(timing.sandboxStartCallMs)}`,
                `Runner Stdin Write: ${formatTiming(timing.stdinWriteMs)}`,
                `First Stdout: ${formatTiming(timing.firstStdoutMs)}`,
                `First Stderr: ${formatTiming(timing.firstStderrMs)}`,
                `First Structured Output: ${formatTiming(timing.firstStructuredOutputMs)}`,
                `First Visible Output: ${formatTiming(timing.firstVisibleOutputMs)}`,
                `Provider Session Init: ${formatTiming(timing.providerSessionMs)}`,
            ];
        },
        payload() {
            return { ...timing };
        },
    };
}
function elapsedSince(startTime, nowMs) {
    return Math.max(0, nowMs() - startTime);
}
function formatTiming(value) {
    return value === undefined ? 'not observed' : formatDuration(value);
}
function formatHostPhaseLines(phases) {
    if (!phases)
        return [];
    return Object.entries(HOST_PHASE_LABELS)
        .filter(([phase]) => phases[phase] !== undefined)
        .map(([phase, label]) => {
        const value = phases[phase];
        return `Host Phase - ${label}: ${formatTiming(value)}`;
    });
}
