import { normalizeRuntimeEventConversationId } from '../domain/events/runtime-event-conversation.js';
import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventType,
} from '../domain/events/runtime-event-types.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { normalizeEgressHost } from '../shared/egress-policy.js';
import type {
  EgressGatewayPrincipal,
  EgressGatewayUpstreamProxy,
  EgressNetworkAttribution,
} from './egress-gateway.js';

export interface EgressAuditState {
  principal: EgressGatewayPrincipal;
  networkAttribution: Map<string, EgressNetworkAttribution>;
  upstreamProxy?: EgressGatewayUpstreamProxy;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
  logger: {
    info: (context: Record<string, unknown>, message: string) => void;
    warn: (context: Record<string, unknown>, message: string) => void;
  };
}

export async function auditConnect(
  state: EgressAuditState,
  decision: {
    host: string;
    port?: number;
    allowed: boolean;
    denied: boolean;
    reason: string;
    matchedPattern?: string;
  },
): Promise<void> {
  const attribution =
    decision.port === undefined
      ? undefined
      : state.networkAttribution.get(
          `${normalizeEgressHost(decision.host)}:${decision.port}`,
        );
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
  if (!state.publishRuntimeEvent) return;
  const eventConversationId = normalizeRuntimeEventConversationId(
    state.principal.conversationId as never,
  );
  try {
    await state.publishRuntimeEvent({
      appId: state.principal.appId as never,
      ...(state.principal.agentId
        ? { agentId: state.principal.agentId as never }
        : {}),
      ...(eventConversationId
        ? { conversationId: eventConversationId as never }
        : {}),
      eventType: RUNTIME_EVENT_TYPES.EGRESS_CONNECT as RuntimeEventType,
      actor: 'egress-gateway',
      responseMode: 'none',
      payload,
    });
  } catch (err) {
    state.logger.warn(
      { err, host: decision.host, principal: payload.principal },
      'Egress CONNECT audit persistence failed',
    );
  }
}
