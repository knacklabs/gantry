import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'GANTRY_IPC_DIR',
  'GANTRY_WORKSPACE_KEY',
  'GANTRY_CHAT_JID',
  'GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON',
] as const;

const previousEnv = new Map<string, string | undefined>();

beforeEach(() => {
  vi.resetModules();
  for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);
  process.env.GANTRY_IPC_DIR = '/tmp/gantry-task-tool-test';
  process.env.GANTRY_WORKSPACE_KEY = 'test-agent';
  process.env.GANTRY_CHAT_JID = 'sl:C123';
  process.env.GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON = JSON.stringify([
    'AgentDelegation',
  ]);
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@core/runner/mcp/ipc.js');
  for (const key of ENV_KEYS) {
    const value = previousEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv.clear();
});

describe('mcp__gantry task lifecycle tools', () => {
  it('reports delegate_task unavailable until an executor exists', async () => {
    const writeIpcFile = vi.fn();
    const waitForTaskResponse = vi.fn();
    vi.doMock('@core/runner/mcp/ipc.js', () => ({
      writeIpcFile,
      waitForTaskResponse,
    }));
    const { registerTaskLifecycleTools } =
      await import('@core/runner/mcp/tools/task-lifecycle.js');
    const tools = new Map<
      string,
      (
        args: Record<string, unknown>,
      ) => Promise<{ content: { text: string }[]; isError?: boolean }>
    >();

    registerTaskLifecycleTools({
      tool: (
        name: string,
        _description: string,
        _schema: unknown,
        handler: never,
      ) => {
        tools.set(name, handler);
      },
    } as never);

    const response = await tools.get('delegate_task')!({
      title: 'Research',
      task: 'Find the source',
      expectedOutput: 'One sentence',
    });

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain(
      'Agent delegation is unavailable',
    );
    expect(writeIpcFile).not.toHaveBeenCalled();
    expect(waitForTaskResponse).not.toHaveBeenCalled();
  });
});
