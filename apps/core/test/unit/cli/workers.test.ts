import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const noteCalls = vi.hoisted(
  () => [] as Array<{ message: string; title?: string }>,
);

vi.mock('@clack/prompts', () => ({
  note: (message: string, title?: string) => {
    noteCalls.push({ message, title });
  },
}));

const workersMock = vi.hoisted(() => ({ listWorkers: vi.fn() }));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  initializeRuntimeStorage: vi.fn(async () => undefined),
  closeRuntimeStorage: vi.fn(async () => undefined),
  getRuntimeStorage: () => ({
    repositories: { workerCoordination: workersMock },
  }),
}));

import { runWorkersCommand } from '@core/cli/workers.js';

beforeEach(() => {
  noteCalls.length = 0;
  workersMock.listWorkers.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe('gantry workers list', () => {
  it('renders the process_role column for each worker', async () => {
    workersMock.listWorkers.mockResolvedValue([
      {
        id: 'worker-host-1',
        processRole: 'live-worker',
        status: 'healthy',
        heartbeatAt: new Date().toISOString(),
        capabilities: ['Browser'],
      },
      {
        id: 'worker-host-2',
        processRole: 'job-worker',
        status: 'healthy',
        heartbeatAt: new Date().toISOString(),
        capabilities: [],
      },
    ]);

    const code = await runWorkersCommand(['list']);
    expect(code).toBe(0);
    const note = noteCalls.at(-1)?.message ?? '';
    expect(note).toContain('worker-host-1  role=live-worker  status=healthy');
    expect(note).toContain('worker-host-2  role=job-worker  status=healthy');
  });

  it('reports when no workers are registered', async () => {
    workersMock.listWorkers.mockResolvedValue([]);
    const code = await runWorkersCommand(['list']);
    expect(code).toBe(0);
    expect(noteCalls.at(-1)?.message).toContain(
      'No worker instances registered',
    );
  });
});
