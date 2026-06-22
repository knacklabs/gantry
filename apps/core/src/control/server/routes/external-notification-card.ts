import { createHmac, randomUUID } from 'node:crypto';

import { envValueDynamic } from '../../../config/env/index.js';
import type { AdaptiveCardPayload } from '../../../domain/types.js';

export type PlatformEventEnvelope = {
  integrationId: string;
  eventId: string;
  eventType: string;
  occurredAt: string;
  target?: Record<string, unknown>;
  payload: Record<string, unknown>;
};

type NotificationCardAction = {
  actionType: string;
  label: string;
  presentation: string;
  url?: string | null;
  platformOperation?: string | null;
  requiresActionCapableTeamsSurface?: boolean;
};

type NotificationCard = {
  schemaVersion: string;
  renderer: string;
  subjectId?: string | null;
  scopeId?: string | null;
  sourceConversationId?: string | null;
  teamsTenantId?: string | null;
  title: string;
  summary?: string | null;
  facts?: unknown;
  links?: unknown;
  actions?: unknown;
  fallbackText?: string | null;
};

export type ExternalPlatformDelivery =
  | {
      kind: 'adaptive_card';
      card: AdaptiveCardPayload;
      fallbackText: string;
      threadId?: string | null;
    }
  | {
      kind: 'text';
      message: string;
      threadId?: string | null;
    };

export function buildExternalNotificationAdaptiveCard(
  envelope: PlatformEventEnvelope,
): AdaptiveCardPayload | null {
  if (envelope.eventType !== 'notification.card.requested') return null;
  const card = readNotificationCard(envelope.payload.notificationCard);
  if (!card) return null;
  const facts = readNotificationFacts(card.facts);
  const summary = sanitizeSummary(card.summary ?? null);
  const body: Array<Record<string, unknown>> = [
    {
      type: 'TextBlock',
      size: 'Medium',
      weight: 'Bolder',
      text: card.title,
      wrap: true,
    },
    ...(summary
      ? [
          {
            type: 'TextBlock',
            text: summary,
            wrap: true,
          },
        ]
      : []),
    ...(facts.length
      ? [
          {
            type: 'FactSet',
            facts,
          },
        ]
      : []),
    ...buildLinkBlocks(card.links),
  ];

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.2',
    body,
    actions: [
      ...readActions(card.actions).filter(
        (action) => action.presentation === 'submit',
      ),
    ]
      .map((action) => buildTeamsAction(envelope, card, action))
      .filter((action): action is Record<string, unknown> => Boolean(action)),
  };
}

export function fallbackTextForNotificationCard(
  envelope: PlatformEventEnvelope,
): string | null {
  const card = readNotificationCard(envelope.payload.notificationCard);
  return readOptionalString(card?.fallbackText);
}

function buildTeamsAction(
  envelope: PlatformEventEnvelope,
  card: NotificationCard,
  action: NotificationCardAction,
): Record<string, unknown> | null {
  if (action.presentation !== 'submit') return null;
  const operation = readOptionalString(action.platformOperation);
  if (!operation) return null;
  const teamsTenantId = expectedTeamsTenantId(envelope, card);
  if (!teamsTenantId) return null;
  const subjectId =
    readOptionalString(card.subjectId) ??
    readOptionalString(envelope.payload.subjectId);
  const scopeId =
    readOptionalString(card.scopeId) ?? readOptionalString(envelope.payload.scopeId);
  const sourceConversationId =
    readOptionalString(card.sourceConversationId) ??
    readOptionalString(envelope.target?.teamsChannelId) ??
    readOptionalString(envelope.target?.conversationId);
  if (!subjectId || !scopeId || !sourceConversationId) return null;
  return {
    type: 'Action.Submit',
    title: action.label,
    data: {
      action: 'external_card_action',
      actionType: action.actionType,
      platformOperation: operation,
      integrationId: envelope.integrationId,
      eventId: envelope.eventId,
      subjectId,
      scopeId,
      sourceScopeId: scopeId,
      sourceConversationId,
      teamsTenantId,
      ...signExternalCardAction({
        integrationId: envelope.integrationId,
        eventId: envelope.eventId,
        subjectId,
        scopeId,
        sourceScopeId: scopeId,
        sourceConversationId,
        teamsTenantId,
        actionType: action.actionType,
        platformOperation: operation,
        signatureVersion: 'v2',
      }),
    },
  };
}

function readNotificationFacts(value: unknown): { title: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const title =
      readOptionalString(record.label) ?? readOptionalString(record.title);
    const factValue = readOptionalString(record.value);
    return title && factValue ? [{ title, value: factValue }] : [];
  });
}

function buildLinkBlocks(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const links = value
    .flatMap((entry, index): string[] => {
      if (!entry || typeof entry !== 'object') return [];
      const link = entry as Record<string, unknown>;
      const url = normalizeHttpUrl(link.url);
      if (!url) return [];
      return [
        `[${escapeMarkdownLinkLabel(
          readOptionalString(link.label) ||
            readOptionalString(link.title) ||
            `Link ${index + 1}`,
        )}](${escapeMarkdownLinkUrl(url)})`,
      ];
    })
    .slice(0, 5);

  if (links.length === 0) return [];
  return [
    {
      type: 'TextBlock',
      text: 'Links',
      weight: 'Bolder',
      wrap: true,
      spacing: 'Medium',
    },
    {
      type: 'TextBlock',
      text: links.join('\n'),
      wrap: true,
      spacing: 'Small',
    },
  ];
}

function normalizeHttpUrl(value: unknown): string | null {
  const raw = readOptionalString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function escapeMarkdownLinkLabel(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\[\]()])/g, '\\$1');
}

function escapeMarkdownLinkUrl(value: string): string {
  return value.replace(/[()]/g, (character) =>
    character === '(' ? '%28' : '%29',
  );
}

function signExternalCardAction(input: {
  integrationId: string;
  eventId: string;
  subjectId: string | null;
  scopeId: string | null;
  sourceScopeId?: string | null;
  sourceConversationId: string | null;
  teamsTenantId: string | null;
  actionType: string;
  platformOperation?: string | null;
  requestId?: string | null;
  signatureVersion?: 'v2' | null;
}): {
  nonce: string;
  expiresAt: string;
  signature: string;
  signatureVersion?: 'v2';
} {
  const secret =
    envValueDynamic('GANTRY_EXTERNAL_ACTION_SECRET') ||
    envValueDynamic('GANTRY_EXTERNAL_EVENT_SECRET');
  if (!secret) {
    throw new Error('GANTRY_EXTERNAL_ACTION_SECRET is not configured');
  }
  const nonce = randomUUID();
  const expiresAt = normalizeExternalCardActionExpiresAtForSignature(
    new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  );
  const payload = stableActionPayload({
    ...input,
    nonce,
    expiresAt,
  });
  return {
    nonce,
    expiresAt,
    ...(input.signatureVersion === 'v2'
      ? { signatureVersion: 'v2' as const }
      : {}),
    signature: createHmac('sha256', secret).update(payload).digest('hex'),
  };
}

export function signExternalCardActionForVerification(input: {
  integrationId: string;
  eventId: string;
  subjectId: string | null;
  scopeId: string | null;
  sourceScopeId?: string | null;
  sourceConversationId: string | null;
  teamsTenantId: string | null;
  actionType: string;
  platformOperation?: string | null;
  requestId?: string | null;
  signatureVersion?: 'v2' | null;
  nonce: string;
  expiresAt: string;
  secret: string;
}): string {
  const expiresAt = normalizeExternalCardActionExpiresAtForSignature(
    input.expiresAt,
  );
  return createHmac('sha256', input.secret)
    .update(
      stableActionPayload({
        integrationId: input.integrationId,
        eventId: input.eventId,
        subjectId: input.subjectId,
        scopeId: input.scopeId,
        sourceScopeId: input.sourceScopeId ?? input.scopeId,
        sourceConversationId: input.sourceConversationId,
        teamsTenantId: input.teamsTenantId,
        actionType: input.actionType,
        ...(input.signatureVersion === 'v2'
          ? {
              signatureVersion: 'v2',
              platformOperation: input.platformOperation ?? null,
              requestId: input.requestId ?? null,
            }
          : {}),
        nonce: input.nonce,
        expiresAt,
      }),
    )
    .digest('hex');
}

function stableActionPayload(input: Record<string, string | null>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(input).sort()));
}

function normalizeExternalCardActionExpiresAtForSignature(
  expiresAt: string,
): string {
  const parsed = Date.parse(expiresAt.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error('External card action expiration timestamp is invalid');
  }
  return new Date(parsed).toISOString();
}

function expectedTeamsTenantId(
  envelope: PlatformEventEnvelope,
  card: NotificationCard,
): string | null {
  const target =
    envelope.target && typeof envelope.target === 'object'
      ? envelope.target
      : {};
  return (
    readOptionalString(card.teamsTenantId) ||
    readOptionalString(target.teamsTenantId) ||
    readOptionalString(envValueDynamic('GANTRY_EXTERNAL_TEAMS_TENANT_ID')) ||
    readOptionalString(envValueDynamic('TEAMS_TENANT_ID'))
  );
}

function readNotificationCard(value: unknown): NotificationCard | null {
  if (!value || typeof value !== 'object') return null;
  const card = value as Partial<NotificationCard>;
  if (
    card.schemaVersion !== 'external.notification.card.v1' ||
    card.renderer !== 'gantry_adaptive_card' ||
    !readOptionalString(card.title)
  ) {
    return null;
  }
  return {
    schemaVersion: card.schemaVersion,
    renderer: card.renderer,
    title: readOptionalString(card.title) ?? 'New notification',
    subjectId: readOptionalString(card.subjectId),
    scopeId: readOptionalString(card.scopeId),
    sourceConversationId: readOptionalString(card.sourceConversationId),
    teamsTenantId: readOptionalString(card.teamsTenantId),
    summary: sanitizeSummary(readOptionalString(card.summary)),
    facts: Array.isArray(card.facts) ? card.facts : [],
    links: Array.isArray(card.links) ? card.links : [],
    actions: card.actions,
    fallbackText: readOptionalString(card.fallbackText),
  };
}

function readActions(value: unknown): NotificationCardAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const action = entry as Partial<NotificationCardAction>;
    const actionType = readOptionalString(action.actionType);
    const label = readOptionalString(action.label);
    const presentation = readOptionalString(action.presentation);
    if (!actionType || !label || !presentation) return [];
    return [
      {
        actionType,
        label,
        presentation,
        url: readOptionalString(action.url),
        platformOperation: readOptionalString(action.platformOperation),
        requiresActionCapableTeamsSurface:
          action.requiresActionCapableTeamsSurface === true,
      },
    ];
  });
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const summaryNoisePatterns = [
  /^screen reader access$/i,
  /^search\s*\|/i,
  /^text$/i,
  /^basic details$/i,
  /^downloads$/i,
  /^announcements$/i,
];

function sanitizeSummary(value: string | null): string | null {
  const lines =
    value
      ?.split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(
        (line) =>
          line && !summaryNoisePatterns.some((pattern) => pattern.test(line)),
      ) ?? [];
  const summary = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (!summary || summary.length < 12) return null;
  return summary.length > 420
    ? `${summary.slice(0, 417).trimEnd()}...`
    : summary;
}
