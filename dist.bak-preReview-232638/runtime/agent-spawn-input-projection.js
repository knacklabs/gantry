import { agentIdForFolder } from '../domain/agent/agent-folder-id.js';
import { isCanonicalBrowserCapabilityRule } from '../shared/agent-tool-references.js';
import { resolveConversationBrowserProfile } from '../shared/browser-profile-scope.js';
import { effectiveYoloModeSettings } from '../shared/yolo-mode-policy.js';
export function agentPersonasById(agents) {
    return Object.fromEntries(Object.entries(agents ?? {}).map(([folder, agent]) => [
        String(agentIdForFolder(folder)),
        agent.persona,
    ]));
}
export function projectSpawnRunnerInput(input) {
    const browserProfileName = resolveConversationBrowserProfile({
        agentId: input.workspaceFolder,
        workspaceKey: input.workspaceFolder,
        conversationId: input.agentInput.chatJid,
    });
    const trustedToolPolicyRules = input.agentInput.toolPolicyRules;
    const browserIpcEnabled = (trustedToolPolicyRules ?? []).some(isCanonicalBrowserCapabilityRule);
    // hideAuthorityTools comes from prepareWorkerAuthorityProjection
    // (same three conditions).
    const runnerInput = {
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
