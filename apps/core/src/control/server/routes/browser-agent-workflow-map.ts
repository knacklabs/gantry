import { PostgresPersonIdentityRepository } from '../../../adapters/storage/postgres/repositories/person-identity-repository.postgres.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { Agent } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import { listModelCatalogEntries } from '../../../shared/model-catalog.js';
import { capabilityService } from './browser-agents-helpers.js';

export const AGENT_WORKFLOW_MAP_PATH =
  /^\/ui\/api\/agents\/([^/]+)\/workflow-map$/;

type WorkflowRelationship =
  | {
      id: string;
      kind: 'conversation';
      title: string;
      providerLabel: string;
      status: string;
    }
  | {
      id: string;
      kind: 'job';
      name: string;
      schedule: string;
      status: string;
      nextRun: string | null;
    }
  | {
      id: string;
      kind: 'model';
      alias: string;
      displayName: string;
      provider: string;
    }
  | {
      id: string;
      kind: 'skill' | 'mcp_server';
      name: string;
      sourceStatus: string;
    }
  | {
      id: string;
      kind: 'approver';
      displayName: string;
      conversation: string;
    };

export async function buildAgentWorkflowMap(
  storage: ReturnType<typeof getRuntimeStorage>,
  appId: AppId,
  agent: Agent,
): Promise<{ relationships: WorkflowRelationship[] }> {
  const [config, installs, conversations, accounts, jobs, sources, peoplePage] =
    await Promise.all([
      agent.currentConfigVersionId
        ? storage.repositories.agentConfigs.getConfigVersion(
            agent.currentConfigVersionId,
          )
        : null,
      storage.repositories.providerAccounts.listConversationInstalls(
        appId,
        agent.id,
      ),
      storage.repositories.conversations.listConversations({ appId }),
      storage.repositories.providerAccounts.listProviderAccounts(appId),
      storage.ops.listJobs({ appId, agentId: agent.id, limit: 500 }),
      capabilityService(storage).getSources({ appId, agentId: agent.id }),
      new PostgresPersonIdentityRepository(storage.service.db).listPeople(
        appId,
        { limit: 200 },
      ),
    ]);
  const conversationById = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const conversationIds = installs.map((install) => install.conversationId);
  const approvers = conversationIds.length
    ? await storage.repositories.conversations.listConversationApproversForConversations(
        conversationIds,
      )
    : [];
  const personById = new Map(
    peoplePage.people.map((person) => [person.personId, person]),
  );
  const aliasById = new Map(
    peoplePage.people.flatMap((person) =>
      (person.aliases ?? []).map((alias) => [alias.id, alias] as const),
    ),
  );
  const configuredAlias = config?.modelAliasSnapshot ?? null;
  const model = configuredAlias
    ? listModelCatalogEntries().find(
        (entry) => entry.recommendedAlias === configuredAlias,
      )
    : undefined;

  const relationships: WorkflowRelationship[] = [
    ...installs.map((install) => {
      const conversation = conversationById.get(install.conversationId);
      const account = accountById.get(install.providerAccountId);
      return {
        id: String(install.id),
        kind: 'conversation' as const,
        title: conversation?.title ?? install.displayName,
        providerLabel: account
          ? `${account.label} · ${String(account.providerId)}`
          : 'Channel account unavailable',
        status: install.status,
      };
    }),
    ...jobs.map((job) => ({
      id: job.id,
      kind: 'job' as const,
      name: job.name,
      schedule: `${job.schedule_type} · ${job.schedule_value}`,
      status: job.status,
      nextRun: job.next_run,
    })),
    ...(configuredAlias
      ? [
          {
            id: `model:${configuredAlias}`,
            kind: 'model' as const,
            alias: configuredAlias,
            displayName: model?.displayName ?? configuredAlias,
            provider: model?.modelRoute.label ?? 'Configured model',
          },
        ]
      : []),
    ...sources.sources.skills.map((skill) => ({
      id: String(skill.id),
      kind: 'skill' as const,
      name: skill.name ?? String(skill.id),
      sourceStatus: skill.status ?? 'installed',
    })),
    ...sources.sources.mcpServers.map((server) => ({
      id: String(server.id),
      kind: 'mcp_server' as const,
      name: server.name ?? String(server.id),
      sourceStatus: server.status ?? 'disabled',
    })),
    ...approvers.map((approver) => {
      const person = approver.personId
        ? personById.get(approver.personId)
        : undefined;
      const alias = approver.aliasId
        ? aliasById.get(approver.aliasId)
        : undefined;
      return {
        id: String(approver.id),
        kind: 'approver' as const,
        displayName:
          person?.displayName ?? alias?.displayName ?? approver.externalUserId,
        conversation:
          conversationById.get(approver.conversationId)?.title ??
          String(approver.conversationId),
      };
    }),
  ];

  const order: Record<WorkflowRelationship['kind'], number> = {
    conversation: 0,
    job: 1,
    model: 2,
    skill: 3,
    mcp_server: 4,
    approver: 5,
  };
  relationships.sort(
    (left, right) =>
      order[left.kind] - order[right.kind] ||
      relationshipLabel(left).localeCompare(relationshipLabel(right)) ||
      left.id.localeCompare(right.id),
  );
  return { relationships };
}

function relationshipLabel(relationship: WorkflowRelationship): string {
  if (relationship.kind === 'conversation') return relationship.title;
  if (relationship.kind === 'job') return relationship.name;
  if (relationship.kind === 'model') return relationship.displayName;
  if (relationship.kind === 'approver') return relationship.displayName;
  return relationship.name;
}

export type { WorkflowRelationship };
