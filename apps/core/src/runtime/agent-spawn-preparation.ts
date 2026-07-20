import type { ChildProcess } from 'node:child_process';

import type { ConversationRoute } from '../domain/types.js';
import type { AgentRepository } from '../domain/ports/repositories.js';
import { preloadCallableAgentManifest } from '../application/core-tools/callable-agent-tools.js';
import type { AgentRuntime } from '../shared/agent-runtime.js';
import { nowMs } from '../shared/time/datetime.js';
import { prepareRunnerWorkspace } from './agent-spawn-helpers.js';
import { createRunnerHostStartupTiming } from './agent-spawn-startup-timing.js';
import type {
  AgentInput,
  AgentOutput,
  RunAgentOptions,
} from './agent-spawn-types.js';

type HostStartupTiming = ReturnType<typeof createRunnerHostStartupTiming>;

export type AgentSpawnPreparation =
  | { kind: 'inline'; output: AgentOutput }
  | {
      kind: 'worker';
      agentRuntime: AgentRuntime;
      startTime: number;
      hostStartup: HostStartupTiming;
      groupDir: string;
      processName: string;
    };

export async function prepareAgentSpawn(input: {
  group: ConversationRoute;
  agentInput: AgentInput;
  agentRuntime: AgentRuntime;
  onProcess: (proc: ChildProcess, runHandle: string) => void;
  onOutput: ((output: AgentOutput) => Promise<void>) | undefined;
  options: RunAgentOptions;
  warn: (context: Record<string, unknown>, message: string) => void;
}): Promise<AgentSpawnPreparation> {
  const { agentRuntime } = input;
  if (agentRuntime === 'inline') {
    const { runInlineAgent } = await import('./agent-inline.js');
    return {
      kind: 'inline',
      output: await runInlineAgent(
        input.group,
        input.agentInput,
        input.onProcess,
        input.onOutput,
        input.options,
      ),
    };
  }
  const startTime = nowMs();
  const hostStartup = createRunnerHostStartupTiming({ nowMs });
  const { groupDir, processName } = hostStartup.measure('workspacePrepMs', () =>
    prepareRunnerWorkspace({
      folder: input.group.folder,
      nowMs,
      warn: input.warn,
    }),
  );
  return {
    kind: 'worker',
    agentRuntime,
    startTime,
    hostStartup,
    groupDir,
    processName,
  };
}

export async function prepareWorkerAuthorityProjection(input: {
  agentInput: AgentInput;
  accessPreset?: 'full' | 'locked';
  delegates: readonly string[];
  getConversationBoundAgentIds: () => ReadonlySet<string>;
  personasByAgentId: Readonly<Record<string, string | undefined>>;
  workspaceFolder: string;
  options?: RunAgentOptions;
  getAgentRepository: () => AgentRepository;
  warn: (context: Record<string, unknown>, message: string) => void;
}) {
  const accessPreset: 'full' | 'locked' =
    input.accessPreset === 'locked' ? 'locked' : 'full';
  const hideAuthorityTools =
    accessPreset === 'locked' ||
    input.agentInput.hideAuthorityTools === true ||
    process.env.GANTRY_NO_PERMISSION_TOOLS === '1';
  const callableAgentManifest = await preloadCallableAgentManifest({
    run: input.agentInput,
    delegates: input.delegates,
    callerFolder: input.workspaceFolder,
    conversationBoundAgentIds:
      input.options?.asyncTaskRepositoryAvailable === true &&
      !hideAuthorityTools &&
      input.agentInput.parentTaskId == null &&
      input.agentInput.toolPolicyRules?.includes('AgentDelegation') &&
      input.delegates.length > 0
        ? input.getConversationBoundAgentIds()
        : new Set(),
    personasByAgentId: input.personasByAgentId,
    toolsAvailable:
      input.options?.asyncTaskRepositoryAvailable === true &&
      !hideAuthorityTools,
    getRepository: input.getAgentRepository,
    warn: input.warn,
  });
  return { accessPreset, hideAuthorityTools, callableAgentManifest };
}
