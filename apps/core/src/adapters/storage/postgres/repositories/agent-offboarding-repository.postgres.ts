import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import type { AgentId } from '../../../../domain/agent/agent.js';
import {
  serializePrincipalRef,
  type PrincipalRef,
} from '../../../../domain/identity/principal-ref.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import { PostgresRuntimeEventRepository } from './runtime-event-repository.postgres.js';
import { PostgresSettingsRevisionRepository } from './settings-revision-repository.postgres.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import * as pgSchema from '../schema/schema.js';

export class PostgresAgentOffboardingRepository {
  private readonly runtimeEvents: PostgresRuntimeEventRepository;
  private readonly settingsRevisions: PostgresSettingsRevisionRepository;

  constructor(private readonly db: CanonicalDb) {
    this.runtimeEvents = new PostgresRuntimeEventRepository(db);
    this.settingsRevisions = new PostgresSettingsRevisionRepository(db);
  }

  async offboard(input: {
    appId: string;
    agentId: AgentId;
    defaultAgentId: AgentId;
    expectedSettingsRevision: number;
    settingsDocument: Record<string, unknown>;
    createdBy: string;
    actor: PrincipalRef;
    now: string;
    minReaderVersion: number;
  }): Promise<
    | {
        status: 'offboarded';
        agentName: string;
        providerAccountsDisabled: number;
        conversationInstallsRemoved: number;
        jobsCancelled: number;
        settingsRevision: number;
      }
    | { status: 'already_offboarded' }
  > {
    return this.db.transaction(async (tx) => {
      const [agent] = await tx
        .select()
        .from(pgSchema.agentsPostgres)
        .where(
          and(
            eq(pgSchema.agentsPostgres.appId, input.appId),
            eq(pgSchema.agentsPostgres.id, input.agentId),
          ),
        )
        .for('update')
        .limit(1);
      if (!agent) throw new Error('Agent not found.');
      if (agent.id === input.defaultAgentId) {
        throw new Error('The default AI employee cannot be offboarded.');
      }
      if (agent.status === 'offboarded')
        return { status: 'already_offboarded' };

      const [currentRevision] = await tx
        .select({ revision: pgSchema.settingsRevisionsPostgres.revision })
        .from(pgSchema.settingsRevisionsPostgres)
        .where(eq(pgSchema.settingsRevisionsPostgres.appId, input.appId))
        .orderBy(desc(pgSchema.settingsRevisionsPostgres.revision))
        .for('update')
        .limit(1);
      if ((currentRevision?.revision ?? 0) !== input.expectedSettingsRevision) {
        throw new Error('Desired state changed; retry offboarding.');
      }

      const [person] = await tx
        .select({ id: pgSchema.usersPostgres.id })
        .from(pgSchema.usersPostgres)
        .where(
          and(
            eq(pgSchema.usersPostgres.appId, input.appId),
            eq(pgSchema.usersPostgres.agentId, input.agentId),
            eq(pgSchema.usersPostgres.kind, 'service'),
          ),
        )
        .for('update')
        .limit(1);
      if (!person) throw new Error('Agent service Person is missing.');

      const accounts = await tx
        .select({ id: pgSchema.providerAccountsPostgres.id })
        .from(pgSchema.providerAccountsPostgres)
        .where(
          and(
            eq(pgSchema.providerAccountsPostgres.appId, input.appId),
            eq(pgSchema.providerAccountsPostgres.agentId, input.agentId),
          ),
        )
        .for('update');
      const accountIds = accounts.map((account) => account.id);
      const installs = await tx
        .delete(pgSchema.conversationInstallsPostgres)
        .where(
          and(
            eq(pgSchema.conversationInstallsPostgres.appId, input.appId),
            eq(pgSchema.conversationInstallsPostgres.agentId, input.agentId),
          ),
        )
        .returning({ id: pgSchema.conversationInstallsPostgres.id });

      if (accountIds.length > 0) {
        await tx
          .update(pgSchema.providerAccountsPostgres)
          .set({ status: 'disabled', updatedAt: input.now })
          .where(inArray(pgSchema.providerAccountsPostgres.id, accountIds));
      }
      await tx
        .update(pgSchema.userAliasesPostgres)
        .set({
          retiredAt: input.now,
          retiredBy: serializePrincipalRef(input.actor),
          updatedAt: input.now,
        })
        .where(
          and(
            eq(pgSchema.userAliasesPostgres.appId, input.appId),
            eq(pgSchema.userAliasesPostgres.userId, person.id),
            isNull(pgSchema.userAliasesPostgres.retiredAt),
          ),
        );
      const jobs = await tx
        .update(pgSchema.canonicalJobsPostgres)
        .set({
          status: 'cancelled',
          nextRunAt: null,
          pauseReason: 'agent_offboarded',
          updatedAt: input.now,
        })
        .where(
          and(
            eq(pgSchema.canonicalJobsPostgres.appId, input.appId),
            eq(pgSchema.canonicalJobsPostgres.agentId, input.agentId),
          ),
        )
        .returning({ id: pgSchema.canonicalJobsPostgres.id });
      await tx
        .update(pgSchema.agentsPostgres)
        .set({ status: 'offboarded', updatedAt: input.now })
        .where(eq(pgSchema.agentsPostgres.id, input.agentId));
      await tx
        .update(pgSchema.usersPostgres)
        .set({ status: 'offboarded', updatedAt: input.now })
        .where(eq(pgSchema.usersPostgres.id, person.id));

      const revision =
        await this.settingsRevisions.appendSettingsRevisionWithExecutor(tx, {
          appId: input.appId,
          settingsDocument: input.settingsDocument,
          minReaderVersion: input.minReaderVersion,
          createdBy: input.createdBy,
          note: `AI employee ${agent.id} offboarded`,
          expectedRevision: input.expectedSettingsRevision,
          now: input.now,
        });
      if (revision.status === 'conflict') {
        throw new Error('Desired state changed; retry offboarding.');
      }

      const idempotencyKey = `identity.offboarded:${input.appId}:${agent.id}`;
      await tx.insert(pgSchema.identityOffboardingAuditPostgres).values({
        id: `identity-offboarding:${input.appId}:${agent.id}`,
        appId: input.appId,
        idempotencyKey,
        personId: person.id,
        agentId: agent.id,
        actor: serializePrincipalRef(input.actor),
        resultJson: {
          providerAccountsDisabled: accountIds.length,
          conversationInstallsRemoved: installs.length,
          jobsCancelled: jobs.length,
          settingsRevision: revision.revision.revision,
        },
        createdAt: input.now,
      });
      await this.runtimeEvents.appendRuntimeEventWithExecutor(tx, {
        appId: input.appId as never,
        agentId: input.agentId,
        eventType: RUNTIME_EVENT_TYPES.IDENTITY_OFFBOARDED,
        actor: input.actor,
        idempotencyKey,
        payload: {
          personId: person.id,
          providerAccountsDisabled: accountIds.length,
          conversationInstallsRemoved: installs.length,
          jobsCancelled: jobs.length,
          settingsRevision: revision.revision.revision,
        },
        createdAt: input.now as never,
      });
      return {
        status: 'offboarded' as const,
        agentName: agent.name,
        providerAccountsDisabled: accountIds.length,
        conversationInstallsRemoved: installs.length,
        jobsCancelled: jobs.length,
        settingsRevision: revision.revision.revision,
      };
    });
  }
}
