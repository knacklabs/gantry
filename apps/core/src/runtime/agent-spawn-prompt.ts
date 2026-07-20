import {
  PromptProfileService,
  type PromptAccessPreset,
  type PromptModelIdentity,
  type PromptProfileServiceOptions,
  promptProfileAgentIdForFolder,
} from '../application/agents/prompt-profile-service.js';
import type { ConversationRoute } from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import type { AgentInput } from './agent-spawn-types.js';

export async function compileSpawnSystemPrompt(input: {
  group: ConversationRoute;
  agentInput: AgentInput;
  appId: string;
  accessPreset: PromptAccessPreset;
  modelIdentity?: PromptModelIdentity;
  fileArtifactStore: PromptProfileServiceOptions['fileArtifactStore'];
  measureAsync: <T>(
    name: 'promptCompileMs',
    fn: () => Promise<T>,
  ) => Promise<T>;
}): Promise<string> {
  const promptProfileService = new PromptProfileService({
    fileArtifactStore: input.fileArtifactStore,
  });
  let compiledSystemPrompt = '';
  try {
    compiledSystemPrompt = await input.measureAsync('promptCompileMs', () =>
      promptProfileService.compileSystemPrompt({
        agentFolder: input.group.folder,
        persona: input.agentInput.persona ?? input.group.agentConfig?.persona,
        appId: input.appId,
        agentId:
          input.agentInput.agentId ??
          promptProfileAgentIdForFolder(input.group.folder),
        accessPreset: input.accessPreset,
        ...(input.modelIdentity ? { modelIdentity: input.modelIdentity } : {}),
        runtimeContext: {
          chatJid: input.agentInput.chatJid,
          ...(input.group.conversationKind
            ? { conversationKind: input.group.conversationKind }
            : {}),
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
