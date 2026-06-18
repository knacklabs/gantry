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
  sandboxSpecMs: 'Sandbox Spec',
} as const;

export type RunnerStartupHostPhase = keyof typeof HOST_PHASE_LABELS;

export type RunnerStartupHostPhaseTimings = Partial<
  Record<RunnerStartupHostPhase, number>
>;

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

export function createRunnerHostStartupTiming(input: { nowMs: () => number }) {
  const { nowMs } = input;
  const phases: RunnerStartupHostPhaseTimings = {};

  return {
    start(): number {
      return nowMs();
    },
    finish(phase: RunnerStartupHostPhase, startedAt: number): void {
      phases[phase] = elapsedSince(startedAt, nowMs);
    },
    measure<T>(phase: RunnerStartupHostPhase, run: () => T): T {
      const startedAt = nowMs();
      try {
        return run();
      } finally {
        phases[phase] = elapsedSince(startedAt, nowMs);
      }
    },
    async measureAsync<T>(
      phase: RunnerStartupHostPhase,
      run: () => Promise<T>,
    ): Promise<T> {
      const startedAt = nowMs();
      try {
        return await run();
      } finally {
        phases[phase] = elapsedSince(startedAt, nowMs);
      }
    },
    payload(): RunnerStartupHostPhaseTimings {
      return { ...phases };
    },
  };
}

export function createRunnerStartupTiming(input: {
  startTime: number;
  nowMs: () => number;
  hostPhases?: RunnerStartupHostPhaseTimings;
}) {
  const { startTime, nowMs } = input;
  const sandboxStartAt = nowMs();
  const timing: RunnerStartupTimingPayload = {
    hostPreSpawnMs: elapsedSince(startTime, nowMs),
    ...(input.hostPhases ? { hostPhases: { ...input.hostPhases } } : {}),
  };
  const elapsedFromStart = () => elapsedSince(startTime, nowMs);

  return {
    markSandboxStartReturned(): void {
      timing.sandboxStartCallMs = elapsedSince(sandboxStartAt, nowMs);
    },
    measureStdinWrite(write: () => void): void {
      const startedAt = nowMs();
      write();
      timing.stdinWriteMs = elapsedSince(startedAt, nowMs);
    },
    markFirstStdout(): void {
      timing.firstStdoutMs ??= elapsedFromStart();
    },
    markFirstStderr(): void {
      timing.firstStderrMs ??= elapsedFromStart();
    },
    markFirstStructuredOutput(): void {
      timing.firstStructuredOutputMs ??= elapsedFromStart();
    },
    markFirstVisibleOutput(): void {
      timing.firstVisibleOutputMs ??= elapsedFromStart();
    },
    markProviderSession(): void {
      timing.providerSessionMs ??= elapsedFromStart();
    },
    lines(): string[] {
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
    payload(): RunnerStartupTimingPayload {
      return { ...timing };
    },
  };
}

function elapsedSince(startTime: number, nowMs: () => number): number {
  return Math.max(0, nowMs() - startTime);
}

function formatTiming(value: number | undefined): string {
  return value === undefined ? 'not observed' : formatDuration(value);
}

function formatHostPhaseLines(
  phases: RunnerStartupHostPhaseTimings | undefined,
): string[] {
  if (!phases) return [];
  return Object.entries(HOST_PHASE_LABELS)
    .filter(([phase]) => phases[phase as RunnerStartupHostPhase] !== undefined)
    .map(([phase, label]) => {
      const value = phases[phase as RunnerStartupHostPhase];
      return `Host Phase - ${label}: ${formatTiming(value)}`;
    });
}
