import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsPromisesMock = vi.hoisted(() => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue({ code: 'ENOENT' }),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs', () => ({
  default: {
    promises: fsPromisesMock,
  },
}));

vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto');
  return {
    ...actual,
    randomUUID: vi.fn(() => 'snapshot-uuid'),
  };
});

vi.mock('@core/platform/workspace-folder.js', () => ({
  resolveWorkspaceIpcPath: vi.fn((folder: string) => `/mock/ipc/${folder}`),
}));

import fs from 'fs';
import { resolveWorkspaceIpcPath } from '@core/platform/workspace-folder.js';
import {
  clearSnapshotWriteCacheForTests,
  writeGroupsSnapshot,
} from '@core/runtime/agent-spawn-snapshots.js';
import type { AvailableGroup } from '@core/runtime/agent-spawn-types.js';

function makeGroup(overrides: Partial<AvailableGroup> = {}): AvailableGroup {
  return {
    jid: 'jid-1',
    name: 'Group Alpha',
    lastActivity: '2026-01-01T00:00:00Z',
    isRegistered: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSnapshotWriteCacheForTests();
  fsPromisesMock.readFile.mockRejectedValue({ code: 'ENOENT' });
});

describe('writeGroupsSnapshot', () => {
  it('creates the IPC directory', async () => {
    await writeGroupsSnapshot('group-a', [], new Set());

    expect(resolveWorkspaceIpcPath).toHaveBeenCalledWith('group-a');
    expect(fs.promises.mkdir).toHaveBeenCalledWith('/mock/ipc/group-a', {
      recursive: true,
    });
  });

  it('writes all groups for every conversation', async () => {
    const groups = [
      makeGroup({ jid: 'jid-1', name: 'Alpha' }),
      makeGroup({ jid: 'jid-2', name: 'Beta' }),
    ];

    await writeGroupsSnapshot('group-a', groups, new Set(['jid-1']));

    const written = JSON.parse(
      (fs.promises.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1],
    );
    expect(written.groups).toEqual(groups);
    expect(written.lastSync).toBeDefined();
    expect(typeof written.lastSync).toBe('string');
  });

  it('always includes a lastSync ISO timestamp', async () => {
    const before = new Date().toISOString();

    await writeGroupsSnapshot('group-a', [], new Set());

    const written = JSON.parse(
      (fs.promises.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1],
    );
    const after = new Date().toISOString();

    expect(written.lastSync).toBeDefined();
    expect(written.lastSync >= before).toBe(true);
    expect(written.lastSync <= after).toBe(true);
  });

  it('writes to the correct file path', async () => {
    await writeGroupsSnapshot('group-a', [], new Set());

    expect(fs.promises.rename).toHaveBeenCalledWith(
      expect.stringContaining('/mock/ipc/group-a/.available_groups.json.'),
      '/mock/ipc/group-a/available_groups.json',
    );
  });
});
