import {
  claimPermissionInteractionCallback,
  recoverDurablePermissionDecision,
  releasePermissionInteractionCallback,
} from '../application/interactions/pending-interaction-durability.js';
import type { PermissionApprovalRequest } from '../domain/types.js';
import {
  decisionForMode,
  permissionDecisionOptions,
} from './permission-interaction.js';
import { parsePermissionCustomId } from './discord-components.js';
import type { DiscordInteraction } from './discord-types.js';
import {
  DISCORD_API_ROOT,
  discordHeaders,
} from './discord-interaction-helpers.js';
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
  feedback: (content: string) => Promise<void>;
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
  if (!userId) {
    await input.feedback('This permission request is no longer active.');
    return;
  }
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
  feedback: (content: string) => Promise<void>;
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
  if (!channelId || !messageId) {
    await input.feedback('This permission request is no longer active.');
    return;
  }
  const context = await input.resolveConversationContext(channelId);
  await recoverDurablePermissionDecision({
    locator: {
      kind: 'message',
      appId: input.appId,
      provider: 'discord',
      conversationId: context.conversationJid.replace(/^dc:/, ''),
      externalMessageId: messageId,
      ...(context.threadId ? { threadId: context.threadId } : {}),
      providerAlias: input.parsed.providerAlias,
    },
    surfaceJid: context.conversationJid,
    incomingMode: input.parsed.mode,
    incomingApprover: input.userId,
    authorize: (durable) =>
      input.isApproverAllowed(
        input.userId,
        durable.sourceAgentFolder,
        durable.decisionPolicy as PermissionApprovalRequest['decisionPolicy'],
        durable.threadId ?? undefined,
        durable.approvalContextJid ?? undefined,
      ),
    terminalize: async (receipt) => {
      if (receipt.status === 'resolved') {
        return consume(
          {
            channelId,
            externalMessageId: messageId,
            request: receipt.request,
          },
          input,
          receipt.decision,
        );
      }
      const response = await fetch(
        `${DISCORD_API_ROOT}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
        {
          method: 'PATCH',
          headers: discordHeaders(input.botToken),
          body: JSON.stringify({ content: receipt.text, components: [] }),
        },
      );
      return response.ok;
    },
    feedback: input.feedback,
  });
}
