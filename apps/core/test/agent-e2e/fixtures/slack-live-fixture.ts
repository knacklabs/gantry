import { randomUUID } from 'node:crypto';

export interface SlackLiveCredentials {
  userToken: string;
  botToken: string;
  appToken: string;
}

interface SlackApiEnvelope {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

export function requireSlackLiveCredentials():
  | { credentials: SlackLiveCredentials }
  | { skipReason: string } {
  const userToken = process.env.E2E_SLACK_USER_TOKEN?.trim();
  const botToken = process.env.E2E_SLACK_BOT_TOKEN?.trim();
  const appToken = process.env.E2E_SLACK_APP_TOKEN?.trim();
  const missing = [
    !userToken && 'E2E_SLACK_USER_TOKEN',
    !botToken && 'E2E_SLACK_BOT_TOKEN',
    !appToken && 'E2E_SLACK_APP_TOKEN',
  ].filter(Boolean);
  return missing.length
    ? { skipReason: `${missing.join(', ')} not set` }
    : { credentials: { userToken, botToken, appToken } };
}

async function slackApi<T extends SlackApiEnvelope>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json()) as T;
    if (response.ok && payload.ok === true) return payload;
    if (payload.error === 'ratelimited' && attempt < 2) {
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfterSeconds)
        ? Math.max(1, retryAfterSeconds) * 1_000
        : 30_000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    throw new Error(
      `Slack ${method} failed: ${payload.error ?? response.status}`,
    );
  }
  throw new Error(`Slack ${method} rate-limit retry was exhausted`);
}

export async function slackBotUserId(token: string): Promise<string> {
  const result = await slackApi<{ user_id?: string }>(token, 'auth.test');
  if (!result.user_id)
    throw new Error('Slack auth.test did not return user_id');
  return result.user_id;
}

export async function slackChannelIdByName(
  token: string,
  name: string,
): Promise<string> {
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({
      types: 'public_channel,private_channel',
      limit: '200',
    });
    if (cursor) params.set('cursor', cursor);
    const result = await slackApi<{
      channels?: Array<{ id?: string; name?: string }>;
      response_metadata?: { next_cursor?: string };
    }>(token, `conversations.list?${params.toString()}`);
    const channel = result.channels?.find((entry) => entry.name === name);
    if (channel?.id) return channel.id;
    cursor = result.response_metadata?.next_cursor?.trim() || undefined;
  } while (cursor);
  throw new Error(
    `Slack channel #${name} was not found or is not visible to the test user`,
  );
}

export async function sendSlackTestMessage(input: {
  token: string;
  channelId: string;
  mentionUserId?: string;
}): Promise<{ ts: string; text: string }> {
  const mention = input.mentionUserId ? `<@${input.mentionUserId}> ` : '';
  const text = `${mention}[gantry-e2e:${randomUUID()}] Reply with one short sentence confirming you received this message.`;
  const result = await slackApi<{ ts?: string }>(
    input.token,
    'chat.postMessage',
    {
      channel: input.channelId,
      text,
    },
  );
  if (!result.ts) throw new Error('Slack chat.postMessage did not return ts');
  return { ts: result.ts, text };
}

export async function waitForSlackThreadReply(input: {
  token: string;
  channelId: string;
  rootTs: string;
  botUserId: string;
  timeoutMs: number;
}): Promise<{ ts: string; text: string }> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const params = new URLSearchParams({
      channel: input.channelId,
      ts: input.rootTs,
      limit: '100',
    });
    const result = await slackApi<{
      messages?: Array<{ ts?: string; text?: string; user?: string }>;
    }>(input.token, `conversations.replies?${params.toString()}`);
    const reply = result.messages?.find(
      (message) =>
        message.ts !== input.rootTs &&
        message.user === input.botUserId &&
        Boolean(message.text?.trim()),
    );
    if (reply?.ts && reply.text) return { ts: reply.ts, text: reply.text };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `No Gantry reply in Slack thread ${input.rootTs} within ${input.timeoutMs}ms`,
  );
}

export async function deleteSlackMessage(input: {
  token: string;
  channelId: string;
  ts: string;
}): Promise<void> {
  await slackApi(input.token, 'chat.delete', {
    channel: input.channelId,
    ts: input.ts,
  });
}
