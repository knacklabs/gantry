import { resolveModelSelectionForWorkload, } from '../../shared/model-catalog.js';
import { resolveExecutionRoute } from '../../shared/model-execution-route.js';
export class LlmProfileResolutionService {
    resolve(input) {
        const resolved = resolveModelSelectionForWorkload(input.profile.modelAlias, input.workload);
        if (!resolved.ok) {
            return {
                ok: false,
                reason: resolved.reason === 'duplicate-alias' ? 'unknown' : resolved.reason,
                message: resolved.message,
            };
        }
        const executionRoute = resolveExecutionRoute({
            entry: resolved.entry,
            agentHarness: input.agentHarness,
        });
        if (!executionRoute.ok) {
            return {
                ok: false,
                reason: executionRoute.reason,
                message: executionRoute.message,
            };
        }
        const agentEngine = executionRoute.value.engine;
        const credentialProfileRef = input.profile.credentialProfileRef ?? resolved.entry.credentialProfileRef;
        return {
            ok: true,
            value: {
                profile: input.profile,
                alias: resolved.alias,
                modelEntry: resolved.entry,
                runnerModel: resolved.runnerModel,
                responseFamily: resolved.entry.responseFamily,
                modelRoute: {
                    id: resolved.entry.modelRoute.id,
                    label: resolved.entry.modelRoute.label,
                    metadata: {
                        providerModelId: resolved.entry.modelRoute.providerModelId,
                    },
                },
                executionProviderId: executionRoute.value.executionProviderId,
                agentEngine,
                supportedCredentialModes: executionRoute.value.supportedCredentialModes,
                credentialProfileRef,
                capabilities: resolved.entry.capabilities,
            },
        };
    }
}
