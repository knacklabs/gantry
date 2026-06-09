export function formatSessionCommandsHelp(
  agentCommandNames: readonly string[] = [],
): string {
  const lines = [
    'Gantry commands',
    '',
    'Session',
    '/commands - List available chat commands.',
    '/new - Start a fresh session while preserving durable memory and approved capabilities.',
    '/compact - Compact the current provider context and collect durable memory.',
    '/stop - Stop the active run for this conversation.',
    '',
    'Models',
    '/model - Show the current model selection.',
    '/model <alias> - Set the conversation model override.',
    '/model default - Clear the conversation model override.',
    '/models - List available model aliases.',
    '',
    'Status',
    '/status - Show model/runtime status for this conversation.',
    '/memory-status - Show durable memory status.',
    '/dream - Run memory dreaming now when enabled.',
    '/digest-session - Capture the current conversation boundary for memory processing.',
    '/extract-memory-facts - Extract memory facts from the current conversation boundary.',
    '/extract-leads-queries - Extract CRM lead/query candidates from the current conversation boundary.',
    '',
    'Thinking',
    '/thinking - Show the current thinking setting.',
    '/thinking <low|medium|high|max|adaptive|enabled|off> - Set thinking for this conversation.',
    '/thinking default - Clear the thinking override.',
    '',
    'Memory',
    '/save-procedure "<title>" - Save reusable procedure steps from the message body or recent context.',
    '',
    'In-house agent surfaces',
    'gantry-admin - Runtime administration reference for approved Gantry admin tools.',
    'gantry-browser - Browser gateway guidance when the Browser capability is selected.',
  ];
  if (agentCommandNames.length > 0) {
    lines.push('', 'Agent commands');
    for (const name of agentCommandNames) lines.push(`/${name}`);
  }
  return lines.join('\n');
}
