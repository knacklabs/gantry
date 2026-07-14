export const REQUEST_TOOL_ENABLE_SCOPE_GUIDANCE = [
  'Access decision ladder:',
  'Use an available action.',
  'If the action is missing, request the reviewed capability.',
  'If setup is missing, request source setup through the Gantry access flow.',
  'If policy blocks the action, report the policy blocker.',
  'Use request_access target.kind=run_command only as a temporary exact-command fallback when no reviewed capability fits.',
].join(' ');

export const SOURCE_INVENTORY_AUTHORITY_GUIDANCE =
  'Sources only provide inventory and setup metadata. Durable authority is the reviewed action capability granted to the agent.';

export const UNREVIEWED_DISCOVERY_GUIDANCE =
  'CLI help, MCP tool lists, skill text, and adapter discovery can guide review, but the agent should use the reviewed action capability as the public contract.';

export const NO_REVIEWED_CAPABILITY_GUIDANCE = [
  'No reviewed capabilities matched.',
  'Next action:',
  '- If setup is missing, request the source setup through the Gantry access flow.',
  '- If setup exists but the action is unreviewed, refresh inventory and request capability review.',
  '- If the user needs one immediate command action, request exact scoped command access with request_access target.kind=run_command and temporaryOnly=true.',
].join('\n');

export const PROACTIVE_RECOMMENDATION_GUIDANCE = [
  'Proactive recommendation ladder (suggest the durable fix, do not just keep reacting):',
  '- Recurring or time-based work: suggest a scheduled job with scheduler_upsert_job instead of repeating the steps each time.',
  '- Repeatable multi-step procedure: suggest a skill with request_skill_proposal or request_skill_install so the workflow is reusable.',
  '- Same permission requested repeatedly: suggest a durable reviewed capability with request_access target.kind=capability instead of repeated temporary request_access target.kind=run_command grants.',
  '- Missing secret: suggest Credential Center setup; the user enters the secret there, never in chat, and skills reference it through requiredEnvVars. Never ask for or accept a secret value in the conversation.',
  '- Needs logged-in web context: suggest browser setup so the canonical Browser capability and a signed-in session are available before browser_* actions.',
  '- Unused or overly broad access: review current grants with admin_permission_list and suggest permission cleanup of anything no longer needed.',
  'Phrase these suggestions to the user outcome-first, not by tool name. For example: "I can ask to keep this access for next time so you do not have to approve it each run.", "I can turn this into a scheduled job so it happens automatically.", "I can package these repeated steps as a reusable skill.", "This needs a secret. Please add it in Credential Center; do not paste it here.", "This needs a signed-in browser session. I can ask for Browser access and guide setup.", or "I noticed access that may no longer be needed. I can show a cleanup suggestion."',
].join('\n');

export function renderDefaultCapabilityRules(options?: {
  includeSettingsTools?: boolean;
}): string {
  const lines = [
    'Capability rules:',
    '- For non-trivial live work, first send one short natural acknowledgement with send_message before starting tools or investigation.',
    '- For multi-step work, use todo_update for progress instead of repeated generic progress messages.',
    '- Use render_* rich UI tools for structured status, facts, lists, tables, forms, media, or progress.',
    '- Use ask_user_question for structured choices.',
    '- Use the mounted Gantry tools that fit the task; if a requested workflow cannot be done with them, say what is unavailable and continue with the best available path.',
    `- ${SOURCE_INVENTORY_AUTHORITY_GUIDANCE}`,
    '- Use request_access target.kind=capability for durable reviewed access.',
    '- Use request_access target.kind=run_command only as a scoped temporary exact-command fallback when no reviewed capability fits.',
    '- For skills, MCP servers, local CLIs, browser, file/web, and admin tools, ask for the action the user wants; source setup and raw implementation details stay in review metadata.',
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
    '- Agents with selected admin capabilities may use service_restart after approved changes and register_agent for conversation installs.',
    '- Never run dependency installs or edit local skill files, MCP config, settings, or generated runtime config directly.',
  );
  return lines.join('\n');
}
