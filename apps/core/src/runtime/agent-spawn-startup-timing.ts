import { formatDuration } from '../shared/human-format.js';

export type RunnerStartupTimingPayload = {
  hostPreSpawnMs: number;
  sandboxStartCallMs?: number;
  stdinWriteMs?: number;
  firstStdoutMs?: number;
  firstStderrMs?: number;
  firstStructuredOutputMs?: number;
  providerSessionMs?: number;
};

export function createRunnerStartupTiming(input: {
  startTime: number;
  nowMs: () => number;
}) {
  const { startTime, nowMs } = input;
  const sandboxStartAt = nowMs();
  const timing: RunnerStartupTimingPayload = {
    hostPreSpawnMs: elapsedSince(startTime, nowMs),
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
    markProviderSession(): void {
      timing.providerSessionMs ??= elapsedFromStart();
    },
    lines(): string[] {
      return [
        `Host Pre-Spawn: ${formatTiming(timing.hostPreSpawnMs)}`,
        `Sandbox Start Call: ${formatTiming(timing.sandboxStartCallMs)}`,
        `Runner Stdin Write: ${formatTiming(timing.stdinWriteMs)}`,
        `First Stdout: ${formatTiming(timing.firstStdoutMs)}`,
        `First Stderr: ${formatTiming(timing.firstStderrMs)}`,
        `First Structured Output: ${formatTiming(timing.firstStructuredOutputMs)}`,
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
