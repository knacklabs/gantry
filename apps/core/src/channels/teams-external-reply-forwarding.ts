import { createHmac, randomUUID } from 'node:crypto';

import { envValueDynamic } from '../config/env/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { TeamsInboundMessage } from './teams.js';

const HOOK_PATH = '/hooks/gantry/teams-reply';

export async function forwardExternalTeamsReply(
  message: TeamsInboundMessage,
): Promise<boolean> {
  const hookUrl = resolveTeamsReplyHookUrl();
  if (!hookUrl) return false;

  const body = buildTeamsReplyHookBody(message);
  if (!body) return false;

  const rawBody = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const secret = resolveTeamsReplyHookSecret();
  if (!secret) {
    logger.warn('External Teams reply hook is configured without a signing secret');
    return true;
  }

  const response = await fetch(hookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gantry-teams-reply-timestamp': timestamp,
      'x-gantry-teams-reply-nonce': nonce,
      'x-gantry-teams-reply-signature': signTeamsReplyHookRequest({
        secret,
        method: 'POST',
        path: new URL(hookUrl).pathname,
        timestamp,
        nonce,
        rawBody,
      }),
    },
    body: rawBody,
    signal: AbortSignal.timeout(
      Number(envValueDynamic('GANTRY_EXTERNAL_TEAMS_REPLY_TIMEOUT_MS')) || 5000,
    ),
  });
  if (!response.ok) {
    logger.warn(
      {
        status: response.status,
        conversationId: message.conversationId,
        messageId: message.id,
      },
      'External Teams reply hook failed',
    );
  }
  return true;
}

function buildTeamsReplyHookBody(
  message: TeamsInboundMessage,
): Record<string, string> | null {
  const text = message.text?.trim();
  const channelId = canonicalTeamsConversationId(message.conversationId);
  const replyToId =
    readNonEmptyString(message.replyToId) ??
    teamsMessageIdFromConversationId(message.conversationId);
  const messageId = readNonEmptyString(message.id);
  const teamsTenantId = readNonEmptyString(message.tenantId);
  const teamsUserId = readNonEmptyString(message.senderId ?? message.from?.id);
  if (
    !text ||
    !channelId ||
    !replyToId ||
    !messageId ||
    !teamsTenantId ||
    !teamsUserId
  ) {
    return null;
  }
  return {
    channelId,
    conversationId: channelId,
    replyToId,
    messageId,
    text,
    teamsTenantId,
    teamsUserId,
  };
}

function resolveTeamsReplyHookUrl(): string | null {
  const explicit = envValueDynamic('GANTRY_EXTERNAL_TEAMS_REPLY_URL');
  if (explicit) return explicit;
  const platformGraphqlUrl = envValueDynamic(
    'GANTRY_EXTERNAL_PLATFORM_GRAPHQL_URL',
  );
  if (!platformGraphqlUrl) return null;
  const url = new URL(platformGraphqlUrl);
  url.pathname = HOOK_PATH;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function resolveTeamsReplyHookSecret(): string | null {
  return (
    envValueDynamic('GANTRY_EXTERNAL_TEAMS_REPLY_SECRET') ||
    envValueDynamic('GANTRY_EXTERNAL_EVENT_SECRET') ||
    null
  );
}

function signTeamsReplyHookRequest(input: {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}): string {
  return createHmac('sha256', input.secret)
    .update(
      [
        input.method.trim().toUpperCase(),
        input.path.trim(),
        input.timestamp.trim(),
        input.nonce.trim(),
        input.rawBody,
      ].join('\n'),
    )
    .digest('hex');
}

function canonicalTeamsConversationId(value: string): string | null {
  const raw = value.startsWith('teams:')
    ? value.slice('teams:'.length).trim()
    : value.trim();
  return raw.split(';messageid=')[0]?.trim() || null;
}

function teamsMessageIdFromConversationId(value: string): string | null {
  const match = /;messageid=([^;]+)/.exec(value);
  return match?.[1]?.trim() || null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export const _testExternalTeamsReplyForwarding = {
  buildTeamsReplyHookBody,
  canonicalTeamsConversationId,
  teamsMessageIdFromConversationId,
};
