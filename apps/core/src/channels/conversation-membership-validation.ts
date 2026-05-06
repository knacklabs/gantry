import type {
  ConversationMembershipValidationInput,
  ConversationMembershipValidationResult,
  ConversationMembershipValidator,
} from '../application/provider-conversations/conversation-administration-service.js';
import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
import { normalizeProviderId } from './provider-registry.js';

const TOKEN_BOUND_HTTP_GUIDANCE = 'Verify provider credentials and retry.';
const TELEGRAM_BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/;

export class RuntimeSecretConversationMembershipValidator implements ConversationMembershipValidator {
  constructor(private readonly secrets: RuntimeSecretProvider) {}

  async validateControlApprovers(
    input: ConversationMembershipValidationInput,
  ): Promise<ConversationMembershipValidationResult> {
    const providerId = normalizeProviderId(String(input.providerId));
    if (providerId === 'telegram') return this.validateTelegram(input);
    if (providerId === 'slack') return this.validateSlack(input);
    if (providerId === 'teams') return this.validateTeams(input);
    return {
      validUserIds: [],
      invalidUserIds: input.userIds,
      reason: `${providerId} conversation membership validation is not implemented.`,
    };
  }

  private async validateTelegram(
    input: ConversationMembershipValidationInput,
  ): Promise<ConversationMembershipValidationResult> {
    const token = this.resolveSecret(
      input.providerConnection.runtimeSecretRefs,
      ['TELEGRAM_BOT_TOKEN'],
    );
    if (!token) {
      return {
        validUserIds: [],
        invalidUserIds: input.userIds,
        reason: 'Telegram token is not configured.',
      };
    }
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) {
      return {
        validUserIds: [],
        invalidUserIds: input.userIds,
        reason: 'Telegram token is invalid.',
      };
    }
    const chatId = externalConversationValue(input).replace(/^tg:/, '');
    const checks = await Promise.all(
      input.userIds.map(async (userId) => {
        try {
          const response = await fetchWithTimeout(
            `https://api.telegram.org/bot${encodeURIComponent(token)}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(userId)}`,
          );
          if (!response.ok) {
            return { userId, valid: false };
          }
          const payload = (await response.json()) as {
            ok?: boolean;
            result?: { status?: string };
          };
          const status = payload.result?.status?.toLowerCase() || '';
          return {
            userId,
            valid:
              Boolean(payload.ok) &&
              Boolean(status) &&
              status !== 'left' &&
              status !== 'kicked',
          };
        } catch {
          return { userId, valid: false };
        }
      }),
    );
    const validUserIds = checks
      .filter((entry) => entry.valid)
      .map((entry) => entry.userId);
    const invalidUserIds = checks
      .filter((entry) => !entry.valid)
      .map((entry) => entry.userId);
    return {
      validUserIds,
      invalidUserIds,
      reason: invalidUserIds.length ? TOKEN_BOUND_HTTP_GUIDANCE : undefined,
    };
  }

  private async validateSlack(
    input: ConversationMembershipValidationInput,
  ): Promise<ConversationMembershipValidationResult> {
    const botToken = this.resolveSecret(
      input.providerConnection.runtimeSecretRefs,
      ['SLACK_BOT_TOKEN'],
    );
    if (!botToken) {
      return {
        validUserIds: [],
        invalidUserIds: input.userIds,
        reason: 'Slack bot token is not configured.',
      };
    }
    const channelId = externalConversationValue(input).replace(/^sl:/, '');
    try {
      const members = await this.listSlackMembers(botToken, channelId);
      const memberSet = new Set(members);
      return {
        validUserIds: input.userIds.filter((id) => memberSet.has(id)),
        invalidUserIds: input.userIds.filter((id) => !memberSet.has(id)),
      };
    } catch {
      return {
        validUserIds: [],
        invalidUserIds: input.userIds,
        reason: TOKEN_BOUND_HTTP_GUIDANCE,
      };
    }
  }

  private async listSlackMembers(
    botToken: string,
    channelId: string,
  ): Promise<string[]> {
    const members: string[] = [];
    let cursor = '';
    do {
      const url = new URL('https://slack.com/api/conversations.members');
      url.searchParams.set('channel', channelId);
      url.searchParams.set('limit', '1000');
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await fetchWithTimeout(url.toString(), {
        headers: { authorization: `Bearer ${botToken}` },
      });
      if (!response.ok) throw new Error('Slack membership check failed');
      const payload = (await response.json()) as {
        ok?: boolean;
        members?: string[];
        response_metadata?: { next_cursor?: string };
      };
      if (!payload.ok) throw new Error('Slack membership check failed');
      members.push(...(payload.members || []));
      cursor = payload.response_metadata?.next_cursor || '';
    } while (cursor);
    return members;
  }

  private async validateTeams(
    input: ConversationMembershipValidationInput,
  ): Promise<ConversationMembershipValidationResult> {
    const clientId = this.resolveSecret(
      input.providerConnection.runtimeSecretRefs,
      ['TEAMS_CLIENT_ID'],
    );
    const clientSecret = this.resolveSecret(
      input.providerConnection.runtimeSecretRefs,
      ['TEAMS_CLIENT_SECRET'],
    );
    const tenantId = this.resolveSecret(
      input.providerConnection.runtimeSecretRefs,
      ['TEAMS_TENANT_ID'],
    );
    if (!clientId || !clientSecret || !tenantId) {
      return {
        validUserIds: [],
        invalidUserIds: input.userIds,
        reason: 'Teams Graph credentials are not configured.',
      };
    }
    try {
      const accessToken = await this.fetchTeamsGraphToken({
        clientId,
        clientSecret,
        tenantId,
      });
      const members = await this.listTeamsMembers(input, accessToken);
      const memberSet = new Set(members);
      return {
        validUserIds: input.userIds.filter((id) => memberSet.has(id)),
        invalidUserIds: input.userIds.filter((id) => !memberSet.has(id)),
      };
    } catch {
      return {
        validUserIds: [],
        invalidUserIds: input.userIds,
        reason: TOKEN_BOUND_HTTP_GUIDANCE,
      };
    }
  }

  private async fetchTeamsGraphToken(input: {
    clientId: string;
    clientSecret: string;
    tenantId: string;
  }): Promise<string> {
    const body = new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    });
    const response = await fetchWithTimeout(
      `https://login.microsoftonline.com/${encodeURIComponent(input.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    );
    if (!response.ok) throw new Error('Teams token request failed');
    const payload = (await response.json()) as { access_token?: string };
    if (!payload.access_token) throw new Error('Teams token missing');
    return payload.access_token;
  }

  private async listTeamsMembers(
    input: ConversationMembershipValidationInput,
    accessToken: string,
  ): Promise<string[]> {
    const endpoint = teamsMembersEndpoint(input);
    const members: string[] = [];
    let nextUrl: string | undefined = endpoint;
    while (nextUrl) {
      const response = await fetchWithTimeout(nextUrl, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) throw new Error('Teams membership check failed');
      const payload = (await response.json()) as {
        value?: Array<Record<string, unknown>>;
        '@odata.nextLink'?: string;
      };
      for (const member of payload.value || []) {
        for (const value of [
          member.userId,
          member.id,
          member.email,
          member.userPrincipalName,
        ]) {
          if (typeof value === 'string' && value.trim()) {
            members.push(value.trim());
          }
        }
      }
      nextUrl = payload['@odata.nextLink'];
    }
    return members;
  }

  private resolveSecret(refs: string[], preferred: string[]): string {
    const candidates = [
      ...preferred.filter((ref) => refs.includes(ref)),
      ...refs,
    ].filter((ref, index, all) => all.indexOf(ref) === index);
    for (const ref of candidates) {
      const value = this.secrets.getOptionalSecret({ env: ref });
      if (value) return value;
    }
    return '';
  }
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function externalConversationValue(
  input: ConversationMembershipValidationInput,
): string {
  return input.conversation.externalRef?.value || input.conversation.id;
}

function teamsMembersEndpoint(
  input: ConversationMembershipValidationInput,
): string {
  const config =
    input.providerConnection.config &&
    typeof input.providerConnection.config === 'object'
      ? (input.providerConnection.config as Record<string, unknown>)
      : {};
  const teamId = stringConfigValue(config, 'teamId');
  const channelId = stringConfigValue(config, 'channelId');
  if (teamId && channelId) {
    return `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/members`;
  }
  const chatId =
    stringConfigValue(config, 'chatId') ||
    externalConversationValue(input).replace(/^teams:/, '');
  return `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/members`;
}

function stringConfigValue(
  config: Record<string, unknown>,
  key: string,
): string {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : '';
}
