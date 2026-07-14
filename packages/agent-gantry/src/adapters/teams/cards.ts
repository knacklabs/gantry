import type { GantryExternalNotificationAdaptiveCardInput } from './types.js';
import { signExternalCardAction } from './signing.js';
import { readOptionalString } from '../../shared/helpers.js';

export function buildExternalNotificationAdaptiveCard(
  input: GantryExternalNotificationAdaptiveCardInput,
): Record<string, unknown> | null {
  const card = readNotificationCard(input.payload.notificationCard);
  if (!card) return null;
  const subjectId =
    readOptionalString(card.subjectId) ??
    readOptionalString(input.payload.subjectId);
  const facts = readNotificationFacts(card.facts);
  const summary = sanitizeNotificationSummary(card.summary ?? null);
  const body: Record<string, unknown>[] = [
    {
      type: 'TextBlock',
      size: 'Medium',
      weight: 'Bolder',
      text: card.title,
      wrap: true,
    },
    ...(summary ? [{ type: 'TextBlock', text: summary, wrap: true }] : []),
    ...(facts.length ? [{ type: 'FactSet', facts }] : []),
    ...buildLinkBlocks(card.links),
  ];

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.2',
    body,
    actions: readNotificationActions(card.actions)
      .filter((action) => action.presentation === 'submit')
      .map((action) => buildTeamsSubmitAction(input, card, action, subjectId))
      .filter((action): action is Record<string, unknown> => Boolean(action)),
  };
}

type NotificationCardAction = {
  readonly actionType: string;
  readonly label: string;
  readonly presentation: string;
  readonly url?: string | null;
  readonly platformOperation?: string | null;
};

type NotificationCard = {
  readonly title: string;
  readonly subjectId?: string | null;
  readonly scopeId?: string | null;
  readonly sourceConversationId?: string | null;
  readonly teamsTenantId?: string | null;
  readonly summary?: string | null;
  readonly facts?: unknown;
  readonly links?: unknown;
  readonly actions?: unknown;
};

function readNotificationCard(value: unknown): NotificationCard | null {
  if (!value || typeof value !== 'object') return null;
  const card = value as Record<string, unknown>;
  if (
    card.schemaVersion !== 'external.notification.card.v1' ||
    card.renderer !== 'gantry_adaptive_card' ||
    !readOptionalString(card.title)
  ) {
    return null;
  }
  return {
    title: readOptionalString(card.title) ?? 'New notification',
    subjectId: readOptionalString(card.subjectId),
    scopeId: readOptionalString(card.scopeId),
    sourceConversationId: readOptionalString(card.sourceConversationId),
    teamsTenantId: readOptionalString(card.teamsTenantId),
    summary: readOptionalString(card.summary),
    facts: Array.isArray(card.facts) ? card.facts : [],
    links: Array.isArray(card.links) ? card.links : [],
    actions: card.actions,
  };
}

function readNotificationActions(value: unknown): NotificationCardAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const action = entry as Record<string, unknown>;
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
      },
    ];
  });
}

function buildTeamsSubmitAction(
  input: GantryExternalNotificationAdaptiveCardInput,
  card: NotificationCard,
  action: NotificationCardAction,
  subjectId: string | null,
): Record<string, unknown> | null {
  const platformOperation = readOptionalString(action.platformOperation);
  const scopeId = readOptionalString(card.scopeId);
  const sourceConversationId =
    readOptionalString(card.sourceConversationId) ??
    readOptionalString(input.target?.teamsChannelId) ??
    readOptionalString(input.target?.conversationId);
  const teamsTenantId =
    readOptionalString(card.teamsTenantId) ??
    readOptionalString(input.target?.teamsTenantId);
  if (
    !platformOperation ||
    !subjectId ||
    !scopeId ||
    !sourceConversationId ||
    !teamsTenantId
  ) {
    return null;
  }
  return {
    type: 'Action.Submit',
    title: action.label,
    data: {
      action: 'external_card_action',
      actionType: action.actionType,
      platformOperation,
      integrationId: input.integrationId,
      eventId: input.eventId,
      subjectId,
      scopeId,
      sourceScopeId: scopeId,
      sourceConversationId,
      teamsTenantId,
      ...signExternalCardAction({
        secret: input.actionSecret,
        integrationId: input.integrationId,
        eventId: input.eventId,
        subjectId,
        scopeId,
        sourceScopeId: scopeId,
        sourceConversationId,
        teamsTenantId,
        actionType: action.actionType,
        nowMs: input.nowMs,
      }),
    },
  };
}

function readNotificationFacts(
  value: unknown,
): { title: string; value: string }[] {
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
      const label =
        readOptionalString(link.label) ??
        readOptionalString(link.title) ??
        `Link ${index + 1}`;
      return [
        `[${escapeMarkdownLinkLabel(label)}](${escapeMarkdownLinkUrl(url)})`,
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
    { type: 'TextBlock', text: links.join('\n'), wrap: true, spacing: 'Small' },
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

function sanitizeNotificationSummary(value: string | null): string | null {
  const lines =
    value
      ?.split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(
        (line) =>
          line &&
          !notificationSummaryNoisePatterns.some((pattern) =>
            pattern.test(line),
          ),
      ) ?? [];
  const summary = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (!summary || summary.length < 12) return null;
  return summary.length > 420
    ? `${summary.slice(0, 417).trimEnd()}...`
    : summary;
}

const notificationSummaryNoisePatterns = [
  /^screen reader access$/i,
  /^search\s*\|/i,
  /^text$/i,
  /^basic details$/i,
  /^downloads$/i,
  /^announcements$/i,
];
