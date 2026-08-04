import { and, asc, eq, sql } from 'drizzle-orm';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import { cancelPendingQuestionInteractionIfRunLeaseInactiveRow, createPendingInteractionRow, findPendingInteractionByIdempotencyKeyRow, findPendingInteractionByRequestRow, resolvePendingInteractionRow, toPendingInteraction, updatePendingInteractionPayloadRow, } from './worker-coordination-interaction.postgres.js';
import { bindPendingPermissionPromptRows, claimPendingPermissionCallbackRows, expirePendingPermissionReviewEachRows, findPendingPermissionPromptByMemberRow, findPendingPermissionPromptByMessageRow, findPendingPermissionPromptRow, releasePendingPermissionCallbackRows, settlePendingPermissionCallbackRows, } from './worker-coordination-permission-prompt.postgres.js';
export class PostgresInteractionRepositoryMethods {
    db;
    commandNotifier;
    constructor(db, commandNotifier) {
        this.db = db;
        this.commandNotifier = commandNotifier;
    }
    async createPendingInteraction(input) {
        return createPendingInteractionRow(this.db, {
            ...input,
            now: input.now ?? currentIso(),
        });
    }
    async resolvePendingInteraction(input) {
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
    async cancelPendingQuestionInteractionIfRunLeaseInactive(input) {
        return cancelPendingQuestionInteractionIfRunLeaseInactiveRow(this.db, {
            ...input,
            now: input.now ?? currentIso(),
        });
    }
    async updatePendingInteractionPayload(input) {
        return updatePendingInteractionPayloadRow(this.db, input);
    }
    async claimPendingPermissionCallback(input) {
        return claimPendingPermissionCallbackRows(this.db, input);
    }
    async bindPendingPermissionPrompt(input) {
        return bindPendingPermissionPromptRows(this.db, {
            ...input,
            now: input.now ?? currentIso(),
        });
    }
    async releasePendingPermissionCallback(input) {
        return releasePendingPermissionCallbackRows(this.db, {
            ...input,
            now: currentIso(),
        });
    }
    async settlePendingPermissionCallback(input) {
        return settlePendingPermissionCallbackRows(this.db, {
            ...input,
            now: currentIso(),
        });
    }
    async expirePendingPermissionReviewEach(input) {
        return expirePendingPermissionReviewEachRows(this.db, {
            claim: input.claim,
            now: input.now ?? currentIso(),
        });
    }
    async findPendingPermissionPrompt(input) {
        return findPendingPermissionPromptRow(this.db, {
            scope: input.scope,
            now: input.now ?? currentIso(),
            includeTerminalSettlement: input.includeTerminalSettlement,
        });
    }
    async findPendingPermissionPromptByMember(input) {
        return findPendingPermissionPromptByMemberRow(this.db, {
            ...input,
            now: input.now ?? currentIso(),
        });
    }
    async findPendingPermissionPromptByMessage(input) {
        return findPendingPermissionPromptByMessageRow(this.db, {
            ...input,
            now: input.now ?? currentIso(),
        });
    }
    async findPendingInteractionByRequest(input) {
        return findPendingInteractionByRequestRow(this.db, {
            ...input,
            now: input.now ?? currentIso(),
        });
    }
    async findPendingInteractionByIdempotencyKey(input) {
        return findPendingInteractionByIdempotencyKeyRow(this.db, {
            ...input,
            now: input.now ?? currentIso(),
        });
    }
    async listPendingInteractions(input) {
        const now = input.now ?? currentIso();
        const table = pgSchema.pendingInteractionsPostgres;
        const rows = await this.db
            .select()
            .from(table)
            .where(and(eq(table.appId, input.appId), eq(table.status, 'pending'), sql `${table.expiresAt} > ${now}`, input.runId ? eq(table.runId, input.runId) : undefined))
            .orderBy(asc(table.createdAt));
        return rows.map(toPendingInteraction);
    }
}
