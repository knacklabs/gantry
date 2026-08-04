import * as p from '@clack/prompts';
import { agentEngineLabel } from '../shared/agent-engine.js';
import { resolveExecutionRoute } from '../shared/model-execution-route.js';
import { resolveModelSelectionForWorkload } from '../shared/model-catalog.js';
import { requiredModelCredentialProviderReasonsForSetupDraft, requiredModelCredentialProvidersForSetupDraft, } from './setup-credentials.js';
export async function runReadyStep(draft) {
    p.note([
        'Gantry is ready.',
        '',
        `Workspace: ${draft.workspaceKey}`,
        `Agent: ${draft.agentName}`,
        `Agent harness: ${draft.agentHarness}`,
        `Conversation: ${draft.conversationLabel}`,
        `Model: ${draft.selectedModel}`,
        `Resolved model/harness: ${draft.selectedModel} / ${resolvedHarnessLabel(draft.selectedModel)}`,
        `Required model providers: ${formatProviderIds(requiredModelProviders(draft))}`,
        ...formatRequiredProviderReasons(draft),
        '',
        'Next: Start chatting or run gantry status.',
        'Optional setup: memory, background service, extra chat channels.',
    ].join('\n'), 'Ready');
    const value = await p.select({
        message: 'Setup complete. What should Gantry do now?',
        options: [
            {
                value: 'next',
                label: 'Finish setup and exit (Recommended)',
                hint: 'Return to the terminal. Start later with `gantry start`.',
            },
            {
                value: 'start_now',
                label: 'Start Gantry now',
                hint: 'Run `gantry start` immediately.',
            },
        ],
    });
    if (p.isCancel(value))
        return { type: 'next' };
    if (value === 'start_now')
        return { type: 'start_now' };
    return { type: 'next' };
}
function resolvedHarnessLabel(alias) {
    const resolved = resolveModelSelectionForWorkload(alias, 'chat');
    if (!resolved.ok)
        return 'unknown';
    const route = resolveExecutionRoute({ entry: resolved.entry });
    return route.ok ? agentEngineLabel(route.value.engine) : 'unknown';
}
function formatProviderIds(providerIds) {
    return providerIds.length > 0 ? providerIds.join(', ') : 'none';
}
function requiredModelProviders(draft) {
    return requiredModelCredentialProvidersForSetupDraft({
        credentialMode: 'gantry',
        selectedModel: draft.selectedModel,
        memoryEnabled: draft.memoryEnabled,
        embeddingsEnabled: draft.embeddingsEnabled,
        dreamingEnabled: draft.dreamingEnabled,
    });
}
function formatRequiredProviderReasons(draft) {
    return requiredModelCredentialProviderReasonsForSetupDraft({
        credentialMode: 'gantry',
        selectedModel: draft.selectedModel,
        memoryEnabled: draft.memoryEnabled,
        embeddingsEnabled: draft.embeddingsEnabled,
        dreamingEnabled: draft.dreamingEnabled,
    }).map(({ providerId, reasons }) => `  ${providerId}: ${reasons.length ? reasons.join('; ') : 'selected defaults'}`);
}
