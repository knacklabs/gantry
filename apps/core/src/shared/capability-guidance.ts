export const REQUEST_TOOL_ENABLE_SCOPE_GUIDANCE = [
  'Access decision ladder:',
  'Source = what exists.',
  'Capability = reviewed action.',
  'Grant = agent allowed capability.',
  'Job = requirement only.',
  'Use capability_search first. If a reviewed capability exists, use propose_capability. If the source is missing, request the source install/connect/attach path. If the source exists but the action is unreviewed, refresh source inventory and request review. Use request_permission only for exact one-off access, Browser, exact Gantry admin tools, provider/channel permissions, or scoped RunCommand fallback when no reviewed capability fits.',
].join(' ');

export const SOURCE_INVENTORY_AUTHORITY_GUIDANCE =
  'Source install/connect/attach only records source inventory. It never creates durable authority by itself; durable authority is an agent allowed capability selected from a reviewed definition.';

export const UNREVIEWED_DISCOVERY_GUIDANCE =
  'CLI help, MCP tool lists, skill text, and adapter discovery can guide review, but they are not public capability definitions until reviewed.';

export const NO_REVIEWED_CAPABILITY_GUIDANCE = [
  'No reviewed capabilities matched.',
  'Next action:',
  '- If the source is missing, request source install/connect/attach with request_skill_install, request_mcp_server, or an admin-reviewed local CLI source setup.',
  '- If the source exists but the action is unreviewed, refresh source inventory and request a capability review; do not treat CLI help, MCP tools, or skill text as durable authority.',
  '- If the user needs one immediate action, request exact one-off access with request_permission.',
].join('\n');

export function renderDefaultCapabilityRules(options?: {
  includeSettingsTools?: boolean;
}): string {
  const lines = [
    'Capability rules:',
    '- Use send_message for progress updates and ask_user_question for structured choices.',
    `- ${SOURCE_INVENTORY_AUTHORITY_GUIDANCE}`,
    '- Use capability_search, propose_capability, and manage_capability for durable capability changes; request_permission is only a one-off or exact fallback access request.',
    '- For skills, Bash may be used for narrow prep such as inspecting, copying, unzipping, or constructing files, but durable install/selection must go through request_skill_install with staged files when available or an exact installer argv for catalog/local/URL/CLI installs.',
    `- ${UNREVIEWED_DISCOVERY_GUIDANCE}`,
    '- Declare requiredEnvVars for secrets the installed skill needs at runtime; they are projected later from Gantry Credentials and are not generic installer env.',
    `- ${REQUEST_TOOL_ENABLE_SCOPE_GUIDANCE}`,
    '- After requesting or installing a skill, MCP server, tool, or capability, explain the user-facing result in plain words: approval requested, approved, installed, available now, needs setup, or paused. Do not quote internal selected-capability lists, task ids, MCP tool ids, or status blocks unless the user asks for technical details.',
  ];
  if (options?.includeSettingsTools) {
    lines.push(
      '- Agents with selected admin capabilities may use settings_desired_state before local configuration changes and request_settings_update for reviewed settings.yaml changes; do not edit settings directly.',
    );
  }
  lines.push(
    '- Agents with selected admin capabilities may use service_restart after approved changes and register_agent for conversation binding.',
    '- Never run dependency installs or edit local skill files, MCP config, settings, or generated runtime config directly.',
  );
  return lines.join('\n');
}
