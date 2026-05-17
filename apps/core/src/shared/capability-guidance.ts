export const REQUEST_TOOL_ENABLE_SCOPE_GUIDANCE =
  'Access decision ladder: use capability_search first; use request_capability when a reviewed semantic capability fits; use propose_local_cli_capability or manage_capability for durable local CLI access; use request_permission only for one-off exact access, Browser, exact Gantry admin tools, or scoped Bash fallback when no reviewed capability fits.';

export function renderDefaultCapabilityRules(options?: {
  includeSettingsTools?: boolean;
}): string {
  const lines = [
    'Capability rules:',
    '- Use send_message for progress updates and ask_user_question for structured choices.',
    '- Use request_skill_install, request_skill_proposal, request_skill_dependency_install, request_mcp_server, capability_search, request_capability, propose_local_cli_capability, manage_capability, or request_permission for capability changes.',
    `- ${REQUEST_TOOL_ENABLE_SCOPE_GUIDANCE}`,
  ];
  if (options?.includeSettingsTools) {
    lines.push(
      '- Agents with selected admin capabilities may use settings_desired_state before local configuration changes and request_settings_update for reviewed settings.yaml changes; do not edit settings directly.',
    );
  }
  lines.push(
    '- Agents with selected admin capabilities may use service_restart after approved changes and register_agent for conversation binding.',
    '- Never run dependency installs or edit local skill files, MCP config, settings, or generated capability config directly.',
  );
  return lines.join('\n');
}
