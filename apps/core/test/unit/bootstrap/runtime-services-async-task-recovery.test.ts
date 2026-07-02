import { describe, expect, it, vi } from 'vitest';

vi.mock('@core/jobs/async-mcp-tool-task.js', () => ({
  recoverQueuedAsyncMcpTasks: vi.fn(async () => 1),
}));

import { recoverStaleAsyncCommandTasks } from '@core/app/bootstrap/runtime-services-async-task-recovery.js';
import { recoverQueuedAsyncMcpTasks } from '@core/jobs/async-mcp-tool-task.js';

describe('recoverStaleAsyncCommandTasks', () => {
  it('recovers queued MCP tasks when command sandbox recovery is unavailable', async () => {
    const repository = {
      listTasks: vi.fn(async () => []),
    };
    const warn = vi.fn();

    await recoverStaleAsyncCommandTasks('default', {
      getAsyncTaskRepository: () => repository as never,
      runnerSandboxProvider: { enforcing: false } as never,
      logger: { warn },
    });

    expect(recoverQueuedAsyncMcpTasks).toHaveBeenCalledWith({
      repository,
      appId: 'default',
      createProxy: expect.any(Function),
    });
    expect(warn).toHaveBeenCalledWith(
      { queuedMcp: 1 },
      'Recovered queued async MCP tasks',
    );
  });
});
