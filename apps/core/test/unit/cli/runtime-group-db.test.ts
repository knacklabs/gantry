import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openRuntimeGroupDb } from '@core/cli/runtime-group-db.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

const createStorageRuntimeMock = vi.hoisted(() => vi.fn());
const migrateMock = vi.hoisted(() => vi.fn(async () => {}));
const closeMock = vi.hoisted(() => vi.fn(async () => {}));
const groupsStore = vi.hoisted(() => new Map<string, any>());

vi.mock('@core/adapters/storage/postgres/factory.js', () => ({
  createStorageRuntime: createStorageRuntimeMock,
}));

const runtimeHomesToCleanup: string[] = [];

function createRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-runtime-group-db-test-'),
  );
  runtimeHomesToCleanup.push(runtimeHome);
  fs.mkdirSync(path.join(runtimeHome, 'store'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'data'), { recursive: true });
  const settings = loadRuntimeSettings(runtimeHome);
  saveRuntimeSettings(runtimeHome, settings);
  return runtimeHome;
}

function configureMockRuntime(): void {
  createStorageRuntimeMock.mockImplementation(() => ({
    service: {
      migrate: migrateMock,
      close: closeMock,
    },
    ops: {
      getAllConversationRoutes: async () =>
        Object.fromEntries(groupsStore.entries()),
      setConversationRoute: async (jid: string, group: any) => {
        groupsStore.set(jid, group);
      },
      deleteConversationRoute: async (jid: string) => {
        groupsStore.delete(jid);
      },
      deleteSessionsByAgentFolder: async () => {},
    },
  }));
}

beforeEach(() => {
  groupsStore.clear();
  migrateMock.mockClear();
  closeMock.mockClear();
  createStorageRuntimeMock.mockReset();
  configureMockRuntime();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const runtimeHome of runtimeHomesToCleanup.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('runtime-group-db', () => {
  it('persists registered groups through the Postgres repository', async () => {
    const runtimeHome = createRuntimeHome();

    const groupDb = await openRuntimeGroupDb(runtimeHome);
    await groupDb.setConversationRoute('tg:123', {
      name: 'Main',
      folder: 'main',
      trigger: '@gantry',
      added_at: '2026-04-21T00:00:00.000Z',
    });
    await groupDb.close();

    const reopened = await openRuntimeGroupDb(runtimeHome, { migrate: false });
    expect((await reopened.getAllConversationRoutes())['tg:123']?.folder).toBe(
      'main',
    );
    await reopened.close();

    expect(migrateMock).toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
  });

  it('counts groups by JID prefix', async () => {
    const runtimeHome = createRuntimeHome();
    const groupDb = await openRuntimeGroupDb(runtimeHome, { migrate: false });
    await groupDb.setConversationRoute('tg:1', {
      name: 'A',
      folder: 'a',
      trigger: '@a',
      added_at: '2026-04-21T00:00:00.000Z',
    });
    await groupDb.setConversationRoute('sl:C1', {
      name: 'B',
      folder: 'b',
      trigger: '@b',
      added_at: '2026-04-21T00:00:00.000Z',
    });
    expect(await groupDb.countConversationRoutesByJidPrefix('tg:')).toBe(1);
    expect(await groupDb.countConversationRoutesByJidPrefix('sl:%')).toBe(1);
    await groupDb.close();
  });

  it('rejects invalid folders before writing', async () => {
    const runtimeHome = createRuntimeHome();
    const groupDb = await openRuntimeGroupDb(runtimeHome, { migrate: false });
    await expect(
      groupDb.setConversationRoute('tg:999', {
        name: 'Invalid',
        folder: '../escape',
        trigger: '@bad',
        added_at: '2026-04-21T00:00:00.000Z',
      }),
    ).rejects.toThrow(/Invalid workspace folder/);
    await groupDb.close();
  });
});
