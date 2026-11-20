import { beforeEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  reject: vi.fn(),
  request: vi.fn(),
  scope: vi.fn(),
}));
vi.mock('@core/jobs/ipc-shared.js', () => ({
  createTaskResponder: () => ({
    acceptData: mocks.accept,
    reject: mocks.reject,
  }),
  toTrimmedString: (v: unknown) =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined,
}));
vi.mock('@core/jobs/ipc-agent-task-lifecycle-handlers.js', () => ({
  taskScope: mocks.scope,
}));
vi.mock(
  '@core/application/interactions/caller-resolved-tool-coordinator.js',
  () => ({
    requestCallerResolvedTool: mocks.request,
    updateCallerResolvedTool: vi.fn(),
  }),
);
import { callerResolvedToolTaskHandler } from '@core/jobs/ipc-caller-resolved-tool-handler.js';

describe('native discussion budget exhaustion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.request.mockResolvedValue({ status: 'ok', evidence: [] });
  });
  it.each([true, false])(
    'keeps actual tool work bounded and native failure nonfatal (native=%s)',
    async (native) => {
      const config = {
        sessionId: 's',
        tools: [
          {
            name: 'search_tender_evidence',
            inputSchema: { type: 'object', additionalProperties: false },
          },
        ],
        maxInteractions: 4,
        interactionTimeoutMs: 1000,
        ...(native ? { exhaustionBehavior: 'return_result' } : {}),
      };
      mocks.scope.mockReturnValue({
        appId: 'app',
        agentId: 'agent',
        conversationId: 'chat',
        sandboxPolicy: { callerResolvedTools: config },
      });
      const runId = 'run-' + String(native);
      for (let i = 0; i < 5; i++)
        await callerResolvedToolTaskHandler({
          sourceAgentFolder: 'agent',
          data: {
            runId,
            payload: { toolName: 'search_tender_evidence', toolInput: {} },
          },
          deps: {},
        } as never);
      expect(mocks.request).toHaveBeenCalledTimes(4);
      if (native) {
        expect(mocks.reject).not.toHaveBeenCalled();
        expect(mocks.accept).toHaveBeenLastCalledWith(
          expect.any(String),
          expect.objectContaining({
            status: 'tool_budget_exhausted',
            remainingInteractions: 0,
          }),
        );
      } else
        expect(mocks.reject).toHaveBeenCalledWith(
          'Caller-resolved tool budget exhausted.',
          'tool_budget_exhausted',
        );
    },
  );
});
