import { and, eq } from 'drizzle-orm';

import {
  getProvider,
  normalizeProviderId,
  providerJidPrefix,
} from '../../../../channels/provider-registry.js';
import type {
  OutboundDelivery,
  OutboundDeliveryResolvedDestination,
} from '../../../../domain/outbound-delivery/outbound-delivery.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

const CANONICAL_CONVERSATION_PREFIX = 'conversation:';
const CONTROL_CONVERSATION_PREFIX = 'control:';
const CONTROL_CONVERSATION_MARKER = ':conversation:';

export async function resolveOutboundDeliveryDestination(
  db: CanonicalDb,
  input: {
    appId: OutboundDelivery['appId'];
    conversationId: OutboundDelivery['conversationId'];
    threadId?: OutboundDelivery['threadId'];
  },
): Promise<OutboundDeliveryResolvedDestination | null> {
  if (input.threadId) {
    const rows = await db
      .select({
        conversationId: pgSchema.conversationsPostgres.id,
        providerAccountId: pgSchema.conversationsPostgres.providerAccountId,
        conversationExternalRefJson:
          pgSchema.conversationsPostgres.externalRefJson,
        providerId: pgSchema.providerAccountsPostgres.providerId,
        threadId: pgSchema.conversationThreadsPostgres.id,
        threadExternalRefJson:
          pgSchema.conversationThreadsPostgres.externalRefJson,
      })
      .from(pgSchema.conversationsPostgres)
      .innerJoin(
        pgSchema.providerAccountsPostgres,
        and(
          eq(
            pgSchema.providerAccountsPostgres.id,
            pgSchema.conversationsPostgres.providerAccountId,
          ),
          eq(
            pgSchema.providerAccountsPostgres.appId,
            pgSchema.conversationsPostgres.appId,
          ),
        ),
      )
      .innerJoin(
        pgSchema.conversationThreadsPostgres,
        and(
          eq(pgSchema.conversationThreadsPostgres.id, input.threadId),
          eq(pgSchema.conversationThreadsPostgres.appId, input.appId),
          eq(
            pgSchema.conversationThreadsPostgres.conversationId,
            pgSchema.conversationsPostgres.id,
          ),
        ),
      )
      .where(
        and(
          eq(pgSchema.conversationsPostgres.id, input.conversationId),
          eq(pgSchema.conversationsPostgres.appId, input.appId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row?.threadId) return null;
    const conversationJid = resolveConversationDestinationJid(
      row.conversationId,
      row.providerAccountId,
      row.conversationExternalRefJson,
      row.providerId,
    );
    const threadDestinationId = resolveThreadDestinationId(
      row.threadExternalRefJson,
    );
    if (!conversationJid || !threadDestinationId) return null;
    return {
      conversationJid,
      threadId: threadDestinationId,
      providerId: row.providerId as never,
      providerAccountId: row.providerAccountId as never,
    };
  }

  const rows = await db
    .select({
      conversationId: pgSchema.conversationsPostgres.id,
      providerAccountId: pgSchema.conversationsPostgres.providerAccountId,
      conversationExternalRefJson:
        pgSchema.conversationsPostgres.externalRefJson,
      providerId: pgSchema.providerAccountsPostgres.providerId,
    })
    .from(pgSchema.conversationsPostgres)
    .innerJoin(
      pgSchema.providerAccountsPostgres,
      and(
        eq(
          pgSchema.providerAccountsPostgres.id,
          pgSchema.conversationsPostgres.providerAccountId,
        ),
        eq(
          pgSchema.providerAccountsPostgres.appId,
          pgSchema.conversationsPostgres.appId,
        ),
      ),
    )
    .where(
      and(
        eq(pgSchema.conversationsPostgres.id, input.conversationId),
        eq(pgSchema.conversationsPostgres.appId, input.appId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const conversationJid = resolveConversationDestinationJid(
    row.conversationId,
    row.providerAccountId,
    row.conversationExternalRefJson,
    row.providerId,
  );
  if (!conversationJid) return null;
  return {
    conversationJid,
    providerId: row.providerId as never,
    providerAccountId: row.providerAccountId as never,
  };
}

function resolveConversationDestinationJid(
  conversationId: string,
  providerAccountId: string,
  externalRefJson: string | null,
  providerId: string,
): string | null {
  const parsed = parseJsonRecord(externalRefJson);
  const directProviderDestination = pickSingleString(
    collectRefCandidates(parsed, [
      'jid',
      'conversationJid',
      'chatJid',
      'externalConversationRef',
      'value',
    ]),
  );
  if (directProviderDestination) {
    const directResolved = normalizeResolvedJid({
      value: directProviderDestination,
      providerId,
    });
    if (directResolved.explicitPrefixMismatch) return null;
    if (directResolved.value) return directResolved.value;
  }
  const resolved = normalizeResolvedJid({
    value: pickSingleString(
      collectRefCandidates(parsed, ['value', 'externalConversationId']),
    ),
    providerId,
  });
  if (resolved.explicitPrefixMismatch) return null;
  if (resolved.value) return resolved.value;
  const canonicalHint = extractCanonicalConversationHint(
    conversationId,
    providerAccountId,
  );
  const controlHint = extractControlConversationHint(conversationId);
  return normalizeResolvedJid({
    value: canonicalHint ?? controlHint,
    providerId,
  }).value;
}

function resolveThreadDestinationId(
  externalRefJson: string | null,
): string | null {
  const parsed = parseJsonRecord(externalRefJson);
  return pickSingleString(
    collectRefCandidates(parsed, ['value', 'threadId', 'externalThreadId']),
  );
}

function parseJsonRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function collectRefCandidates(
  record: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    values.push(trimmed);
  }
  return values;
}

function pickSingleString(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  const unique = [...new Set(values)];
  if (unique.length !== 1) return null;
  return unique[0] ?? null;
}

function extractCanonicalConversationHint(
  conversationId: string,
  providerAccountId: string,
): string | null {
  if (!conversationId.startsWith(CANONICAL_CONVERSATION_PREFIX)) return null;
  const encoded = conversationId.slice(CANONICAL_CONVERSATION_PREFIX.length);
  const trimmed = encoded.trim();
  if (!trimmed) return null;
  const providerAccountPrefix = `${providerAccountId}:`;
  if (trimmed.startsWith(providerAccountPrefix)) {
    const rawExternalId = trimmed.slice(providerAccountPrefix.length).trim();
    return rawExternalId || null;
  }
  return trimmed;
}

function extractControlConversationHint(conversationId: string): string | null {
  if (!conversationId.startsWith(CONTROL_CONVERSATION_PREFIX)) return null;
  const afterPrefix = conversationId.slice(CONTROL_CONVERSATION_PREFIX.length);
  const markerIndex = afterPrefix.indexOf(CONTROL_CONVERSATION_MARKER);
  if (markerIndex <= 0) return null;
  const appId = afterPrefix.slice(0, markerIndex).trim();
  const externalConversationId = afterPrefix
    .slice(markerIndex + CONTROL_CONVERSATION_MARKER.length)
    .trim();
  if (!appId || !externalConversationId) return null;
  return `app:${appId}:${externalConversationId}`;
}

function normalizeResolvedJid(input: {
  value: string | null;
  providerId: string;
}): { value: string | null; explicitPrefixMismatch: boolean } {
  const rawValue = input.value?.trim();
  if (!rawValue) return { value: null, explicitPrefixMismatch: false };
  const normalizedProviderId = normalizeKnownProviderId(input.providerId);
  if (!normalizedProviderId) {
    const explicitProviderId = explicitProviderIdForValue(rawValue);
    return explicitProviderId
      ? { value: rawValue, explicitPrefixMismatch: false }
      : { value: null, explicitPrefixMismatch: false };
  }
  const explicitProviderId = explicitProviderIdForValue(rawValue);
  if (explicitProviderId) {
    return explicitProviderId === normalizedProviderId
      ? { value: rawValue, explicitPrefixMismatch: false }
      : { value: null, explicitPrefixMismatch: true };
  }
  const providerPrefix = jidPrefixForProviderId(normalizedProviderId);
  if (!providerPrefix) {
    return { value: null, explicitPrefixMismatch: false };
  }
  return {
    value: `${providerPrefix}${rawValue}`,
    explicitPrefixMismatch: false,
  };
}

function explicitProviderIdForValue(value: string): string | null {
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const normalizedProviderId = normalizeKnownProviderId(
    value.slice(0, separator),
  );
  return normalizedProviderId || null;
}

function jidPrefixForProviderId(providerId: string): string | null {
  const normalized = normalizeKnownProviderId(providerId);
  if (!normalized) return null;
  const prefix =
    getProvider(normalized)?.jidPrefix ?? providerJidPrefix(normalized);
  return prefix || null;
}

function normalizeKnownProviderId(providerId: string): string {
  const normalized = normalizeProviderId(providerId);
  if (normalized) return normalized;
  return '';
}
