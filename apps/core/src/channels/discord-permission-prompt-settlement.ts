import type {
  MessageDeliveryResult,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionCallbackScope,
} from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  DISCORD_API_ROOT,
  discordHeaders,
} from './discord-interaction-helpers.js';
import { formatPermissionReceiptText } from './permission-interaction.js';

export interface PendingDiscordPermission {
  callback: {
    providerAlias: string;
    scope: PermissionCallbackScope;
    matchKind: 'individual' | 'batch';
  };
  request: PermissionApprovalRequest;
  channelId: string;
  externalMessageId?: string;
  resolve: (decision: PermissionApprovalDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const settling = new WeakSet<object>();

export function timeoutRetryDelays(timeoutMs: number): [number, number] {
  const firstDelay = Math.floor(timeoutMs / 3);
  return [firstDelay, timeoutMs - firstDelay];
}

export function pending(
  callback: PendingDiscordPermission['callback'],
  request: PermissionApprovalRequest,
  sent: MessageDeliveryResult,
  channelId: string,
  resolve: PendingDiscordPermission['resolve'],
  timeout: ReturnType<typeof setTimeout>,
): PendingDiscordPermission {
  return {
    callback,
    request,
    channelId,
    externalMessageId:
      sent.externalMessageIds?.at(-1) ?? sent.externalMessageId,
    resolve,
    timeout,
  };
}

export function drop(
  pendingPermissions: Map<string, PendingDiscordPermission>,
  request: Pick<
    PermissionApprovalRequest,
    'appId' | 'sourceAgentFolder' | 'requestId'
  >,
): void {
  for (const [providerAlias, live] of pendingPermissions) {
    if (
      live.request.requestId !== request.requestId ||
      live.request.sourceAgentFolder !== request.sourceAgentFolder ||
      (live.request.appId || 'default') !== (request.appId || 'default')
    ) {
      continue;
    }
    clearTimeout(live.timeout);
    pendingPermissions.delete(providerAlias);
  }
}

export async function consume(
  pending: Pick<PendingDiscordPermission, 'channelId' | 'externalMessageId'> & {
    request: PermissionApprovalRequest | null;
  },
  input: { botToken: string },
  decision: PermissionApprovalDecision,
): Promise<boolean> {
  if (settling.has(pending)) return false;
  settling.add(pending);
  try {
    const messageId = pending.externalMessageId;
    if (messageId) {
      const approved = decision.approved && decision.mode !== 'cancel';
      const url = `${DISCORD_API_ROOT}/channels/${encodeURIComponent(pending.channelId)}/messages/${encodeURIComponent(messageId)}`;
      if (approved) {
        try {
          const response = await fetch(url, {
            method: 'DELETE',
            headers: discordHeaders(input.botToken),
          });
          if (!response.ok)
            throw new Error('Discord permission prompt delete failed');
          return true;
        } catch (err) {
          logger.debug(
            {
              requestId:
                pending.request?.requestId ??
                decision.permissionCallbackClaim?.scope.interactionId,
              err,
            },
            'Failed to delete approved Discord permission prompt; replacing with fallback receipt',
          );
        }
      }
      const response = await fetch(url, {
        method: 'PATCH',
        headers: discordHeaders(input.botToken),
        body: JSON.stringify({
          content:
            decision.reason === 'timed out'
              ? 'Permission request timed out.'
              : pending.request
                ? formatPermissionReceiptText(
                    pending.request.requestId,
                    pending.request,
                    decision,
                  )
                : approved
                  ? 'Permission allowed.'
                  : 'Permission request denied.',
          components: [],
        }),
      });
      if (!response.ok)
        throw new Error('Discord permission prompt update failed');
    }
    return true;
  } catch (err) {
    settling.delete(pending);
    throw err;
  }
}

export async function settle(
  pendingPermissions: Map<string, PendingDiscordPermission>,
  providerAlias: string,
  decision: PermissionApprovalDecision,
  input: { botToken: string },
): Promise<boolean> {
  const pending = pendingPermissions.get(providerAlias);
  if (!pending) return false;
  try {
    if (!(await consume(pending, input, decision))) return false;
  } catch (err) {
    logger.debug(
      { requestId: pending.request.requestId, err },
      'Failed to settle Discord permission prompt message',
    );
    return false;
  }
  clearTimeout(pending.timeout);
  pendingPermissions.delete(providerAlias);
  pending.resolve(decision);
  return true;
}
