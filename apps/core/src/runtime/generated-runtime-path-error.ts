import { redactSensitiveText } from '../shared/sensitive-material.js';
import type { AgentOutput } from './agent-spawn-types.js';

const GENERATED_RUNTIME_PATH_PATTERN = /(^|[/\\])\.llm-runtime([/\\]|\b)/;
const PERMISSION_FAILURE_PATTERN =
  /\b(EACCES|EPERM|permission denied|operation not permitted|denyWrite|denied write)\b/i;

export function formatGeneratedRuntimePathPermissionError(input: {
  runnerLabel: string;
  errorText: string;
}): string | null {
  if (!isGeneratedRuntimePathPermissionFailure(input.errorText)) return null;
  const raw = boundedSingleLine(redactSensitiveText(input.errorText), 240);
  return [
    `${input.runnerLabel} could not access Gantry-generated .llm-runtime files.`,
    'Runtime skill files should be readable/executable for selected capabilities, and generated runtime files should stay write-protected from agent tools.',
    'This is generated adapter state, not persistent settings.',
    raw ? `Raw error: ${raw}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function isGeneratedRuntimePathPermissionFailure(
  errorText: string,
): boolean {
  return (
    PERMISSION_FAILURE_PATTERN.test(errorText) &&
    GENERATED_RUNTIME_PATH_PATTERN.test(errorText)
  );
}

export function formatRunnerProcessExitError(input: {
  runnerLabel: string;
  code: number | null;
  stdout: string;
  stderr: string;
  structuredError: AgentOutput | null;
  newSessionId?: string;
  fallbackStderr: string;
}): AgentOutput {
  const generatedRuntimeError = formatGeneratedRuntimePathPermissionError({
    runnerLabel: input.runnerLabel,
    errorText: `${input.structuredError?.error ?? ''}\n${input.stderr}\n${input.stdout}`,
  });
  if (input.structuredError) {
    return {
      ...input.structuredError,
      newSessionId: input.structuredError.newSessionId ?? input.newSessionId,
      error: generatedRuntimeError ?? input.structuredError.error,
    };
  }
  return {
    status: 'error',
    result: null,
    error:
      generatedRuntimeError ??
      `${input.runnerLabel} exited with code ${input.code}: ${input.fallbackStderr}`,
  };
}

function boundedSingleLine(input: string, maxChars: number): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}
