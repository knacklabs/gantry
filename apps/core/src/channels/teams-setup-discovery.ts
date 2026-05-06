import { normalizeTeamsJid } from './teams.js';

export interface TeamsSetupCredentials {
  clientId: string;
  clientSecret: string;
  tenantId: string;
}

export interface TeamsCredentialValidation {
  ok: boolean;
  message: string;
  nextAction?: string;
}

export interface TeamsDiscoveredChannel {
  chatJid: string;
  chatTitle: string;
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
  channelType: string;
  isArchived?: boolean;
}

export interface TeamsChannelDiscoveryResult {
  ok: boolean;
  channels: TeamsDiscoveredChannel[];
  message: string;
  nextAction?: string;
}

export interface TeamsChannelAccessValidation {
  ok: boolean;
  chatJid?: string;
  chatTitle?: string;
  teamId?: string;
  teamName?: string;
  channelId?: string;
  channelName?: string;
  channelType?: string;
  message: string;
  nextAction?: string;
}

export interface TeamsSetupDiscoveryClient {
  validateCredentials(
    credentials: TeamsSetupCredentials,
  ): Promise<TeamsCredentialValidation>;
  listChannels(options: {
    credentials: TeamsSetupCredentials;
    limit?: number;
    includeArchived?: boolean;
  }): Promise<TeamsChannelDiscoveryResult>;
  verifyChannel(options: {
    credentials: TeamsSetupCredentials;
    teamId: string;
    channelId: string;
  }): Promise<TeamsChannelAccessValidation>;
}

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const TOKEN_BOUND_NETWORK_GUIDANCE =
  'Check network access, provider app credentials, provider permissions, and provider service status, then retry. Raw credential-bearing transport details are intentionally not printed.';
const TOKEN_BOUND_TEAMS_GUIDANCE =
  'Check Teams app permissions, tenant admin consent, channel access, and network, then retry. Raw credential-bearing transport details are intentionally not printed.';

export function trimTeamsSetupCredentials(
  credentials: TeamsSetupCredentials,
): TeamsSetupCredentials {
  return {
    clientId: credentials.clientId.trim(),
    clientSecret: credentials.clientSecret.trim(),
    tenantId: credentials.tenantId.trim(),
  };
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: Omit<RequestInit, 'signal'>,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...(init || {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function isSafeGraphId(value: string): boolean {
  return /^[A-Za-z0-9:._@-]{1,256}$/.test(value);
}

function normalizeGraphChannel(input: {
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
  channelType?: string;
  isArchived?: boolean;
}): TeamsDiscoveredChannel | null {
  const chatJid = normalizeTeamsJid(input.channelId);
  if (!chatJid) return null;
  return {
    chatJid,
    chatTitle: `${input.teamName} / ${input.channelName}`,
    teamId: input.teamId,
    teamName: input.teamName,
    channelId: input.channelId,
    channelName: input.channelName,
    channelType: input.channelType || 'standard',
    ...(input.isArchived === true ? { isArchived: true } : {}),
  };
}

async function fetchTeamsGraphToken(
  credentials: TeamsSetupCredentials,
  timeoutMs = 10_000,
): Promise<string> {
  const trimmed = trimTeamsSetupCredentials(credentials);
  const body = new URLSearchParams({
    client_id: trimmed.clientId,
    client_secret: trimmed.clientSecret,
    grant_type: 'client_credentials',
    scope: 'https://graph.microsoft.com/.default',
  });
  const response = await fetchWithTimeout(
    `https://login.microsoftonline.com/${encodeURIComponent(trimmed.tenantId)}/oauth2/v2.0/token`,
    timeoutMs,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    },
  );
  if (!response.ok) throw new Error('Teams token request failed');
  const payload = await readJson<{ access_token?: string }>(response);
  if (!payload.access_token) throw new Error('Teams token missing');
  return payload.access_token;
}

async function listGraphPages<T>(options: {
  firstUrl: string;
  accessToken: string;
  timeoutMs?: number;
}): Promise<T[]> {
  const rows: T[] = [];
  let nextUrl: string | undefined = options.firstUrl;
  while (nextUrl) {
    const response = await fetchWithTimeout(
      nextUrl,
      options.timeoutMs ?? 10_000,
      {
        headers: { authorization: `Bearer ${options.accessToken}` },
      },
    );
    if (!response.ok) throw new Error('Teams Graph request failed');
    const payload = await readJson<{
      value?: T[];
      '@odata.nextLink'?: string;
    }>(response);
    rows.push(...(payload.value || []));
    nextUrl = payload['@odata.nextLink'];
  }
  return rows;
}

export class GraphTeamsSetupDiscoveryClient implements TeamsSetupDiscoveryClient {
  async validateCredentials(
    credentials: TeamsSetupCredentials,
  ): Promise<TeamsCredentialValidation> {
    return validateTeamsAppCredentials(credentials);
  }

  async listChannels(options: {
    credentials: TeamsSetupCredentials;
    limit?: number;
    includeArchived?: boolean;
  }): Promise<TeamsChannelDiscoveryResult> {
    return listTeamsChannels(options);
  }

  async verifyChannel(options: {
    credentials: TeamsSetupCredentials;
    teamId: string;
    channelId: string;
  }): Promise<TeamsChannelAccessValidation> {
    return verifyTeamsChannelAccess(options);
  }
}

export async function validateTeamsAppCredentials(
  credentials: TeamsSetupCredentials,
): Promise<TeamsCredentialValidation> {
  const trimmed = trimTeamsSetupCredentials(credentials);
  if (!trimmed.clientId || !trimmed.clientSecret || !trimmed.tenantId) {
    return {
      ok: false,
      message: 'Teams app credentials are incomplete.',
      nextAction:
        'Enter Microsoft Teams client ID, client secret, and tenant ID.',
    };
  }
  try {
    await fetchTeamsGraphToken(trimmed);
    return {
      ok: true,
      message: 'Teams app credentials validated for Microsoft Graph.',
    };
  } catch {
    return {
      ok: false,
      message: 'Could not validate Teams app credentials.',
      nextAction: TOKEN_BOUND_TEAMS_GUIDANCE,
    };
  }
}

export async function listTeamsChannels(options: {
  credentials: TeamsSetupCredentials;
  timeoutMs?: number;
  limit?: number;
  includeArchived?: boolean;
}): Promise<TeamsChannelDiscoveryResult> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  try {
    const accessToken = await fetchTeamsGraphToken(
      options.credentials,
      options.timeoutMs,
    );
    const teams = await listGraphPages<{ id?: string; displayName?: string }>({
      firstUrl: `${GRAPH_ROOT}/teams?$top=${limit}`,
      accessToken,
      timeoutMs: options.timeoutMs,
    });
    const channels: TeamsDiscoveredChannel[] = [];
    for (const team of teams) {
      const teamId = String(team.id || '').trim();
      if (!teamId || !isSafeGraphId(teamId)) continue;
      const teamName = String(team.displayName || teamId).trim();
      const graphChannels = await listGraphPages<{
        id?: string;
        displayName?: string;
        membershipType?: string;
        isArchived?: boolean;
      }>({
        firstUrl: `${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels?$top=${limit}`,
        accessToken,
        timeoutMs: options.timeoutMs,
      });
      for (const channel of graphChannels) {
        const channelId = String(channel.id || '').trim();
        if (!channelId || !isSafeGraphId(channelId)) continue;
        if (options.includeArchived !== true && channel.isArchived === true) {
          continue;
        }
        const normalized = normalizeGraphChannel({
          teamId,
          teamName,
          channelId,
          channelName: String(channel.displayName || channelId).trim(),
          channelType: String(channel.membershipType || 'standard').trim(),
          isArchived: channel.isArchived === true,
        });
        if (normalized) channels.push(normalized);
        if (channels.length >= limit) break;
      }
      if (channels.length >= limit) break;
    }
    if (channels.length === 0) {
      return {
        ok: true,
        channels: [],
        message: 'No discoverable Teams channels found for this app.',
        nextAction:
          'Confirm the Teams app has Graph permissions and admin consent, then use manual team/channel IDs if needed.',
      };
    }
    return {
      ok: true,
      channels,
      message: `Discovered ${channels.length} Teams channel(s).`,
    };
  } catch {
    return {
      ok: false,
      channels: [],
      message: 'Could not discover Teams channels through Microsoft Graph.',
      nextAction: TOKEN_BOUND_NETWORK_GUIDANCE,
    };
  }
}

export async function verifyTeamsChannelAccess(options: {
  credentials: TeamsSetupCredentials;
  teamId: string;
  channelId: string;
  timeoutMs?: number;
}): Promise<TeamsChannelAccessValidation> {
  const teamId = options.teamId.trim();
  const channelId = options.channelId.trim();
  if (
    !teamId ||
    !channelId ||
    !isSafeGraphId(teamId) ||
    !isSafeGraphId(channelId)
  ) {
    return {
      ok: false,
      message: 'Invalid Teams team or channel ID format.',
      nextAction:
        'Use Microsoft Graph team and channel IDs, for example team-id and 19:channel@thread.tacv2.',
    };
  }
  try {
    const accessToken = await fetchTeamsGraphToken(
      options.credentials,
      options.timeoutMs,
    );
    const teamResponse = await fetchWithTimeout(
      `${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}`,
      options.timeoutMs ?? 10_000,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!teamResponse.ok) throw new Error('Teams team verification failed');
    const team = await readJson<{ id?: string; displayName?: string }>(
      teamResponse,
    );
    const channelResponse = await fetchWithTimeout(
      `${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}`,
      options.timeoutMs ?? 10_000,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!channelResponse.ok) {
      throw new Error('Teams channel verification failed');
    }
    const channel = await readJson<{
      id?: string;
      displayName?: string;
      membershipType?: string;
      isArchived?: boolean;
    }>(channelResponse);
    const normalized = normalizeGraphChannel({
      teamId,
      teamName: String(team.displayName || team.id || teamId).trim(),
      channelId,
      channelName: String(
        channel.displayName || channel.id || channelId,
      ).trim(),
      channelType: String(channel.membershipType || 'standard').trim(),
      isArchived: channel.isArchived === true,
    });
    if (!normalized) throw new Error('Teams channel id is invalid');
    return {
      ok: true,
      chatJid: normalized.chatJid,
      chatTitle: normalized.chatTitle,
      teamId: normalized.teamId,
      teamName: normalized.teamName,
      channelId: normalized.channelId,
      channelName: normalized.channelName,
      channelType: normalized.channelType,
      message: `Teams channel access verified for ${normalized.chatTitle}.`,
    };
  } catch {
    return {
      ok: false,
      message: 'Could not verify Teams channel access through Microsoft Graph.',
      nextAction: TOKEN_BOUND_TEAMS_GUIDANCE,
    };
  }
}
