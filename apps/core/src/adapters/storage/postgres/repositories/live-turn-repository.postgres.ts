import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';

import type {
  LiveTurn,
  LiveTurnAgentRunCompletion,
  LiveTurnCommand,
  LiveTurnCommandAppendResult,
  LiveTurnCommandStatus,
  LiveTurnCommandType,
  LiveTurnCoordinationRepository,
  LiveTurnLeaseFence,
  LiveTurnScope,
  LiveTurnState,
} from '../../../../domain/ports/live-turns.js';
import {
  LIVE_TURN_TERMINAL_STATES,
  isTerminalLiveTurnState,
  makeLiveTurnScopeKey,
} from '../../../../domain/ports/live-turns.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { activeRunLeaseFence } from './run-lease-fence.postgres.js';
import {
  isUniqueViolation,
  settleRunLeaseTx,
} from './worker-coordination-lease.postgres.js';

type LiveTurnRow = typeof pgSchema.liveTurnsPostgres.$inferSelect;
type LiveTurnCommandRow = typeof pgSchema.liveTurnCommandsPostgres.$inferSelect;

const TERMINAL_STATES = [...LIVE_TURN_TERMINAL_STATES];

function toLiveTurn(row: LiveTurnRow): LiveTurn {
  return {
    id: row.id,
    scopeKey: row.scopeKey,
    appId: row.appId,
    agentSessionId: row.agentSessionId,
    conversationId: row.conversationId,
    threadId: row.threadId,
    runId: row.runId,
    state: row.state as LiveTurnState,
    pendingMessage: (row.pendingMessageJson ?? null) as Record<
      string,
      unknown
    > | null,
    stopAliasJids: Array.isArray(row.stopAliasJidsJson)
      ? (row.stopAliasJidsJson as string[])
      : [],
    requiredContinuationUserId: row.requiredContinuationUserId,
    retryCount: row.retryCount,
    nextCommandSeq: row.nextCommandSeq,
    workerInstanceId: row.workerInstanceId,
    leaseToken: row.leaseToken,
    fencingVersion: row.fencingVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt,
  };
}

function toLiveTurnCommand(row: LiveTurnCommandRow): LiveTurnCommand {
  return {
    id: row.id,
    liveTurnId: row.liveTurnId,
    scopeKey: row.scopeKey,
    commandType: row.commandType as LiveTurnCommandType,
    seq: row.seq,
    idempotencyKey: row.idempotencyKey,
    payload: (row.payloadJson ?? {}) as Record<string, unknown>,
    status: row.status as LiveTurnCommandStatus,
    fencingVersion: row.fencingVersion,
    createdByWorkerId: row.createdByWorkerId,
    appliedByWorkerId: row.appliedByWorkerId,
    rejectedReason: row.rejectedReason,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
  };
}

export class PostgresLiveTurnRepository implements LiveTurnCoordinationRepository {
  constructor(private readonly db: CanonicalDb) {}

  async claimLiveTurn(input: {
    id: string;
    scope: LiveTurnScope;
    workerInstanceId: string;
    runId?: string | null;
    pendingMessage?: Record<string, unknown> | null;
    stopAliasJids?: string[];
    requiredContinuationUserId?: string | null;
    now?: string;
  }): Promise<LiveTurn | null> {
    const now = input.now ?? currentIso();
    const scopeKey = makeLiveTurnScopeKey(input.scope);
    const row: LiveTurnRow = {
      id: input.id,
      scopeKey,
      appId: input.scope.appId,
      agentSessionId: input.scope.agentSessionId ?? null,
      conversationId: input.scope.conversationId,
      threadId: input.scope.threadId ?? null,
      runId: input.runId ?? null,
      state: 'claimed',
      pendingMessageJson: input.pendingMessage ?? null,
      stopAliasJidsJson: input.stopAliasJids ?? [],
      requiredContinuationUserId: input.requiredContinuationUserId ?? null,
      retryCount: 0,
      nextCommandSeq: 1,
      workerInstanceId: input.workerInstanceId,
      leaseToken: null,
      fencingVersion: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    };
    try {
      await this.db.insert(pgSchema.liveTurnsPostgres).values(row);
      return toLiveTurn(row);
    } catch (err) {
      // The partial unique index on (scope_key) where state is non-terminal
      // back-stops concurrent claims: the loser sees a unique violation.
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async getActiveLiveTurn(input: {
    scope: LiveTurnScope;
  }): Promise<LiveTurn | null> {
    const scopeKey = makeLiveTurnScopeKey(input.scope);
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.scopeKey, scopeKey),
          notInArray(turns.state, TERMINAL_STATES),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toLiveTurn(row) : null;
  }

  async getLiveTurnById(id: string): Promise<LiveTurn | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.liveTurnsPostgres)
      .where(eq(pgSchema.liveTurnsPostgres.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toLiveTurn(row) : null;
  }

  async findActiveLiveTurnByStopAlias(input: {
    aliasJid: string;
  }): Promise<LiveTurn | null> {
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .select()
      .from(turns)
      .where(
        and(
          notInArray(turns.state, TERMINAL_STATES),
          sql`${turns.stopAliasJidsJson} @> ${JSON.stringify([
            input.aliasJid,
          ])}::jsonb`,
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toLiveTurn(row) : null;
  }

  async findActiveLiveTurnByRunId(input: {
    runId: string;
  }): Promise<LiveTurn | null> {
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.runId, input.runId),
          notInArray(turns.state, TERMINAL_STATES),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toLiveTurn(row) : null;
  }

  async transitionLiveTurnState(input: {
    id: string;
    toState: LiveTurnState;
    fromStates: LiveTurnState[];
    agentRunCompletion?: LiveTurnAgentRunCompletion | null;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const turns = pgSchema.liveTurnsPostgres;
    if (!input.agentRunCompletion) {
      const rows = await this.db
        .update(turns)
        .set({
          state: input.toState,
          updatedAt: now,
          ...(isTerminalLiveTurnState(input.toState) ? { endedAt: now } : {}),
        })
        .where(
          and(eq(turns.id, input.id), inArray(turns.state, input.fromStates)),
        )
        .returning({ id: turns.id });
      return rows.length > 0;
    }
    const completion = input.agentRunCompletion;
    return this.db.transaction(async (tx) => {
      const turnRows = await tx
        .select({ id: turns.id, runId: turns.runId, state: turns.state })
        .from(turns)
        .where(eq(turns.id, input.id))
        .for('update');
      const turn = turnRows[0];
      if (!turn || !input.fromStates.includes(turn.state as LiveTurnState)) {
        return false;
      }
      const rows = await tx
        .update(turns)
        .set({
          state: input.toState,
          updatedAt: now,
          ...(isTerminalLiveTurnState(input.toState) ? { endedAt: now } : {}),
        })
        .where(eq(turns.id, input.id))
        .returning({ id: turns.id });
      if (rows.length === 0) return false;
      if (turn.runId) {
        const runUpdates: Partial<
          typeof pgSchema.agentRunsPostgres.$inferInsert
        > = {
          status: completion.status,
          endedAt: now,
        };
        if (completion.resultSummary !== undefined) {
          runUpdates.resultSummary = completion.resultSummary;
        }
        if (completion.errorSummary !== undefined) {
          runUpdates.errorSummary = completion.errorSummary;
        }
        await tx
          .update(pgSchema.agentRunsPostgres)
          .set(runUpdates)
          .where(eq(pgSchema.agentRunsPostgres.id, turn.runId));
      }
      return true;
    });
  }

  async attachLiveTurnLease(input: {
    id: string;
    runId: string;
    lease: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .update(turns)
      .set({
        runId: input.runId,
        workerInstanceId: input.lease.workerInstanceId,
        leaseToken: input.lease.leaseToken,
        fencingVersion: input.lease.fencingVersion,
        updatedAt: now,
      })
      .where(
        and(
          eq(turns.id, input.id),
          eq(turns.state, 'claimed'),
          isNull(turns.leaseToken),
        ),
      )
      .returning({ id: turns.id });
    return rows.length > 0;
  }

  async updateLiveTurnRouting(input: {
    id: string;
    fence: LiveTurnLeaseFence;
    stopAliasJids: string[];
    requiredContinuationUserId?: string | null;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .update(turns)
      .set({
        stopAliasJidsJson: input.stopAliasJids,
        requiredContinuationUserId:
          input.requiredContinuationUserId?.trim() || null,
        updatedAt: now,
      })
      .where(
        and(
          eq(turns.id, input.id),
          notInArray(turns.state, TERMINAL_STATES),
          activeRunLeaseFence({
            runId: sql`${turns.runId}`,
            fence: input.fence,
            now,
          }),
        ),
      )
      .returning({ id: turns.id });
    return rows.length > 0;
  }

  async transitionLiveTurnStateFenced(input: {
    id: string;
    toState: LiveTurnState;
    fromStates: LiveTurnState[];
    fence: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .update(turns)
      .set({
        state: input.toState,
        updatedAt: now,
        ...(isTerminalLiveTurnState(input.toState) ? { endedAt: now } : {}),
      })
      .where(
        and(
          eq(turns.id, input.id),
          inArray(turns.state, input.fromStates),
          activeRunLeaseFence({
            runId: sql`${turns.runId}`,
            fence: input.fence,
            now,
          }),
        ),
      )
      .returning({ id: turns.id });
    return rows.length > 0;
  }

  async finalizeLiveTurnWithLease(input: {
    id: string;
    turnState: Extract<LiveTurnState, 'completed' | 'failed' | 'timed_out'>;
    leaseOutcome: 'completed' | 'failed' | 'released';
    fence: LiveTurnLeaseFence;
    agentRunCompletion?: LiveTurnAgentRunCompletion | null;
    requireNoPendingCommands?: boolean;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    return this.db.transaction(async (tx) => {
      const turns = pgSchema.liveTurnsPostgres;
      const turnRows = await tx
        .select({ id: turns.id, runId: turns.runId, state: turns.state })
        .from(turns)
        .where(eq(turns.id, input.id))
        .for('update');
      const turn = turnRows[0];
      if (!turn?.runId) return false;
      if (isTerminalLiveTurnState(turn.state as LiveTurnState)) return false;
      if (input.requireNoPendingCommands) {
        const commands = pgSchema.liveTurnCommandsPostgres;
        const pendingCommands = await tx
          .select({ id: commands.id })
          .from(commands)
          .where(
            and(
              eq(commands.liveTurnId, input.id),
              eq(commands.status, 'pending'),
            ),
          )
          .limit(1);
        if (pendingCommands.length > 0) {
          await settleRunLeaseTx(tx, {
            runId: turn.runId,
            leaseToken: input.fence.leaseToken,
            workerInstanceId: input.fence.workerInstanceId,
            fencingVersion: input.fence.fencingVersion,
            outcome: 'released',
          });
          return false;
        }
      }
      const settled = await settleRunLeaseTx(tx, {
        runId: turn.runId,
        leaseToken: input.fence.leaseToken,
        workerInstanceId: input.fence.workerInstanceId,
        fencingVersion: input.fence.fencingVersion,
        outcome: input.leaseOutcome,
      });
      if (!settled) return false;
      if (input.agentRunCompletion) {
        const runUpdates: Partial<
          typeof pgSchema.agentRunsPostgres.$inferInsert
        > = {
          status: input.agentRunCompletion.status,
          endedAt: now,
        };
        if (input.agentRunCompletion.resultSummary !== undefined) {
          runUpdates.resultSummary = input.agentRunCompletion.resultSummary;
        }
        if (input.agentRunCompletion.errorSummary !== undefined) {
          runUpdates.errorSummary = input.agentRunCompletion.errorSummary;
        }
        await tx
          .update(pgSchema.agentRunsPostgres)
          .set(runUpdates)
          .where(eq(pgSchema.agentRunsPostgres.id, turn.runId));
      }
      await tx
        .update(turns)
        .set({ state: input.turnState, updatedAt: now, endedAt: now })
        .where(eq(turns.id, input.id));
      return true;
    });
  }

  async takeOverLiveTurn(input: {
    id: string;
    lease: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .update(turns)
      .set({
        state: 'recovered',
        workerInstanceId: input.lease.workerInstanceId,
        leaseToken: input.lease.leaseToken,
        fencingVersion: input.lease.fencingVersion,
        retryCount: sql`${turns.retryCount} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(turns.id, input.id),
          notInArray(turns.state, TERMINAL_STATES),
          // The takeover lease must outrank whatever the turn last saw; the
          // run lease claim already serialized recovery, this guards replays.
          or(
            isNull(turns.fencingVersion),
            sql`${turns.fencingVersion} < ${input.lease.fencingVersion}`,
          ),
        ),
      )
      .returning({ id: turns.id });
    return rows.length > 0;
  }

  async listRecoverableLiveTurns(input: {
    unleasedStaleBefore: string;
    limit: number;
    now?: string;
  }): Promise<LiveTurn[]> {
    const now = input.now ?? currentIso();
    const turns = pgSchema.liveTurnsPostgres;
    const leases = pgSchema.runLeasesPostgres;
    const rows = await this.db
      .select()
      .from(turns)
      .where(
        and(
          notInArray(turns.state, TERMINAL_STATES),
          or(
            // Owner lost: the turn has a run but no live lease for it.
            and(
              sql`${turns.runId} IS NOT NULL`,
              sql`${turns.leaseToken} IS NOT NULL`,
              sql`${turns.fencingVersion} IS NOT NULL`,
              sql`NOT EXISTS (
                SELECT 1 FROM ${leases}
                WHERE ${leases.runId} = ${turns.runId}
                  AND ${leases.status} = 'active'
                  AND ${leases.expiresAt} > ${now}
              )`,
            ),
            // Never leased: the claim crashed before lease attach.
            and(
              isNull(turns.leaseToken),
              lte(turns.updatedAt, input.unleasedStaleBefore),
            ),
          ),
        ),
      )
      .orderBy(asc(turns.updatedAt))
      .limit(Math.max(1, Math.floor(input.limit)));
    return rows.map(toLiveTurn);
  }

  async getOldestWaitingLiveAdmission(input: {
    conversationJids: string[];
    now?: string;
  }): Promise<{
    conversationJid: string;
    threadId: string | null;
    waitingSince: string;
    ageSeconds: number;
  } | null> {
    if (input.conversationJids.length === 0) return null;
    const now = input.now ?? currentIso();
    // messages.conversation_id is `conversation:<jid>`; live_turns.conversation_id
    // is the raw jid. A message waits when no non-terminal turn covers its
    // conversation AND it arrived after the conversation's latest turn
    // high-water mark (terminal turns bound by ended_at: continuations handled
    // mid-turn are newer than created_at yet covered). Conversation-level on
    // purpose — reverse-parsing canonical thread ids is fragile.
    const prefixed = sql.join(
      input.conversationJids.map((jid) => sql`${`conversation:${jid}`}`),
      sql`, `,
    );
    const result = await this.db.execute<{
      conversation_id: string;
      waiting_since: string;
      age_seconds: number;
    }>(sql`
      SELECT m.conversation_id,
             m.created_at AS waiting_since,
             floor(extract(epoch FROM (${now}::timestamptz - m.created_at)))::int AS age_seconds
      FROM messages m
      WHERE m.conversation_id IN (${prefixed})
        AND m.direction = 'inbound'
        AND NOT EXISTS (
          SELECT 1 FROM live_turns lt
          WHERE 'conversation:' || lt.conversation_id = m.conversation_id
            AND lt.state NOT IN ('completed', 'failed', 'timed_out')
        )
        AND m.created_at > COALESCE(
          (SELECT max(COALESCE(lt2.ended_at, lt2.updated_at, lt2.created_at))
           FROM live_turns lt2
           WHERE 'conversation:' || lt2.conversation_id = m.conversation_id),
          '-infinity'::timestamptz
        )
      ORDER BY m.created_at ASC
      LIMIT 1
    `);
    const row = result.rows[0];
    if (!row) return null;
    return {
      conversationJid: row.conversation_id.replace(/^conversation:/, ''),
      threadId: null,
      waitingSince: String(row.waiting_since),
      ageSeconds: Number(row.age_seconds) || 0,
    };
  }

  async appendLiveTurnCommand(input: {
    id: string;
    liveTurnId: string;
    commandType: LiveTurnCommandType;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
    createdByWorkerId?: string | null;
    now?: string;
  }): Promise<LiveTurnCommandAppendResult> {
    const now = input.now ?? currentIso();
    const existing = await this.findCommandByIdempotencyKey({
      liveTurnId: input.liveTurnId,
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) return { outcome: 'replayed', command: existing };
    try {
      return await this.db.transaction(async (tx) => {
        const turns = pgSchema.liveTurnsPostgres;
        // Row-locking sequence allocation: the UPDATE serializes concurrent
        // appends on the same turn, so seq order can never regress.
        const allocated = await tx
          .update(turns)
          .set({
            nextCommandSeq: sql`${turns.nextCommandSeq} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(turns.id, input.liveTurnId),
              notInArray(turns.state, TERMINAL_STATES),
            ),
          )
          .returning({
            nextCommandSeq: turns.nextCommandSeq,
            scopeKey: turns.scopeKey,
            fencingVersion: turns.fencingVersion,
          });
        const turn = allocated[0];
        if (!turn) return { outcome: 'rejected', command: null };
        const row: LiveTurnCommandRow = {
          id: input.id,
          liveTurnId: input.liveTurnId,
          scopeKey: turn.scopeKey,
          commandType: input.commandType,
          seq: turn.nextCommandSeq - 1,
          idempotencyKey: input.idempotencyKey,
          payloadJson: input.payload ?? {},
          status: 'pending',
          fencingVersion: turn.fencingVersion,
          createdByWorkerId: input.createdByWorkerId ?? null,
          appliedByWorkerId: null,
          rejectedReason: null,
          createdAt: now,
          appliedAt: null,
        };
        await tx.insert(pgSchema.liveTurnCommandsPostgres).values(row);
        return { outcome: 'appended', command: toLiveTurnCommand(row) };
      });
    } catch (err) {
      // A concurrent append with the same idempotency key rolls this
      // transaction back (including the seq bump) via the unique index;
      // return the winner's command.
      if (!isUniqueViolation(err)) throw err;
      const winner = await this.findCommandByIdempotencyKey({
        liveTurnId: input.liveTurnId,
        idempotencyKey: input.idempotencyKey,
      });
      if (!winner) throw err;
      return { outcome: 'replayed', command: winner };
    }
  }

  async listPendingLiveTurnCommands(input: {
    liveTurnId: string;
    limit: number;
  }): Promise<LiveTurnCommand[]> {
    const commands = pgSchema.liveTurnCommandsPostgres;
    const rows = await this.db
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.liveTurnId, input.liveTurnId),
          eq(commands.status, 'pending'),
        ),
      )
      .orderBy(asc(commands.seq))
      .limit(Math.max(1, Math.floor(input.limit)));
    return rows.map(toLiveTurnCommand);
  }

  async isLiveTurnCommandFenceActive(input: {
    id: string;
    fence: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const commands = pgSchema.liveTurnCommandsPostgres;
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .select({ id: commands.id })
      .from(commands)
      .where(
        and(
          eq(commands.id, input.id),
          eq(commands.status, 'pending'),
          activeRunLeaseFence({
            runId: sql`(SELECT ${turns.runId} FROM ${turns} WHERE ${turns.id} = ${commands.liveTurnId})`,
            fence: input.fence,
            now,
          }),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async markLiveTurnCommandApplied(input: {
    id: string;
    appliedByWorkerId: string;
    fence?: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const commands = pgSchema.liveTurnCommandsPostgres;
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .update(commands)
      .set({
        status: 'applied',
        appliedByWorkerId: input.appliedByWorkerId,
        appliedAt: now,
      })
      .where(
        and(
          eq(commands.id, input.id),
          eq(commands.status, 'pending'),
          input.fence
            ? activeRunLeaseFence({
                runId: sql`(SELECT ${turns.runId} FROM ${turns} WHERE ${turns.id} = ${commands.liveTurnId})`,
                fence: input.fence,
                now,
              })
            : undefined,
        ),
      )
      .returning({ id: commands.id });
    return rows.length > 0;
  }

  async markLiveTurnCommandRejected(input: {
    id: string;
    reason: string;
    fence?: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const commands = pgSchema.liveTurnCommandsPostgres;
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .update(commands)
      .set({
        status: 'rejected',
        rejectedReason: input.reason,
        appliedAt: now,
      })
      .where(
        and(
          eq(commands.id, input.id),
          eq(commands.status, 'pending'),
          input.fence
            ? activeRunLeaseFence({
                runId: sql`(SELECT ${turns.runId} FROM ${turns} WHERE ${turns.id} = ${commands.liveTurnId})`,
                fence: input.fence,
                now,
              })
            : undefined,
        ),
      )
      .returning({ id: commands.id });
    return rows.length > 0;
  }

  private async findCommandByIdempotencyKey(input: {
    liveTurnId: string;
    idempotencyKey: string;
  }): Promise<LiveTurnCommand | null> {
    const commands = pgSchema.liveTurnCommandsPostgres;
    const rows = await this.db
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.liveTurnId, input.liveTurnId),
          eq(commands.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toLiveTurnCommand(row) : null;
  }
}
