import { isValidTimezone } from '../../shared/timezone.js';
import { parseBooleanValue } from './runtime-settings-parse-primitives.js';
import type {
  RuntimeObserverDeliverySettings,
  RuntimeObserverSettings,
} from './runtime-settings-types.js';

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseRequiredString(raw: unknown, path: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return raw.trim();
}

function parseTimeOfDay(raw: unknown, path: string): string {
  if (typeof raw !== 'string' || !TIME_OF_DAY_PATTERN.test(raw.trim())) {
    throw new Error(`${path} must be a 24-hour HH:mm time`);
  }
  return raw.trim();
}

function parseObserverDelivery(
  raw: unknown,
): RuntimeObserverDeliverySettings | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('observer.delivery must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (
      key !== 'enabled' &&
      key !== 'timezone' &&
      key !== 'send_at' &&
      key !== 'quiet_hours' &&
      key !== 'max_insights'
    ) {
      throw new Error(
        `observer.delivery.${key} is not supported. Configure enabled, timezone, send_at, quiet_hours, or max_insights.`,
      );
    }
  }

  const enabled = parseBooleanValue(
    map.enabled,
    'observer.delivery.enabled',
    false,
  );

  let timezone: string | undefined;
  if (map.timezone !== undefined) {
    timezone = parseRequiredString(map.timezone, 'observer.delivery.timezone');
    if (!isValidTimezone(timezone)) {
      throw new Error(
        'observer.delivery.timezone must be a valid IANA time zone',
      );
    }
  }

  const sendAt =
    map.send_at === undefined
      ? undefined
      : parseTimeOfDay(map.send_at, 'observer.delivery.send_at');

  const quietHours = parseQuietHours(map.quiet_hours);
  const maxInsights = parseMaxInsights(map.max_insights);

  if (enabled && !timezone) {
    throw new Error(
      'observer.delivery.timezone is required when observer.delivery.enabled is true',
    );
  }
  if (enabled && !sendAt) {
    throw new Error(
      'observer.delivery.send_at is required when observer.delivery.enabled is true',
    );
  }

  return {
    enabled,
    ...(timezone ? { timezone } : {}),
    ...(sendAt ? { sendAt } : {}),
    ...(quietHours ? { quietHours } : {}),
    maxInsights,
  };
}

function parseQuietHours(
  raw: unknown,
): { start: string; end: string } | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('observer.delivery.quiet_hours must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'start' && key !== 'end') {
      throw new Error(
        `observer.delivery.quiet_hours.${key} is not supported. Configure start or end.`,
      );
    }
  }
  return {
    start: parseTimeOfDay(map.start, 'observer.delivery.quiet_hours.start'),
    end: parseTimeOfDay(map.end, 'observer.delivery.quiet_hours.end'),
  };
}

function parseMaxInsights(raw: unknown): number {
  if (raw === undefined) return 3;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 3) {
    throw new Error(
      'observer.delivery.max_insights must be an integer between 1 and 3',
    );
  }
  return raw;
}

export function parseObserverSettings(raw: unknown): RuntimeObserverSettings {
  if (raw === undefined) return { enabled: false };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('observer must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'enabled' && key !== 'owner' && key !== 'delivery') {
      throw new Error(
        `observer.${key} is not supported. Configure enabled, owner, or delivery.`,
      );
    }
  }

  const ownerRaw = map.owner;
  if (
    ownerRaw !== undefined &&
    (typeof ownerRaw !== 'object' ||
      ownerRaw === null ||
      Array.isArray(ownerRaw))
  ) {
    throw new Error('observer.owner must be a mapping');
  }
  const owner = ownerRaw as Record<string, unknown> | undefined;
  if (owner) {
    for (const key of Object.keys(owner)) {
      if (key !== 'recipient' && key !== 'conversation') {
        throw new Error(
          `observer.owner.${key} is not supported. Configure recipient or conversation.`,
        );
      }
    }
  }

  const delivery = parseObserverDelivery(map.delivery);

  return {
    enabled: parseBooleanValue(map.enabled, 'observer.enabled', false),
    ...(owner
      ? {
          owner: {
            recipient: parseRequiredString(
              owner.recipient,
              'observer.owner.recipient',
            ),
            conversation: parseRequiredString(
              owner.conversation,
              'observer.owner.conversation',
            ),
          },
        }
      : {}),
    ...(delivery ? { delivery } : {}),
  };
}
