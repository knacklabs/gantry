import { and, asc, eq, sql } from 'drizzle-orm';

import type {
  LiveTurnCommandAppendInput,
  LiveTurnCommandNotifier,
} from '../../../../domain/ports/live-turns.js';
import type {
  PendingInteraction,
  PendingInteractionKind,
  PermissionPromptGroup,
} from '../../../../domain/ports/worker-coordination.js';
import type {
  PermissionCallbackClaim,
  PermissionCallbackClaimReference,
  PermissionCallbackScope,
  PermissionRecoveryEnvelope,
} from '../../../../domain/types.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import {
  cancelPendingQuestionInteractionIfRunLeaseInactiveRow,
  createPendingInteractionRow,
  findPendingInteractionByIdempotencyKeyRow,
  findPendingInteractionByRequestRow,
  resolvePendingInteractionRow,
  toPendingInteraction,
  updatePendingInteractionPayloadRow,
} from './worker-coordination-interaction.postgres.js';
import {
  bindPendingPermissionPromptRows,
  claimPendingPermissionCallbackRows,
  expirePendingPermissionReviewEachRows,
  findPendingPermissionPromptByMemberRow,
  findPendingPermissionPromptByMessageRow,
  findPendingPermissionPromptRow,
  releasePendingPermissionCallbackRows,
  settlePendingPermissionCallbackRows,
} from './worker-coordination-permission-prompt.postgres.js';

export abstract class PostgresInteractionRepositoryMethods {
  protected constructor(
    protected readonly db: CanonicalDb,
    private readonly commandNotifier?: LiveTurnCommandNotifier,
  ) {}

  async createPendingInteraction(input: {
    id: string;
    appId: string;
    runId?: string | null;
    sourceAgentFolder: string;
    requestId: string;
    runLeaseToken?: string | null;
    runLeaseFencingVersion?: number | null;
    kind: PendingInteractionKind;
    payload: Record<string, unknown>;
    callbackRoute?: Record<string, unknown> | null;
    idempotencyKey: string;
    expiresAt: string;
    now?: string;
  }): Promise<PendingInteraction> {
    return createPendingInteractionRow(this.db, {
      ...input,
      now: input.now ?? currentIso(),
    });
  }

  async resolvePendingInteraction(input: {
    idempotencyKey: string;
    status: 'resolved' | 'cancelled';
    resolution: Record<string, unknown>;
    approverRef?: string | null;
    permissionCallbackClaim?: PermissionCallbackClaimReference | null;
    liveTurnCommand?: LiveTurnCommandAppendInput | null;
    now?: string;
  }): Promise<boolean> {
    const result = await resolvePendingInteractionRow(this.db, {
      ...input,
      now: input.now ?? currentIso(),
    });
    if (result.command) {
      await this.commandNotifier?.notifyLiveTurnCommand({
        liveTurnId: result.command.liveTurnId,
        commandId: result.command.id,
      });
    }
    return result.resolved;
  }

  async cancelPendingQuestionInteractionIfRunLeaseInactive(input: {
    id: string;
    resolution: Record<string, unknown>;
    now?: string;
  }): Promise<boolean> {
    return cancelPendingQuestionInteractionIfRunLeaseInactiveRow(this.db, {
      ...input,
      now: input.now ?? currentIso(),
    });
  }

  async updatePendingInteractionPayload(input: {
    idempotencyKey: string;
    update: (
      payload: Record<string, unknown>,
    ) => Record<string, unknown> | null;
  }): Promise<boolean> {
    return updatePendingInteractionPayloadRow(this.db, input);
  }

  async claimPendingPermissionCallback(input: {
    claim: PermissionCallbackClaim;
  }): Promise<PermissionPromptGroup | null> {
    return claimPendingPermissionCallbackRows(this.db, input);
  }

  async bindPendingPermissionPrompt(input: {
    id: string;
    appId: string;
    sourceAgentFolder: string;
    interactionId: string;
    matchKind: 'individual' | 'batch';
    members: Array<{
      idempotencyKey: string;
      requestId: string;
      index: number;
    }>;
    envelope: PermissionRecoveryEnvelope;
    fullView?: Record<string, unknown> | null;
    externalPromptProvider?: string | null;
    externalPromptConversationId?: string | null;
    externalPromptMessageId?: string | null;
    externalPromptThreadId?: string | null;
    providerAliases: string[];
    now?: string;
  }): Promise<PermissionPromptGroup | null> {
    return bindPendingPermissionPromptRows(this.db, {
      ...input,
      now: input.now ?? currentIso(),
    });
  }

  async releasePendingPermissionCallback(input: {
    claim: PermissionCallbackClaimReference;
  }): Promise<boolean> {
    return releasePendingPermissionCallbackRows(this.db, {
      ...input,
      now: currentIso(),
    });
  }

  async settlePendingPermissionCallback(input: {
    claim: PermissionCallbackClaimReference;
  }): Promise<boolean> {
    return settlePendingPermissionCallbackRows(this.db, {
      ...input,
      now: currentIso(),
    });
  }

  async expirePendingPermissionReviewEach(input: {
    claim: PermissionCallbackClaimReference;
    now?: string;
  }): Promise<PermissionPromptGroup | null> {
    return expirePendingPermissionReviewEachRows(this.db, {
      claim: input.claim,
      now: input.now ?? currentIso(),
    });
  }

  async findPendingPermissionPrompt(input: {
    scope: PermissionCallbackScope;
    now?: string;
    includeTerminalSettlement?: boolean;
  }): Promise<PermissionPromptGroup | null> {
    return findPendingPermissionPromptRow(this.db, {
      scope: input.scope,
      now: input.now ?? currentIso(),
      includeTerminalSettlement: input.includeTerminalSettlement,
    });
  }

  async findPendingPermissionPromptByMember(input: {
    appId: string;
    sourceAgentFolder: string;
    requestId: string;
    now?: string;
  }): Promise<PermissionPromptGroup | null> {
    return findPendingPermissionPromptByMemberRow(this.db, {
      ...input,
      now: input.now ?? currentIso(),
    });
  }

  async findPendingPermissionPromptByMessage(input: {
    appId: string;
    provider: string;
    conversationId: string;
    externalMessageId: string;
    threadId?: string | null;
    now?: string;
  }): Promise<PermissionPromptGroup | null> {
    return findPendingPermissionPromptByMessageRow(this.db, {
      ...input,
      now: input.now ?? currentIso(),
    });
  }

  async findPendingInteractionByRequest(input: {
    appId: string;
    kind: PendingInteractionKind;
    sourceAgentFolder?: string;
    requestId: string;
    now?: string;
  }): Promise<PendingInteraction | null> {
    return findPendingInteractionByRequestRow(this.db, {
      ...input,
      now: input.now ?? currentIso(),
    });
  }

  async findPendingInteractionByIdempotencyKey(input: {
    appId: string;
    idempotencyKey: string;
    runId?: string | null;
    now?: string;
  }): Promise<PendingInteraction | null> {
    return findPendingInteractionByIdempotencyKeyRow(this.db, {
      ...input,
      now: input.now ?? currentIso(),
    });
  }

  async listPendingInteractions(input: {
    appId: string;
    runId?: string | null;
    now?: string;
  }): Promise<PendingInteraction[]> {
    const now = input.now ?? currentIso();
    const table = pgSchema.pendingInteractionsPostgres;
    const rows = await this.db
      .select()
      .from(table)
      .where(
        and(
          eq(table.appId, input.appId),
          eq(table.status, 'pending'),
          sql`${table.expiresAt} > ${now}`,
          input.runId ? eq(table.runId, input.runId) : undefined,
        ),
      )
      .orderBy(asc(table.createdAt));
    return rows.map(toPendingInteraction);
  }
}
