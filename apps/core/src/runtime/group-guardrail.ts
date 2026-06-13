import type {
  MessageSendOptions,
  NewMessage,
  ConversationRoute,
} from '../domain/types.js';
import {
  customerVisibleGuardrailResponse,
  evaluateAgentGuardrail,
} from '../application/guardrails/guardrail-service.js';
import { resolveGuardrailPolicy } from '../application/guardrails/policy-registry.js';
import type {
  GuardrailClassifier,
  GuardrailContextMessage,
} from '../application/guardrails/types.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../shared/message-cursor.js';
import { isFlowLogEnabled } from '../shared/flow-log.js';
import type { GroupProcessingDeps } from './group-processing-types.js';
import { loadGuardrailContext } from './guardrail-context.js';
import type { RuntimeMessageRepository } from '../domain/repositories/ops-repo.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';

/**
 * Timed guardrail stage for the per-reply latency trace. Additive — carried
 * alongside the existing decision fields, never replacing them.
 */
export interface GuardrailStageTrace {
  ms: number;
  startedAt: number;
  detail: {
    mode: string;
    decision: string;
    reason?: string;
    inlineAttached: boolean;
  };
}

export type PreAgentGuardrailResult =
  | { handled: true; guardrailTrace?: GuardrailStageTrace }
  | {
      handled: false;
      systemPromptAppend?: string;
      guardrailReason?: string;
      guardrailTrace?: GuardrailStageTrace;
    };

export async function handlePreAgentGuardrail(input: {
  group: ConversationRoute;
  messages: readonly NewMessage[];
  latestMessage: NewMessage;
  chatJid: string;
  queueJid: string;
  /**
   * Recent prior turns (oldest→newest, role-tagged) that precede `messages`, so
   * the policy can judge a follow-up in context. Optional — absent → the
   * guardrail screens this turn statelessly, as before.
   */
  recentContext?: readonly GuardrailContextMessage[];
  guardrailClassifier?: GuardrailClassifier;
  allowInlineSystemPromptAppend?: boolean;
  sendMessage: (text: string, options?: MessageSendOptions) => Promise<void>;
  buildMessageOptions: (threadId?: string) => MessageSendOptions | undefined;
  setCursor: GroupProcessingDeps['setCursor'];
  saveState: GroupProcessingDeps['saveState'];
  info: (metadata: Record<string, unknown>, message: string) => void;
}): Promise<PreAgentGuardrailResult> {
  const guardrail = input.group.agentConfig?.plugins?.guardrail;
  if (!guardrail) return { handled: false };

  // Resolve the agent's guardrail plugin by its declared file name
  // (`plugins.guardrail.file`) from the runtime folder, or the generic
  // domain-free fallback if that file is missing/invalid. The deterministic
  // layer and classifier prompt come from the resolved policy — core holds no
  // agent content.
  const { policy, source } = await resolveGuardrailPolicy(
    input.group.folder,
    guardrail.file,
  );

  const guardrailStartedAt = currentTimeMs();
  const decision = await evaluateAgentGuardrail({
    config: guardrail,
    messages: input.messages.map((message) => message.content),
    classifier: input.guardrailClassifier,
    policy,
    context: input.recentContext,
    allowInlineSystemPromptAppend: input.allowInlineSystemPromptAppend,
  });
  // Per-reply latency trace (additive; never alters the decision). Records the
  // stage duration and a generic summary of the decision.
  const inlineAttached =
    decision.action === 'allow' && Boolean(decision.systemPromptAppend);
  const guardrailTrace: GuardrailStageTrace = {
    ms: currentTimeMs() - guardrailStartedAt,
    startedAt: guardrailStartedAt,
    detail: {
      mode: guardrail.mode ?? 'both',
      decision: decision.action,
      ...(decision.reason ? { reason: decision.reason } : {}),
      inlineAttached,
    },
  };
  // Flow trace: include the text the guardrail judged so the decision is
  // explainable in the test harness (opt-in; off in production).
  const flowFields = isFlowLogEnabled()
    ? {
        flow: 'guardrail',
        // chatJid keeps the decision attributable to one conversation so a
        // harness driving several conversations in parallel never crosses
        // traces (opt-in; off in production).
        chatJid: input.chatJid,
        inboundText: input.latestMessage.content,
        guardrailContextTurns: input.recentContext?.length ?? 0,
      }
    : {};
  if (decision.action === 'direct_response') {
    await input.sendMessage(
      customerVisibleGuardrailResponse(policy, decision.responseKind),
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
        guardrailFile: guardrail.file,
        guardrailPolicyId: policy.id,
        guardrailSource: source,
        guardrailDecision: decision.responseKind,
        guardrailReason: decision.reason,
        ...flowFields,
      },
      'Guardrail handled message before agent spawn',
    );
    return { handled: true, guardrailTrace };
  }

  input.info(
    {
      group: input.group.name,
      guardrailFile: guardrail.file,
      guardrailPolicyId: policy.id,
      guardrailSource: source,
      guardrailReason: decision.reason,
      ...flowFields,
    },
    'Guardrail allowed message for agent processing',
  );
  return {
    handled: false,
    ...(decision.systemPromptAppend
      ? { systemPromptAppend: decision.systemPromptAppend }
      : {}),
    guardrailReason: decision.reason,
    guardrailTrace,
  };
}

/**
 * Load recent context and run the pre-agent guardrail for one batch — the single
 * screening entry point shared by the spawn (processGroupMessages) and
 * continuation (runMessagePollingTick) paths. Returns true when it handled the batch.
 */
export async function screenBatchPreAgent(input: {
  repository: RuntimeMessageRepository;
  group: ConversationRoute;
  chatJid: string;
  queueJid: string;
  threadId?: string | null;
  messages: readonly NewMessage[];
  guardrailClassifier?: GuardrailClassifier;
  allowInlineSystemPromptAppend?: boolean;
  sendMessage: (text: string, options?: MessageSendOptions) => Promise<void>;
  buildMessageOptions: (threadId?: string) => MessageSendOptions | undefined;
  setCursor: GroupProcessingDeps['setCursor'];
  saveState: GroupProcessingDeps['saveState'];
  info: (metadata: Record<string, unknown>, message: string) => void;
}): Promise<PreAgentGuardrailResult> {
  if (input.messages.length === 0) return { handled: false };
  const latestMessage = input.messages[input.messages.length - 1];
  const recentContext = await loadGuardrailContext({
    repository: input.repository,
    chatJid: input.chatJid,
    threadId: input.threadId ?? null,
    excludeMessageIds: new Set(input.messages.map((m) => m.id)),
  });
  return handlePreAgentGuardrail({
    group: input.group,
    messages: input.messages,
    latestMessage,
    chatJid: input.chatJid,
    queueJid: input.queueJid,
    recentContext,
    guardrailClassifier: input.guardrailClassifier,
    allowInlineSystemPromptAppend: input.allowInlineSystemPromptAppend,
    sendMessage: input.sendMessage,
    buildMessageOptions: input.buildMessageOptions,
    setCursor: input.setCursor,
    saveState: input.saveState,
    info: input.info,
  });
}
