import type {
  MessageSendOptions,
  NewMessage,
  ConversationRoute,
} from '../domain/types.js';
import {
  customerVisibleGuardrailResponse,
  evaluateAgentGuardrail,
} from '../application/guardrails/guardrail-service.js';
import type { GuardrailClassifier } from '../application/guardrails/types.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../shared/message-cursor.js';
import { isFlowLogEnabled } from '../shared/flow-log.js';
import type { GroupProcessingDeps } from './group-processing-types.js';

export async function handlePreAgentGuardrail(input: {
  group: ConversationRoute;
  messages: readonly NewMessage[];
  latestMessage: NewMessage;
  queueJid: string;
  guardrailClassifier?: GuardrailClassifier;
  sendMessage: (text: string, options?: MessageSendOptions) => Promise<void>;
  buildMessageOptions: (threadId?: string) => MessageSendOptions | undefined;
  setCursor: GroupProcessingDeps['setCursor'];
  saveState: GroupProcessingDeps['saveState'];
  info: (metadata: Record<string, unknown>, message: string) => void;
}): Promise<boolean> {
  const guardrail = input.group.agentConfig?.guardrail;
  if (!guardrail) return false;

  const decision = await evaluateAgentGuardrail({
    config: guardrail,
    messages: input.messages.map((message) => message.content),
    classifier: input.guardrailClassifier,
  });
  // Flow trace: include the text the guardrail judged so the decision is
  // explainable in the test harness (opt-in; off in production).
  const flowFields = isFlowLogEnabled()
    ? { flow: 'guardrail', inboundText: input.latestMessage.content }
    : {};
  if (decision.action === 'direct_response') {
    await input.sendMessage(
      customerVisibleGuardrailResponse(guardrail, decision.responseKind),
      input.buildMessageOptions(input.latestMessage.thread_id),
    );
    input.setCursor(
      input.queueJid,
      encodeGroupMessageCursor(toGroupMessageCursor(input.latestMessage)),
    );
    await input.saveState();
    input.info(
      {
        group: input.group.name,
        guardrailPolicy: guardrail.policy,
        guardrailDecision: decision.responseKind,
        guardrailReason: decision.reason,
        ...flowFields,
      },
      'Guardrail handled message before agent spawn',
    );
    return true;
  }

  input.info(
    {
      group: input.group.name,
      guardrailPolicy: guardrail.policy,
      guardrailReason: decision.reason,
      ...flowFields,
    },
    'Guardrail allowed message for agent processing',
  );
  return false;
}
