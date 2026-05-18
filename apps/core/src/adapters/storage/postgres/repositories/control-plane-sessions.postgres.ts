import { eq, inArray, sql } from 'drizzle-orm';

import * as pgSchema from '../schema/schema.js';
import {
  mapSession,
  type CanonicalControlRow,
} from '../schema/control-plane-canonical.postgres.js';
import type { AppSessionRecord } from '../schema/control-plane-records.postgres.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

export async function getControlSessionById(
  db: CanonicalDb,
  sessionId: string,
): Promise<AppSessionRecord | undefined> {
  const rows = await db
    .select()
    .from(pgSchema.controlHttpSessionsPostgres)
    .where(eq(pgSchema.controlHttpSessionsPostgres.sessionId, sessionId))
    .limit(1);
  return rows[0] ? mapSession(rows[0] as CanonicalControlRow) : undefined;
}

export async function getControlSessionsByIds(
  db: CanonicalDb,
  sessionIds: readonly string[],
): Promise<AppSessionRecord[]> {
  const uniqueSessionIds = uniqueStrings(sessionIds);
  if (uniqueSessionIds.length === 0) return [];
  const rows = await db
    .select()
    .from(pgSchema.controlHttpSessionsPostgres)
    .where(
      inArray(pgSchema.controlHttpSessionsPostgres.sessionId, uniqueSessionIds),
    );
  return rows.map((row) => mapSession(row as CanonicalControlRow));
}

export async function getControlSessionByChatJid(
  db: CanonicalDb,
  chatJid: string,
): Promise<AppSessionRecord | undefined> {
  const rows = await db
    .select()
    .from(pgSchema.controlHttpSessionsPostgres)
    .where(
      sql`${pgSchema.controlHttpSessionsPostgres.externalRefJson}->>'chatJid' = ${chatJid}`,
    )
    .limit(1);
  return rows[0] ? mapSession(rows[0] as CanonicalControlRow) : undefined;
}

export async function getControlSessionsByChatJids(
  db: CanonicalDb,
  chatJids: readonly string[],
): Promise<AppSessionRecord[]> {
  const uniqueChatJids = uniqueStrings(chatJids);
  if (uniqueChatJids.length === 0) return [];
  const rows = await db
    .select()
    .from(pgSchema.controlHttpSessionsPostgres)
    .where(
      inArray(
        sql`${pgSchema.controlHttpSessionsPostgres.externalRefJson}->>'chatJid'`,
        uniqueChatJids,
      ),
    );
  return rows.map((row) => mapSession(row as CanonicalControlRow));
}
