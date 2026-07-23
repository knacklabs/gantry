import { agentIdForFolder } from '../domain/agent/agent-folder-id.js';
import type { AgentPersona } from '../shared/agent-persona.js';
import { isCanonicalBrowserCapabilityRule } from '../shared/agent-tool-references.js';
import { resolveConversationBrowserProfile } from '../shared/browser-profile-scope.js';
import { effectiveYoloModeSettings } from '../shared/yolo-mode-policy.js';
import type { RunnerAgentInput } from './agent-spawn-helpers.js';
import type { AgentInput } from './agent-spawn-types.js';

export function agentPersonasById(
  agents: Record<string, { persona?: AgentPersona }>,
): Record<string, AgentPersona | undefined> {
  return Object.fromEntries(
    Object.entries(agents ?? {}).map(([folder, agent]) => [
      String(agentIdForFolder(folder)),
      agent.persona,
    ]),
  );
}

export function projectSpawnRunnerInput(input: {
  agentInput: AgentInput;
  workspaceFolder: string;
  callableAgentManifest: RunnerAgentInput['callableAgentManifest'];
  hideAuthorityTools: boolean;
  compiledSystemPrompt: string;
  permissions: {
    yoloMode: Parameters<typeof effectiveYoloModeSettings>[0];
    egress: { denylist: string[] };
  };
}): {
  runnerInput: RunnerAgentInput;
  browserIpcEnabled: boolean;
  trustedToolPolicyRules: AgentInput['toolPolicyRules'];
} {
  const browserProfileName = resolveConversationBrowserProfile({
    agentId: input.workspaceFolder,
    workspaceKey: input.workspaceFolder,
    conversationId: input.agentInput.chatJid,
  });
  const trustedToolPolicyRules = input.agentInput.toolPolicyRules;
  const browserIpcEnabled = (trustedToolPolicyRules ?? []).some(
    isCanonicalBrowserCapabilityRule,
  );
  // hideAuthorityTools comes from prepareWorkerAuthorityProjection
  // (same three conditions).
  const runnerInput: RunnerAgentInput = {
    ...input.agentInput,
    allowedTools: trustedToolPolicyRules,
    callableAgentManifest: input.callableAgentManifest,
    browserProfileName,
    hideAuthorityTools: input.hideAuthorityTools,
    compiledSystemPrompt: input.compiledSystemPrompt,
    yoloMode: effectiveYoloModeSettings(input.permissions.yoloMode),
    egressDenylist: input.permissions.egress.denylist,
  };
  return { runnerInput, browserIpcEnabled, trustedToolPolicyRules };
}
