import { randomUUID } from 'node:crypto';

import { ApplicationError } from '../common/application-error.js';
import {
  agentIdForFolder,
  folderForAgentId,
} from '../../domain/agent/agent-folder-id.js';
import type { Agent, AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentCreationDraft,
  AgentCreationDraftId,
} from '../../domain/agent-creation/agent-creation-draft.js';
import type {
  AgentCreationDraftRepository,
  AgentRepository,
} from '../../domain/ports/repositories.js';
import type { ControlAgentSettingsPort } from '../control-plane/control-plane-storage-model.js';
import type { AgentHarness } from '../../shared/agent-engine.js';
import { resolveModelSelectionForWorkload } from '../../shared/model-catalog.js';

type IdentityDocument = { name: string; agentHarness: AgentHarness };

function identityFrom(document: Record<string, unknown>): IdentityDocument {
  const name = typeof document.name === 'string' ? document.name.trim() : '';
  const agentHarness = document.agentHarness;
  if (
    name.length < 1 ||
    name.length > 80 ||
    !['auto', 'anthropic_sdk', 'deepagents'].includes(String(agentHarness))
  ) {
    throw new ApplicationError('INVALID_REQUEST', 'Draft identity is invalid');
  }
  return { name, agentHarness: agentHarness as AgentHarness };
}

function unsupportedConfigurationBlockers(document: Record<string, unknown>) {
  const blockers: string[] = [];
  const workSource = document.workSource;
  if (
    workSource &&
    typeof workSource === 'object' &&
    'kind' in workSource &&
    workSource.kind !== 'configure_later'
  ) {
    blockers.push(
      'Conversation and scheduled-job setup require a provider account owned by the new agent.',
    );
  }
  return blockers;
}

function stringArray(document: Record<string, unknown>, key: string): string[] {
  const value = document[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function accessFrom(document: Record<string, unknown>) {
  const capabilities = Array.isArray(document.capabilities)
    ? document.capabilities.flatMap((item) => {
        if (
          item &&
          typeof item === 'object' &&
          typeof item.id === 'string' &&
          typeof item.version === 'string'
        ) {
          return [{ id: item.id, version: item.version }];
        }
        return [];
      })
    : [];
  const tools = Array.isArray(document.toolSources)
    ? document.toolSources.flatMap((item) => {
        if (
          item &&
          typeof item === 'object' &&
          typeof item.id === 'string' &&
          typeof item.kind === 'string'
        ) {
          return [
            {
              id: item.id,
              kind: item.kind,
              ...(typeof item.version === 'string'
                ? { version: item.version }
                : {}),
            },
          ];
        }
        return [];
      })
    : [];
  return {
    capabilities,
    sources: {
      skills: stringArray(document, 'skillIds').map((id) => ({ id })),
      mcpServers: stringArray(document, 'mcpServerIds').map((id) => ({ id })),
      tools,
    },
  };
}

function hasAccess(document: Record<string, unknown>) {
  const access = accessFrom(document);
  return (
    access.capabilities.length > 0 ||
    access.sources.skills.length > 0 ||
    access.sources.mcpServers.length > 0 ||
    access.sources.tools.length > 0
  );
}

function modelAliasFrom(document: Record<string, unknown>): string | null {
  const alias = document.modelAlias;
  if (alias === undefined || alias === null || alias === '') return null;
  if (typeof alias !== 'string') {
    throw new ApplicationError('INVALID_REQUEST', 'Draft model is invalid');
  }
  const resolution = resolveModelSelectionForWorkload(alias, 'chat');
  if (!resolution.ok) {
    throw new ApplicationError('INVALID_REQUEST', 'Draft model is unavailable');
  }
  return resolution.alias;
}

export class AgentCreationService {
  constructor(
    private readonly deps: {
      drafts: AgentCreationDraftRepository;
      agents: AgentRepository;
      agentSettings: ControlAgentSettingsPort;
      applyAccess(input: {
        appId: AppId;
        agentId: AgentId;
        access: ReturnType<typeof accessFrom>;
      }): Promise<void>;
      applyDelegates(input: {
        appId: AppId;
        agentId: AgentId;
        delegates: string[];
      }): Promise<void>;
      runtimeHome: string;
      now: () => string;
    },
  ) {}

  async preflight(input: { appId: AppId; id: AgentCreationDraftId }) {
    const draft = await this.requireDraft(input);
    const identity = identityFrom(draft.document);
    modelAliasFrom(draft.document);
    const agents = await this.deps.agents.listAgents(input.appId);
    const duplicate = agents.some(
      (agent) =>
        agent.name.trim().toLocaleLowerCase() ===
          identity.name.toLocaleLowerCase() && agent.id !== draft.agentId,
    );
    const blockers = [
      ...(duplicate ? ['An agent with this name already exists.'] : []),
      ...unsupportedConfigurationBlockers(draft.document),
    ];
    return { ok: blockers.length === 0, blockers };
  }

  async createOrResume(input: {
    appId: AppId;
    id: AgentCreationDraftId;
    leaseToken: string;
  }) {
    const draft = await this.requireDraft(input);
    if (draft.status === 'completed' && draft.agentId) return draft;
    const preflight = await this.preflight(input);
    if (!preflight.ok) {
      throw new ApplicationError('INVALID_REQUEST', preflight.blockers[0]);
    }
    const now = this.deps.now();
    const claimed = await this.deps.drafts.claimDraft({
      ...input,
      leaseExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
      now,
    });
    if (!claimed) {
      throw new ApplicationError(
        'CONFLICT',
        'Draft is being created elsewhere',
      );
    }

    let reserved = await this.reserveAgent(claimed);
    try {
      const identity = identityFrom(reserved.document);
      const modelAlias = modelAliasFrom(reserved.document);
      const folder = String(reserved.agentId).slice('agent:'.length);
      const agent: Agent = {
        id: reserved.agentId as AgentId,
        appId: input.appId,
        name: identity.name,
        status: 'active',
        createdAt: reserved.createdAt,
        updatedAt: this.deps.now(),
      };
      await this.deps.agents.saveAgent(agent);
      reserved = await this.save(reserved, {
        status: 'applying',
        progress: { agent: 'completed' },
      });
      await this.deps.agentSettings.writeAgentHarnessSetting({
        runtimeHome: this.deps.runtimeHome,
        appId: input.appId,
        folder,
        name: identity.name,
        agentHarness: identity.agentHarness,
        modelAlias,
      });
      reserved = await this.save(reserved, {
        progress: { ...reserved.progress, model: 'completed' },
      });
      if (hasAccess(reserved.document)) {
        await this.deps.applyAccess({
          appId: input.appId,
          agentId: agent.id,
          access: accessFrom(reserved.document),
        });
      }
      reserved = await this.save(reserved, {
        progress: { ...reserved.progress, access: 'completed' },
      });
      const delegates = stringArray(reserved.document, 'delegateIds');
      if (delegates.length > 0) {
        const agents = await this.deps.agents.listAgents(input.appId);
        const folders = delegates.map((delegateId) => {
          const target = agents.find(
            (candidate) => candidate.id === delegateId,
          );
          const folder = target ? folderForAgentId(target.id) : null;
          if (!target || target.id === agent.id || !folder) {
            throw new ApplicationError(
              'INVALID_REQUEST',
              'Draft delegates are invalid',
            );
          }
          return folder;
        });
        await this.deps.applyDelegates({
          appId: input.appId,
          agentId: agent.id,
          delegates: folders,
        });
      }
      reserved = await this.save(reserved, {
        progress: { ...reserved.progress, delegation: 'completed' },
      });
      return await this.save(reserved, {
        status: 'completed',
        currentStep: 'review',
        progress: { ...reserved.progress, workSource: 'completed' },
        completedAt: this.deps.now(),
        errorCode: undefined,
        errorMessage: undefined,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      });
    } catch (error) {
      await this.save(reserved, {
        status: 'needs_attention',
        progress: reserved.progress,
        errorCode: 'CREATE_FAILED',
        errorMessage: 'Agent setup needs attention before it can be resumed.',
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      });
      throw error;
    }
  }

  private async requireDraft(input: {
    appId: AppId;
    id: AgentCreationDraftId;
  }) {
    const draft = await this.deps.drafts.getDraft(input);
    if (!draft)
      throw new ApplicationError('NOT_FOUND', 'Creation draft not found');
    return draft;
  }

  private async reserveAgent(
    draft: AgentCreationDraft,
  ): Promise<AgentCreationDraft> {
    if (draft.agentId) return draft;
    return this.save(draft, { agentId: agentIdForFolder(randomUUID()) });
  }

  private async save(
    draft: AgentCreationDraft,
    changes: Partial<AgentCreationDraft>,
  ): Promise<AgentCreationDraft> {
    const saved = await this.deps.drafts.saveDraft({
      draft: { ...draft, ...changes, updatedAt: this.deps.now() },
      expectedRevision: draft.revision,
    });
    if (saved === 'conflict') {
      throw new ApplicationError(
        'CONFLICT',
        'Draft changed before setup could continue',
      );
    }
    return saved;
  }
}
