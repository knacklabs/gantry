import { processMemoryRequest } from '../../memory/memory-ipc.js';

interface MemoryResultDeps {
  context: {
    appId?: string;
    agentId?: string;
    conversationId: string;
    threadId?: string;
    memoryUserId?: string;
    memoryDefaultScope?: 'user' | 'group';
    sourceAgentFolder: string;
  };
  formatMemorySearchResponse(response: unknown): string;
  formatMemoryWriteResponse(
    action: 'memory_search' | 'memory_save',
    response: unknown,
  ): string;
}

interface MemoryResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  error?: { category: 'transient'; isRetryable: boolean; message: string };
}

export async function memoryResult(
  action: 'memory_search' | 'memory_save',
  payload: Record<string, unknown>,
  deps: MemoryResultDeps,
  id: (prefix: string) => string,
): Promise<MemoryResult> {
  const appId = deps.context.appId?.trim();
  const agentId = deps.context.agentId?.trim();
  if (!appId || !agentId) {
    return errorResult(
      'Memory access requires a trusted app and agent identity.',
    );
  }
  const response = await processMemoryRequest(
    {
      requestId: id('memory'),
      action,
      payload,
      allowedActions: ['memory_search', 'memory_save'],
      context: {
        appId,
        agentId,
        chatJid: deps.context.conversationId,
        threadId: deps.context.threadId,
        personId: deps.context.memoryUserId,
        defaultScope: deps.context.memoryDefaultScope ?? 'group',
      },
    },
    deps.context.sourceAgentFolder,
  );
  if (!response.ok) {
    return errorResult(
      `${action === 'memory_search' ? 'Memory search' : 'Memory save'} failed: ${response.error || 'unknown error'}`,
    );
  }
  return textResult(
    action === 'memory_search'
      ? deps.formatMemorySearchResponse(response)
      : deps.formatMemoryWriteResponse(action, response),
  );
}

function textResult(text: string): MemoryResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): MemoryResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
    error: { category: 'transient', isRetryable: true, message: text },
  };
}
