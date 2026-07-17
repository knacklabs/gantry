import {
  claimPermissionInteractionCallback,
  findDurablePermissionInteractionByPromptMessage,
  findDurablePermissionInteractionByRequestId,
  releasePermissionInteractionCallback,
  resolveDurablePermissionInteractionByRequestId,
} from '../application/interactions/pending-interaction-durability.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionCallbackClaim,
  PermissionCallbackClaimReference,
} from '../domain/types.js';
import {
  decisionForMode,
  permissionDecisionOptions,
} from './permission-interaction.js';
import { parsePermissionCustomId } from './discord-components.js';
import type { DiscordInteraction } from './discord-types.js';
import {
  consume,
  settle,
  type PendingDiscordPermission,
} from './discord-permission-prompt-settlement.js';

type DiscordConversationContext = {
  conversationJid: string;
  threadId?: string;
};

export async function handleDiscordPermissionCallback(input: {
  appId: string;
  interaction: DiscordInteraction;
  customId: string;
  pendingPermissions: Map<string, PendingDiscordPermission>;
  botToken: string;
  ack: (content: string) => Promise<void>;
  resolveConversationContext: (
    channelId: string,
  ) => Promise<DiscordConversationContext>;
  isApproverAllowed: (
    userId: string | undefined,
    sourceAgentFolder: string,
    decisionPolicy: PermissionApprovalRequest['decisionPolicy'],
    threadId?: string,
    conversationJid?: string,
  ) => Promise<boolean>;
}): Promise<void> {
  const parsed = parsePermissionCustomId(input.customId);
  if (!parsed) {
    await input.ack('This approval is no longer active.');
    return;
  }
  await input.ack('Processing.');
  const pending = input.pendingPermissions.get(parsed.providerAlias);
  const user = input.interaction.member?.user || input.interaction.user;
  const userId = user?.id;
  if (!userId) return;
  if (!pending) {
    await recoverDurablePermission({ ...input, parsed, userId });
    return;
  }
  if (
    !(await input.isApproverAllowed(
      userId,
      pending.request.sourceAgentFolder,
      pending.request.decisionPolicy,
      pending.request.threadId,
      pending.request.approvalContextJid ?? pending.request.targetJid,
    )) ||
    !permissionDecisionOptions(pending.request).includes(parsed.mode)
  ) {
    return;
  }
  const claimed = await claimPermissionInteractionCallback({
    scope: pending.callback.scope,
    mode: parsed.mode,
    approverRef: userId,
    matchKind: pending.callback.matchKind,
    providerAlias: parsed.providerAlias,
  });
  if (claimed.status === 'already_decided') return;
  if (claimed.status === 'retryable') return;
  const decision = {
    ...decisionForMode(pending.request, parsed.mode, userId),
    permissionCallbackClaim: claimed.claim,
  };
  if (
    !(await settle(
      input.pendingPermissions,
      parsed.providerAlias,
      decision,
      input,
    ))
  ) {
    await releasePermissionInteractionCallback({ claim: claimed.claim });
  }
}

async function recoverDurablePermission(input: {
  appId: string;
  interaction: DiscordInteraction;
  parsed: ReturnType<typeof parsePermissionCustomId> & {};
  userId: string;
  botToken: string;
  resolveConversationContext: (
    channelId: string,
  ) => Promise<DiscordConversationContext>;
  isApproverAllowed: (
    userId: string | undefined,
    sourceAgentFolder: string,
    decisionPolicy: PermissionApprovalRequest['decisionPolicy'],
    threadId?: string,
    conversationJid?: string,
  ) => Promise<boolean>;
}): Promise<void> {
  const channelId = input.interaction.channel_id;
  const messageId = input.interaction.message?.id;
  if (!channelId || !messageId) return;
  const context = await input.resolveConversationContext(channelId);
  const promptIdentity = {
    appId: input.appId,
    provider: 'discord',
    conversationId: context.conversationJid.replace(/^dc:/, ''),
    externalMessageId: messageId,
    ...(context.threadId ? { threadId: context.threadId } : {}),
  };
  const activePrompt = await findDurablePermissionInteractionByPromptMessage({
    ...promptIdentity,
    providerAlias: input.parsed.providerAlias,
  });
  const prompt =
    activePrompt ??
    (await findDurablePermissionInteractionByPromptMessage(promptIdentity));
  if (!prompt) return;
  if (
    !activePrompt &&
    (!prompt.claim ||
      !prompt.claim.match.providerAliases.includes(input.parsed.providerAlias))
  ) {
    return;
  }
  const durable = await findDurablePermissionInteractionByRequestId({
    scope: prompt.scope,
  });
  if (!durable) return;
  const matchKind = prompt.claim?.match.kind ?? prompt.matchKind;
  if (
    durable.targetJid !== context.conversationJid ||
    !(await input.isApproverAllowed(
      input.userId,
      durable.sourceAgentFolder,
      durable.decisionPolicy as PermissionApprovalRequest['decisionPolicy'],
      durable.threadId ?? undefined,
      durable.approvalContextJid ?? undefined,
    )) ||
    !durable.decisionOptions.includes(input.parsed.mode)
  ) {
    return;
  }
  const claimed = prompt.claim
    ? { status: 'claimed' as const, claim: prompt.claim }
    : await claimPermissionInteractionCallback({
        scope: prompt.scope,
        mode: input.parsed.mode,
        approverRef: input.userId,
        matchKind,
        providerAlias: input.parsed.providerAlias,
      });
  if (claimed.status === 'already_decided') return;
  if (claimed.status === 'retryable') return;
  const decision = recoveredDiscordPermissionDecision(
    durable.request,
    prompt.claim,
    input.parsed.mode,
    input.userId,
    claimed.claim,
    matchKind,
  );
  try {
    if (
      !(await consume(
        {
          channelId,
          externalMessageId: messageId,
          request: durable.request,
        },
        input,
        decision,
      ))
    ) {
      await releasePermissionInteractionCallback({ claim: claimed.claim });
      return;
    }
  } catch {
    await releasePermissionInteractionCallback({ claim: claimed.claim });
    return;
  }
  await resolveDurablePermissionInteractionByRequestId({
    claim: claimed.claim,
    reason: 'resolved via Discord after channel restart',
  });
}

function recoveredDiscordPermissionDecision(
  request: PermissionApprovalRequest | null,
  persistedClaim: PermissionCallbackClaim | undefined,
  incomingMode: NonNullable<PermissionApprovalDecision['mode']>,
  incomingApprover: string,
  claim: PermissionCallbackClaimReference,
  matchKind: PermissionCallbackClaim['match']['kind'],
): PermissionApprovalDecision {
  const mode = persistedClaim?.intent.mode ?? incomingMode;
  const approverRef = persistedClaim?.intent.approverRef ?? incomingApprover;
  const decision = request
    ? decisionForMode(request, mode, approverRef, matchKind)
    : { approved: mode !== 'cancel', mode, decidedBy: approverRef };
  return { ...decision, permissionCallbackClaim: claim };
}
