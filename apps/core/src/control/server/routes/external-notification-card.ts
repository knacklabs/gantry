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
  title: string;
  referenceNo?: string | null;
  organization?: string | null;
  deadline?: string | null;
  summary?: string | null;
  sourceUrl?: string | null;
  workspace?: {
    workspaceId?: string;
    workspaceName?: string;
    teamsChannelId?: string;
    teamsTenantId?: string;
    matchedKeywords?: unknown;
  };
  primaryDocument?: {
    signedDownloadUrl?: string | null;
  };
  actions?: unknown;
  fallbackText?: string | null;
};

export type ExternalPlatformDelivery =
  | {
      kind: 'adaptive_card';
      card: AdaptiveCardPayload;
      fallbackText: string;
    }
  | {
      kind: 'text';
      message: string;
    };

export function buildExternalNotificationAdaptiveCard(
  envelope: PlatformEventEnvelope,
): AdaptiveCardPayload | null {
  if (envelope.eventType !== 'notification.card.requested') return null;
  const card = readNotificationCard(envelope.payload.notificationCard);
  if (!card) return null;
  const facts = [
    fact('Organization', card.organization),
    fact('Reference', card.referenceNo),
    fact('Deadline', card.deadline),
    fact('Workspace', card.workspace?.workspaceName),
    fact('Matched keywords', readKeywords(card.workspace?.matchedKeywords)),
  ].filter((entry): entry is { title: string; value: string } =>
    Boolean(entry),
  );
  const body: Array<Record<string, unknown>> = [
    {
      type: 'TextBlock',
      size: 'Medium',
      weight: 'Bolder',
      text: card.title,
      wrap: true,
    },
    ...(card.summary
      ? [
          {
            type: 'TextBlock',
            text: card.summary,
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
  ];

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.2',
    body,
    actions: readActions(card.actions)
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
  if (action.presentation === 'open_url') {
    const url = readOptionalString(action.url);
    return url
      ? {
          type: 'Action.OpenUrl',
          title: action.label,
          url,
        }
      : null;
  }
  if (action.presentation !== 'submit') return null;
  const operation = readOptionalString(action.platformOperation);
  if (!operation) return null;
  const teamsTenantId = expectedTeamsTenantId(envelope, card);
  if (!teamsTenantId) return null;
  return {
    type: 'Action.Submit',
    title: action.label,
    data: {
      action: 'external_card_action',
      actionType: action.actionType,
      platformOperation: operation,
      integrationId: envelope.integrationId,
      eventId: envelope.eventId,
      resourceId: readOptionalString(envelope.payload.resourceId),
      workspaceId: readOptionalString(card.workspace?.workspaceId),
      sourceWorkspaceId: readOptionalString(card.workspace?.workspaceId),
      sourceChannelId: readOptionalString(card.workspace?.teamsChannelId),
      teamsTenantId,
      ...signExternalCardAction({
        integrationId: envelope.integrationId,
        eventId: envelope.eventId,
        resourceId: readOptionalString(envelope.payload.resourceId),
        workspaceId: readOptionalString(card.workspace?.workspaceId),
        sourceChannelId: readOptionalString(card.workspace?.teamsChannelId),
        teamsTenantId,
        actionType: action.actionType,
      }),
    },
  };
}

function signExternalCardAction(input: {
  integrationId: string;
  eventId: string;
  resourceId: string | null;
  workspaceId: string | null;
  sourceChannelId: string | null;
  teamsTenantId: string | null;
  actionType: string;
}): { nonce: string; expiresAt: string; signature: string } {
  const secret =
    envValueDynamic('GANTRY_EXTERNAL_ACTION_SECRET') ||
    envValueDynamic('GANTRY_EXTERNAL_EVENT_SECRET');
  if (!secret) {
    throw new Error('GANTRY_EXTERNAL_ACTION_SECRET is not configured');
  }
  const nonce = randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const payload = stableActionPayload({
    ...input,
    nonce,
    expiresAt,
  });
  return {
    nonce,
    expiresAt,
    signature: createHmac('sha256', secret).update(payload).digest('hex'),
  };
}

export function signExternalCardActionForVerification(input: {
  integrationId: string;
  eventId: string;
  resourceId: string | null;
  workspaceId: string | null;
  sourceChannelId: string | null;
  teamsTenantId: string | null;
  actionType: string;
  nonce: string;
  expiresAt: string;
  secret: string;
}): string {
  return createHmac('sha256', input.secret)
    .update(
      stableActionPayload({
        integrationId: input.integrationId,
        eventId: input.eventId,
        resourceId: input.resourceId,
        workspaceId: input.workspaceId,
        sourceChannelId: input.sourceChannelId,
        teamsTenantId: input.teamsTenantId,
        actionType: input.actionType,
        nonce: input.nonce,
        expiresAt: input.expiresAt,
      }),
    )
    .digest('hex');
}

function stableActionPayload(input: Record<string, string | null>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(input).sort()));
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
    readOptionalString(card.workspace?.teamsTenantId) ||
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
    referenceNo: readOptionalString(card.referenceNo),
    organization: readOptionalString(card.organization),
    deadline: readOptionalString(card.deadline),
    summary: readOptionalString(card.summary),
    sourceUrl: readOptionalString(card.sourceUrl),
    workspace:
      card.workspace && typeof card.workspace === 'object'
        ? card.workspace
        : undefined,
    primaryDocument:
      card.primaryDocument && typeof card.primaryDocument === 'object'
        ? card.primaryDocument
        : undefined,
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

function fact(
  title: string,
  value: string | null | undefined,
): { title: string; value: string } | null {
  const normalized = readOptionalString(value);
  return normalized ? { title, value: normalized } : null;
}

function readKeywords(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const keywords = value
    .map((entry) => readOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return keywords.length ? keywords.join(', ') : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
