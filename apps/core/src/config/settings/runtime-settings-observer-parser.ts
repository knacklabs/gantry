import { parseBooleanValue } from './runtime-settings-parse-primitives.js';
import type { RuntimeObserverSettings } from './runtime-settings-types.js';

function parseRequiredString(raw: unknown, path: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return raw.trim();
}

export function parseObserverSettings(raw: unknown): RuntimeObserverSettings {
  if (raw === undefined) return { enabled: false };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('observer must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'enabled' && key !== 'owner') {
      throw new Error(
        `observer.${key} is not supported. Configure enabled or owner.`,
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
  };
}
