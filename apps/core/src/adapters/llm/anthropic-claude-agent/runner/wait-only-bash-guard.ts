const WAIT_ONLY_BASH_GUIDANCE =
  'Do not use Bash sleep/wait/poll loops to monitor scheduler jobs. Use scheduler_get_job, scheduler_list_runs, scheduler_list_events, or scheduler_wait_for_events instead.';
const WAIT_ONLY_BASH_TRIGGER_PATTERN =
  /\b(?:sleep|wait|poll|while\s+true|until\s+done|run\s+completion|scheduler\s+tools|scheduler_wait_for_events)\b/i;
const REAL_WORK_COMMAND_PATTERN =
  /\b(?:awk|bun|cat|curl|deno|find|gh|git|gog|grep|jq|node|npm|perl|pnpm|psql|python|python3|rg|ruby|sed|tsx|ts-node|uv)\b/;

export function waitOnlyBashMonitoringDenial(
  toolName: string,
  toolInput: Record<string, unknown>,
): string | undefined {
  if (toolName !== 'Bash') return undefined;
  const command =
    typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
  if (!command || !WAIT_ONLY_BASH_TRIGGER_PATTERN.test(command)) {
    return undefined;
  }
  const commandWithoutQuotedText = command
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
  if (REAL_WORK_COMMAND_PATTERN.test(commandWithoutQuotedText)) {
    return undefined;
  }
  return WAIT_ONLY_BASH_GUIDANCE;
}
