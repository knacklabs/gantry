import * as p from '@clack/prompts';
import { requiredModelCredentialProviders } from '../application/model-resolution/required-model-credential-providers.js';
import { DEFAULT_SETUP_MODEL_ALIAS, memoryModelDefaultsForProvider, resolveModelSelectionForWorkload, } from '../shared/model-catalog.js';
import { getModelProviderDefinition } from '../shared/model-provider-registry.js';
import { listReadyModelCredentialProviders, promptModelCredentialPayload, storeModelCredentialInput, verifyModelCredentialInputWithPrompt, } from './credentials.js';
import { inspectModelCredentialReadiness } from './model-credential-readiness.js';
import { prepareOnboardingCredentialStorage } from './onboarding-config.js';
export async function verifyModelAccess(runtimeHome, settings, options = {}) {
    if (!runtimeHome || !settings) {
        return {
            ok: false,
            message: 'runtime settings are required for Model Access verification.',
            nextAction: 'run `gantry setup` from the configured Runtime home.',
        };
    }
    try {
        const check = await inspectModelCredentialReadiness(runtimeHome, settings, {
            live: true,
            skipLiveProviderIds: options.skipLiveProviderIds,
        });
        return {
            ok: check.status !== 'fail',
            message: check.message,
            nextAction: check.nextAction,
        };
    }
    catch (err) {
        return {
            ok: false,
            message: `could not inspect Model Access (${err instanceof Error ? err.message : String(err)})`,
            nextAction: 'run `gantry credentials model doctor`.',
        };
    }
}
export async function runCredentialsStep(draft, runtimeHome) {
    draft.credentialMode = 'gantry';
    try {
        await prepareOnboardingCredentialStorage({
            runtimeHome,
            postgresDatabaseUrl: draft.postgresDatabaseUrl,
            postgresSchema: draft.postgresSchema,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        p.log.error([
            `Setup blocked: could not prepare Model Access storage (${message})`,
            'Next action: return to the Database step and provide a reachable Postgres URL.',
        ].join('\n'));
        return { type: 'goto', step: 'storage' };
    }
    const requiredProviders = requiredModelCredentialProvidersForSetupDraft(draft);
    p.note(`Selected defaults require credentials for: ${formatProviderIds(requiredProviders)}.`, 'Model Access required');
    const readyProviders = await tryListReadyModelCredentialProviders(runtimeHome);
    const missingProviders = requiredProviders.filter((providerId) => !readyProviders.has(providerId));
    if (missingProviders.length === 0) {
        p.log.success('Required Model Access credentials are already configured.');
        return { type: 'next' };
    }
    for (const providerId of missingProviders) {
        const provider = getModelProviderDefinition(providerId);
        if (!provider) {
            p.log.error(`Unsupported required model provider: ${providerId}.`);
            return { type: 'cancel' };
        }
        const selectedMode = provider.credentialModes.length === 1
            ? provider.credentialModes[0].id
            : await p.select({
                message: 'Credential auth mode',
                options: [
                    ...provider.credentialModes.map((mode) => ({
                        value: mode.id,
                        label: mode.label,
                        hint: mode.helpText,
                    })),
                    { value: 'back', label: 'Back' },
                    { value: 'resume', label: 'Resume Later' },
                    { value: 'cancel', label: 'Cancel Setup' },
                ],
            });
        if (p.isCancel(selectedMode))
            return { type: 'cancel' };
        if (selectedMode === 'back' ||
            selectedMode === 'resume' ||
            selectedMode === 'cancel') {
            return { type: selectedMode };
        }
        const selectedModeId = String(selectedMode);
        p.note([
            'Gantry stores the real provider credential encrypted in Credential Center.',
            'Agent runners receive only a loopback gateway URL and a short-lived gtw_* token.',
            'The trusted host injects the real provider auth only when forwarding approved model API calls.',
        ].join('\n'), 'Model Access');
        const captureChoice = await p.select({
            message: 'Store this model credential now?',
            options: [
                {
                    value: 'store',
                    label: `Store ${provider.label}`,
                    hint: 'Required before Gantry can be ready.',
                },
                { value: 'back', label: 'Back' },
                { value: 'resume', label: 'Resume Later' },
                { value: 'cancel', label: 'Cancel Setup' },
            ],
        });
        if (p.isCancel(captureChoice))
            return { type: 'cancel' };
        if (captureChoice === 'back' ||
            captureChoice === 'resume' ||
            captureChoice === 'cancel') {
            return { type: captureChoice };
        }
        let credentialInput;
        let verification;
        while (true) {
            credentialInput = await promptModelCredentialPayload(provider.id, {
                authMode: selectedModeId,
            });
            if (!credentialInput)
                return { type: 'cancel' };
            verification = await verifyModelCredentialInputWithPrompt({
                providerId: provider.id,
                authMode: credentialInput.authMode,
                payload: credentialInput.payload,
                allowBackResume: true,
            });
            if (verification.type === 'reenter')
                continue;
            if (verification.type === 'back' ||
                verification.type === 'resume' ||
                verification.type === 'cancel') {
                return { type: verification.type };
            }
            break;
        }
        if (!credentialInput || !verification)
            return { type: 'cancel' };
        await storeModelCredentialInput({
            runtimeHome,
            providerId: provider.id,
            authMode: credentialInput.authMode,
            payload: credentialInput.payload,
        });
        const skippedProviderIds = new Set(draft.credentialLiveSkipProviderIds ?? []);
        if (verification.type === 'skip') {
            skippedProviderIds.add(provider.id);
            p.log.warn(`${provider.label} credential stored without live verification: ${verification.reason}`);
        }
        else {
            skippedProviderIds.delete(provider.id);
            p.log.success(`${provider.label} credential stored. Model Access is ready to validate during runtime preflight.`);
        }
        draft.credentialLiveSkipProviderIds = [...skippedProviderIds];
    }
    return { type: 'next' };
}
export function requiredModelCredentialProvidersForSetupDraft(draft) {
    const chatModel = draft.selectedModel || DEFAULT_SETUP_MODEL_ALIAS;
    const memoryModels = memoryDefaultsForChatModel(chatModel);
    const memoryEnabled = draft.memoryEnabled ?? true;
    const embeddingsEnabled = memoryEnabled && (draft.embeddingsEnabled ?? false);
    return requiredModelCredentialProviders({
        agent: {
            defaultModel: chatModel,
            oneTimeJobDefaultModel: '',
            recurringJobDefaultModel: '',
        },
        memory: {
            enabled: memoryEnabled,
            embeddings: {
                enabled: embeddingsEnabled,
                provider: embeddingsEnabled ? 'openai' : 'disabled',
            },
            dreaming: {
                enabled: memoryEnabled && (draft.dreamingEnabled ?? true),
                embeddings: {
                    enabled: false,
                    provider: 'disabled',
                },
            },
            llm: {
                models: memoryModels,
            },
        },
    });
}
export function requiredModelCredentialProviderReasonsForSetupDraft(draft) {
    const chatModel = draft.selectedModel || DEFAULT_SETUP_MODEL_ALIAS;
    const memoryModels = memoryDefaultsForChatModel(chatModel);
    const memoryEnabled = draft.memoryEnabled ?? true;
    const embeddingsEnabled = memoryEnabled && (draft.embeddingsEnabled ?? false);
    const reasons = new Map();
    const addReason = (providerId, reason) => {
        const set = reasons.get(providerId) ?? new Set();
        set.add(reason);
        reasons.set(providerId, set);
    };
    const addModelReason = (alias, workload, reason) => {
        const resolved = resolveModelSelectionForWorkload(alias, workload);
        if (resolved.ok)
            addReason(resolved.entry.modelRoute.id, reason);
    };
    addModelReason(chatModel, 'chat', `main model ${chatModel}`);
    addModelReason(chatModel, 'one_time_job', 'one-time jobs inherit main model');
    addModelReason(chatModel, 'recurring_job', 'recurring jobs inherit main model');
    if (memoryEnabled) {
        addModelReason(memoryModels.extractor, 'memory_extractor', `memory LLM extractor ${memoryModels.extractor}`);
        addModelReason(memoryModels.dreaming, 'memory_dreaming', `memory LLM dreaming ${memoryModels.dreaming}`);
        addModelReason(memoryModels.consolidation, 'memory_consolidation', `memory LLM consolidation ${memoryModels.consolidation}`);
        if (embeddingsEnabled) {
            addReason('openai', 'memory embeddings');
        }
    }
    return requiredModelCredentialProvidersForSetupDraft(draft).map((providerId) => ({
        providerId,
        reasons: [...(reasons.get(providerId) ?? [])].sort(),
    }));
}
function memoryDefaultsForChatModel(chatModel) {
    const resolved = resolveModelSelectionForWorkload(chatModel, 'chat');
    return memoryModelDefaultsForProvider(resolved.ok ? resolved.entry.modelRoute.id : 'anthropic');
}
function formatProviderIds(providerIds) {
    return providerIds.length > 0 ? providerIds.join(', ') : 'none';
}
async function tryListReadyModelCredentialProviders(runtimeHome) {
    try {
        return await listReadyModelCredentialProviders(runtimeHome);
    }
    catch {
        return new Set();
    }
}
