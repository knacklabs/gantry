import { normalizeRuntimeEventConversationId } from '../domain/events/runtime-event-conversation.js';
import { RUNTIME_EVENT_TYPES, } from '../domain/events/runtime-event-types.js';
import { normalizeEgressHost } from '../shared/egress-policy.js';
export async function auditConnect(state, decision) {
    const attribution = decision.port === undefined
        ? undefined
        : state.networkAttribution.get(`${normalizeEgressHost(decision.host)}:${decision.port}`);
    const payload = {
        host: decision.host,
        principal: state.principal.agentId || state.principal.appId,
        allowed: decision.allowed,
        denied: decision.denied,
        reason: decision.reason,
        ...(decision.matchedPattern
            ? { matchedPattern: decision.matchedPattern }
            : {}),
        ...(attribution
            ? {
                capabilityId: attribution.capabilityId,
                capabilityLabel: attribution.capabilityLabel,
            }
            : {}),
        provider: state.upstreamProxy?.provider ?? 'direct',
        conversationId: state.principal.conversationId,
        runId: state.principal.runId,
    };
    state.logger.info(payload, 'Egress CONNECT decision');
    if (!state.publishRuntimeEvent)
        return;
    const eventConversationId = normalizeRuntimeEventConversationId(state.principal.conversationId);
    try {
        await state.publishRuntimeEvent({
            appId: state.principal.appId,
            ...(state.principal.agentId
                ? { agentId: state.principal.agentId }
                : {}),
            ...(eventConversationId
                ? { conversationId: eventConversationId }
                : {}),
            eventType: RUNTIME_EVENT_TYPES.EGRESS_CONNECT,
            actor: 'egress-gateway',
            responseMode: 'none',
            payload,
        });
    }
    catch (err) {
        state.logger.warn({ err, host: decision.host, principal: payload.principal }, 'Egress CONNECT audit persistence failed');
    }
}
