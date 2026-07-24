import { isPlainObject } from '../shared/object.js';
import { stripHostInjectedEnvPrefix } from '../shared/runtime-env-command.js';

const SHELL_TOOL_NAMES = new Set(['Bash', 'RunCommand']);

/**
 * For shell tools, return a shallow-copied toolInput with the host-injected env
 * prefix stripped from the `command`/`cmd` field. Non-shell tools and inputs
 * without a string command field pass through unchanged.
 */
export function stripShellCommandEnvPrefix(
  toolName: string,
  toolInput: unknown,
): unknown {
  if (!SHELL_TOOL_NAMES.has(toolName) || !isPlainObject(toolInput)) {
    return toolInput;
  }
  const field =
    typeof toolInput.command === 'string'
      ? 'command'
      : typeof toolInput.cmd === 'string'
        ? 'cmd'
        : undefined;
  if (!field) return toolInput;
  return {
    ...toolInput,
    [field]: stripHostInjectedEnvPrefix(toolInput[field] as string).command,
  };
}
