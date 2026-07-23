import {
  findDurablePermissionInteractionByPromptMessage,
  findDurablePermissionInteractionByRequestId,
} from '../application/interactions/pending-interaction-durability.js';
import type { PermissionApprovalRequest } from '../domain/types.js';
import {
  buildPermissionPromptParts,
  type PermissionPromptFullView,
} from './permission-interaction.js';
import {
  DISCORD_API_ROOT,
  discordHeaders,
} from './discord-interaction-helpers.js';
import type { PendingDiscordPermission } from './discord-permission-prompt-settlement.js';
import type { DiscordInteraction } from './discord-types.js';

export const DISCORD_PERMISSION_FULL_VIEW_PREFIX = 'gantry:perm_full:';
const DISCORD_EPHEMERAL_MESSAGE_LIMIT = 1900;

export function discordPermissionFullViewCustomId(
  providerAlias: string,
): string {
  return `${DISCORD_PERMISSION_FULL_VIEW_PREFIX}${providerAlias}`;
}

export async function handleDiscordPermissionFullView(input: {
  interaction: DiscordInteraction;
  customId: string;
  appId: string;
  applicationId: string;
  botToken: string;
  timeoutMs: number;
  pendingPermissions: Map<string, PendingDiscordPermission>;
  resolveConversationContext: (
    channelId: string,
  ) => Promise<{ conversationJid: string; threadId?: string }>;
  isApproverAllowed: (
    userId: string | undefined,
    sourceAgentFolder: string,
    decisionPolicy: PermissionApprovalRequest['decisionPolicy'],
    threadId?: string,
    conversationJid?: string,
  ) => Promise<boolean>;
  acknowledge: (content: string) => Promise<void>;
}): Promise<void> {
  const providerAlias = providerAliasFromCustomId(input.customId);
  if (!providerAlias) {
    await input.acknowledge('This approval is no longer active.');
    return;
  }
  const pending = input.pendingPermissions.get(providerAlias);
  const userId = (input.interaction.member?.user || input.interaction.user)?.id;
  let fullView: PermissionPromptFullView | undefined;
  if (pending) {
    if (
      !(await input.isApproverAllowed(
        userId,
        pending.request.sourceAgentFolder,
        pending.request.decisionPolicy,
        pending.request.threadId,
        pending.request.approvalContextJid ?? pending.request.targetJid,
      ))
    ) {
      await input.acknowledge(
        'You are not allowed to view this approval payload.',
      );
      return;
    }
    fullView = buildPermissionPromptParts(
      pending.request,
      input.timeoutMs,
    ).fullView;
  } else {
    const messageId = input.interaction.message?.id;
    const channelId = input.interaction.channel_id;
    const context = channelId
      ? await input.resolveConversationContext(channelId)
      : null;
    const prompt =
      messageId && context
        ? await findDurablePermissionInteractionByPromptMessage({
            appId: input.appId,
            provider: 'discord',
            conversationId: context.conversationJid.replace(/^dc:/, ''),
            externalMessageId: messageId,
            ...(context.threadId ? { threadId: context.threadId } : {}),
            providerAlias,
          })
        : null;
    const durable = prompt
      ? await findDurablePermissionInteractionByRequestId({
          scope: prompt.scope,
          providerAlias,
        })
      : null;
    if (!durable || durable.targetJid !== context?.conversationJid) {
      await input.acknowledge('This approval is no longer active.');
      return;
    }
    if (
      !(await input.isApproverAllowed(
        userId,
        durable.sourceAgentFolder,
        durable.decisionPolicy as PermissionApprovalRequest['decisionPolicy'],
        durable.threadId ?? undefined,
        durable.approvalContextJid ?? undefined,
      ))
    ) {
      await input.acknowledge(
        'You are not allowed to view this approval payload.',
      );
      return;
    }
    fullView = durable.fullView;
  }
  if (!fullView) {
    await input.acknowledge('This approval has no full payload.');
    return;
  }
  if (fullView.content.length <= DISCORD_EPHEMERAL_MESSAGE_LIMIT) {
    await input.acknowledge(
      `${fullView.title}\n\`\`\`\n${fullView.content}\n\`\`\``,
    );
    return;
  }
  await deferEphemeralInteraction(input.interaction, input.botToken);
  await postDiscordInteractionFollowupFile(
    input.interaction,
    input.applicationId,
    fullView,
  );
}

function providerAliasFromCustomId(customId: string): string | null {
  if (!customId.startsWith(DISCORD_PERMISSION_FULL_VIEW_PREFIX)) return null;
  return customId.slice(DISCORD_PERMISSION_FULL_VIEW_PREFIX.length) || null;
}

async function deferEphemeralInteraction(
  interaction: DiscordInteraction,
  botToken: string,
): Promise<void> {
  await fetch(
    `${DISCORD_API_ROOT}/interactions/${encodeURIComponent(interaction.id || '')}/${encodeURIComponent(interaction.token || '')}/callback`,
    {
      method: 'POST',
      headers: discordHeaders(botToken),
      body: JSON.stringify({ type: 5, data: { flags: 64 } }),
    },
  );
}

async function postDiscordInteractionFollowupFile(
  interaction: DiscordInteraction,
  applicationId: string,
  fullView: PermissionPromptFullView,
): Promise<void> {
  const form = new FormData();
  form.set(
    'payload_json',
    JSON.stringify({
      content: fullView.title,
      flags: 64,
      allowed_mentions: { parse: [] },
      attachments: [
        {
          id: 0,
          filename: fullView.filename,
          description: fullView.title,
        },
      ],
    }),
  );
  form.set(
    'files[0]',
    new Blob([fullView.content], { type: 'text/plain' }),
    fullView.filename,
  );
  await fetch(
    `${DISCORD_API_ROOT}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interaction.token || '')}`,
    { method: 'POST', body: form },
  );
}
