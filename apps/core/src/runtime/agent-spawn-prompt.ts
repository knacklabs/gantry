import {
  PromptProfileService,
  type PromptAccessPreset,
  type PromptModelIdentity,
  type PromptProfileServiceOptions,
  promptProfileAgentIdForFolder,
  renderChannelPromptPresentationLine,
} from '../application/agents/prompt-profile-service.js';
import type { ConversationRoute } from '../domain/types.js';
import type { AgentId, AgentRoleSnapshot } from '../domain/agent/agent.js';
import type {
  AgentConfigRepository,
  AgentRepository,
} from '../domain/ports/repositories.js';
import { logger } from '../infrastructure/logging/logger.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import type { AgentInput } from './agent-spawn-types.js';

export function resolveSpawnPromptAccessPreset(
  configured: PromptAccessPreset,
  hideAuthorityTools: boolean,
): PromptAccessPreset {
  return configured === 'locked' || hideAuthorityTools ? 'locked' : 'full';
}

export async function resolveCurrentAgentRoleSnapshot(
  agentId: string,
  repositories: {
    agents: AgentRepository;
    agentConfigs: AgentConfigRepository;
  },
): Promise<AgentRoleSnapshot | undefined> {
  const agent = await repositories.agents.getAgent(agentId as AgentId);
  if (!agent?.currentConfigVersionId) return undefined;
  return (
    await repositories.agentConfigs.getConfigVersion(
      agent.currentConfigVersionId,
    )
  )?.roleSnapshot;
}

export async function compileSpawnSystemPrompt(input: {
  group: ConversationRoute;
  agentInput: AgentInput;
  appId: string;
  accessPreset: PromptAccessPreset;
  mcpInventoryToolsMounted: boolean;
  modelIdentity?: PromptModelIdentity;
  resolveRoleSnapshot?: (
    agentId: string,
  ) => Promise<AgentRoleSnapshot | undefined>;
  fileArtifactStore: PromptProfileServiceOptions['fileArtifactStore'];
  measureAsync: <T>(
    name: 'promptCompileMs',
    fn: () => Promise<T>,
  ) => Promise<T>;
}): Promise<string> {
  const promptProfileService = new PromptProfileService({
    fileArtifactStore: input.fileArtifactStore,
    onCapabilityCatalogRendered: ({ rendered, omitted }) => {
      logger.info(
        {
          agentFolder: input.group.folder,
          rendered,
          omitted,
        },
        'Rendered agent prompt capability catalog',
      );
    },
  });
  let compiledSystemPrompt = '';
  try {
    const agentId =
      input.agentInput.agentId ??
      promptProfileAgentIdForFolder(input.group.folder);
    const roleSnapshot = input.resolveRoleSnapshot
      ? await input.resolveRoleSnapshot(agentId)
      : undefined;
    compiledSystemPrompt = await input.measureAsync('promptCompileMs', () =>
      promptProfileService.compileSystemPrompt({
        agentFolder: input.group.folder,
        persona: input.agentInput.persona ?? input.group.agentConfig?.persona,
        ...(roleSnapshot ? { roleSnapshot } : {}),
        appId: input.appId,
        agentId,
        accessPreset: input.accessPreset,
        capabilityCatalog: input.agentInput.capabilityCatalog,
        mcpInventoryToolsMounted: input.mcpInventoryToolsMounted,
        ...(input.modelIdentity ? { modelIdentity: input.modelIdentity } : {}),
        runtimeContext: {
          channelContextLine: renderChannelPromptPresentationLine(
            input.agentInput.chatJid,
            input.group.conversationKind,
          ),
          ...(() => {
            try {
              return {
                workspacePath: resolveWorkspaceFolderPath(input.group.folder),
              };
            } catch {
              // Invalid folder names still compile the rest of the profile.
              return {};
            }
          })(),
          ...(input.agentInput.isScheduledJob
            ? {
                job: {
                  ...(input.agentInput.jobId
                    ? { id: input.agentInput.jobId }
                    : {}),
                  ...(input.agentInput.jobName
                    ? { name: input.agentInput.jobName }
                    : {}),
                },
              }
            : {}),
        },
      }),
    );
  } catch (err) {
    logger.warn(
      { err, agentFolder: input.group.folder },
      'Failed to compile prompt profile; continuing without custom system prompt',
    );
  }
  return compiledSystemPrompt;
}
