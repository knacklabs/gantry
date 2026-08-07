import {
  PromptProfileService,
  type PromptAccessPreset,
  type PromptModelIdentity,
  type PromptProfileServiceOptions,
  promptProfileAgentIdForFolder,
  renderChannelPromptPresentationLine,
} from '../application/agents/prompt-profile-service.js';
import type { ConversationRoute } from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import type { AgentInput } from './agent-spawn-types.js';
import { MCP_PROXY_GANTRY_MCP_TOOL_NAMES } from '../shared/admin-mcp-tools.js';

export function resolveSpawnPromptAccessPreset(
  configured: PromptAccessPreset,
  hideAuthorityTools: boolean,
): PromptAccessPreset {
  return configured === 'locked' || hideAuthorityTools ? 'locked' : 'full';
}

export async function compileSpawnSystemPrompt(input: {
  group: ConversationRoute;
  agentInput: AgentInput;
  appId: string;
  accessPreset: PromptAccessPreset;
  mcpInventoryToolsMounted: boolean;
  modelIdentity?: PromptModelIdentity;
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
    compiledSystemPrompt = await input.measureAsync('promptCompileMs', () =>
      promptProfileService.compileSystemPrompt({
        agentFolder: input.group.folder,
        persona: input.agentInput.persona ?? input.group.agentConfig?.persona,
        appId: input.appId,
        agentId:
          input.agentInput.agentId ??
          promptProfileAgentIdForFolder(input.group.folder),
        accessPreset: input.accessPreset,
        capabilityCatalog: input.agentInput.capabilityCatalog,
        mcpInventoryToolsMounted:
          input.mcpInventoryToolsMounted &&
          input.agentInput.callerResolvedTools == null,
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
  if (input.agentInput.callerResolvedTools) {
    compiledSystemPrompt = withoutMcpProxyGuidance(compiledSystemPrompt);
  }
  return [compiledSystemPrompt, callerResolvedToolGuidance(input.agentInput)]
    .filter(Boolean)
    .join('\n\n');
}

function withoutMcpProxyGuidance(prompt: string): string {
  return prompt
    .split('\n')
    .filter(
      (line) =>
        !MCP_PROXY_GANTRY_MCP_TOOL_NAMES.some((toolName) =>
          line.includes(toolName),
        ),
    )
    .join('\n');
}

function callerResolvedToolGuidance(agentInput: AgentInput): string {
  const toolNames = (agentInput.callerResolvedTools?.tools ?? [])
    .map((tool) => tool.name.trim())
    .filter((name) => /^[A-Za-z0-9_.-]+$/u.test(name));
  if (toolNames.length === 0) return '';
  return [
    '# Caller-resolved job tools',
    'The following exact names are direct Gantry host tools mounted for this job. Call them directly. Never pass them to mcp_call_tool, and never use MCP inventory or search tools to find them.',
    ...toolNames.map((name) => `- mcp__gantry__${name}`),
  ].join('\n');
}
