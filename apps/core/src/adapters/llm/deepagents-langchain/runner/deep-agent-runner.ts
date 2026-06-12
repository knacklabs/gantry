import { createDeepAgent, StateBackend } from 'deepagents';
import type { FilesystemPermission } from 'deepagents';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

import { buildRunnerModel } from './model-factory.js';
import {
  normalizeDeepAgentStream,
  type LangGraphStreamEvent,
} from './stream-normalizer.js';
import { composeDeepAgentSystemPrompt } from './system-prompt.js';
import type { DeepAgentRunnerInput } from './types.js';
import type { PersistedTurnMessage } from './session-store.js';
import type { RunnerOutputFrame } from '../../../../runner/runner-frame.js';

// Raw DeepAgents authority is fully disabled in v1: the default in-memory
// StateBackend has no `execute` tool, and these deny-all rules block every
// built-in filesystem tool (ls/read_file/write_file/edit_file/glob/grep). No
// custom tools, no MCP, no LocalShellBackend, no skills, no interruptOn — the
// runner is tool-less this packet.
const DENY_ALL_FILESYSTEM: FilesystemPermission[] = [
  { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
];

// Minimal structural view of the compiled DeepAgents graph the runner drives.
interface DeepAgentGraph {
  streamEvents(
    input: { messages: BaseMessage[] },
    options: { version: 'v2' },
  ): AsyncIterable<LangGraphStreamEvent>;
}

interface ModelProfileLike {
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface DeepAgentTurnResult {
  text: string;
  messages: PersistedTurnMessage[];
}

export async function runDeepAgentTurn(input: {
  agentInput: DeepAgentRunnerInput;
  modelId: string;
  priorMessages: PersistedTurnMessage[];
  newSessionId: string;
  emit: (frame: RunnerOutputFrame) => void;
}): Promise<DeepAgentTurnResult> {
  const resolved = buildRunnerModel({
    modelId: input.modelId,
    env: input.agentInput.modelCredentialEnv ?? {},
  });
  const systemPrompt = composeDeepAgentSystemPrompt(input.agentInput);

  const agent = createDeepAgent({
    model: resolved.model,
    backend: new StateBackend(),
    permissions: DENY_ALL_FILESYSTEM,
    ...(systemPrompt ? { systemPrompt } : {}),
  }) as unknown as DeepAgentGraph;

  const turnMessages = buildTurnMessages(input.agentInput, input.priorMessages);
  const profile = readModelProfile(resolved.model);

  const events = agent.streamEvents(
    { messages: turnMessages },
    { version: 'v2' },
  );
  const { text } = await normalizeDeepAgentStream({
    events,
    newSessionId: input.newSessionId,
    modelId: resolved.modelId,
    modelProfile: { maxInputTokens: profile.maxInputTokens },
    emit: input.emit,
  });

  const userText = composeUserTurnText(input.agentInput);
  const messages: PersistedTurnMessage[] = [
    ...input.priorMessages,
    { role: 'human', text: userText },
    { role: 'ai', text },
  ];
  return { text, messages };
}

function buildTurnMessages(
  agentInput: DeepAgentRunnerInput,
  priorMessages: PersistedTurnMessage[],
): BaseMessage[] {
  const messages: BaseMessage[] = priorMessages.map((message) =>
    message.role === 'human'
      ? new HumanMessage(message.text)
      : new AIMessage(message.text),
  );
  const memoryBlock =
    typeof agentInput.memoryContextBlock === 'string'
      ? agentInput.memoryContextBlock.trim()
      : '';
  // Durable memory context is leading untrusted data, not system authority.
  if (memoryBlock) messages.push(new HumanMessage(memoryBlock));
  messages.push(new HumanMessage(agentInput.prompt));
  return messages;
}

function composeUserTurnText(agentInput: DeepAgentRunnerInput): string {
  return agentInput.prompt;
}

function readModelProfile(model: unknown): ModelProfileLike {
  try {
    const profile = (model as { profile?: ModelProfileLike }).profile;
    return profile && typeof profile === 'object' ? profile : {};
  } catch {
    return {};
  }
}
