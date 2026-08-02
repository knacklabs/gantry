import { isPlainObject } from '../shared/object.js';

const SHELL_TOOL_NAMES = new Set(['Bash', 'RunCommand']);

/**
 * For shell tools, strip only the exact prefix authenticated by the runner.
 * Missing or mismatched provenance leaves the command unchanged.
 */
export function stripShellCommandEnvPrefix(
  toolName: string,
  toolInput: unknown,
  hostInjectedCommandPrefix?: string,
): unknown {
  if (
    !SHELL_TOOL_NAMES.has(toolName) ||
    !isPlainObject(toolInput) ||
    !hostInjectedCommandPrefix
  ) {
    return toolInput;
  }
  const field =
    typeof toolInput.command === 'string'
      ? 'command'
      : typeof toolInput.cmd === 'string'
        ? 'cmd'
        : undefined;
  if (!field) return toolInput;
  const command = toolInput[field] as string;
  const prefixWithSeparator = `${hostInjectedCommandPrefix} `;
  if (!command.startsWith(prefixWithSeparator)) return toolInput;
  return {
    ...toolInput,
    [field]: command.slice(prefixWithSeparator.length),
  };
}
