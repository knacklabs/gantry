import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { createHermeticRuntimeHarness } from '../harness/runtime-harness.js';

const activeHarnesses: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const harness of activeHarnesses.splice(0)) {
    harness.cleanup();
  }
});

function registerMainAndTeam(
  harness: Awaited<ReturnType<typeof createHermeticRuntimeHarness>>,
) {
  harness.registerGroup({
    jid: 'tg:main',
    name: 'Main',
    folder: 'main',
    trigger: 'Andy',
    isMain: true,
    requiresTrigger: false,
  });
  harness.registerGroup({
    jid: 'tg:team',
    name: 'Team',
    folder: 'team',
    trigger: 'Bot',
    requiresTrigger: true,
  });
}

describe('runtime memory integration', () => {
  it('routes memory IPC through the watcher and keeps non-main writes scoped to the source group', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeMemoryRequest('team', {
      requestId: 'mem-save-001',
      action: 'memory_save',
      payload: {
        scope: 'group',
        group_folder: 'main',
        kind: 'decision',
        key: 'decision:test-memory-scope',
        value: 'Team memory stays scoped to the team group.',
        confidence: 0.9,
      },
    });

    await harness.waitFor(() =>
      Boolean(
        harness.readIpcJson('team', 'memory-responses', 'mem-save-001.json'),
      ),
    );
    const saveResponse = harness.readIpcJson<{
      ok: boolean;
      data?: { memory?: { group_folder?: string; key?: string } };
    }>('team', 'memory-responses', 'mem-save-001.json');
    expect(saveResponse?.ok).toBe(true);
    expect(saveResponse?.data?.memory).toEqual(
      expect.objectContaining({
        group_folder: 'team',
        key: 'decision:test-memory-scope',
      }),
    );

    harness.writeMemoryRequest('team', {
      requestId: 'mem-search-001',
      action: 'memory_search',
      payload: {
        query: 'team memory scope decision',
      },
    });
    await harness.waitFor(() =>
      Boolean(
        harness.readIpcJson('team', 'memory-responses', 'mem-search-001.json'),
      ),
    );
    const searchResponse = harness.readIpcJson<{
      ok: boolean;
      data?: { results?: Array<{ text?: string; group_folder?: string }> };
    }>('team', 'memory-responses', 'mem-search-001.json');
    expect(searchResponse?.ok).toBe(true);
    expect(searchResponse?.data?.results?.[0]).toEqual(
      expect.objectContaining({
        group_folder: 'team',
      }),
    );
    expect(searchResponse?.data?.results?.[0]?.text).toContain('Team memory');
  });

  it('rejects non-main global memory writes through real IPC responses', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeMemoryRequest('team', {
      requestId: 'mem-global-denied',
      action: 'memory_save',
      payload: {
        scope: 'global',
        key: 'global-denied',
        value: 'Non-main groups cannot write this globally.',
      },
    });

    await harness.waitFor(() =>
      Boolean(
        harness.readIpcJson(
          'team',
          'memory-responses',
          'mem-global-denied.json',
        ),
      ),
    );
    const response = harness.readIpcJson<{ ok: boolean; error?: string }>(
      'team',
      'memory-responses',
      'mem-global-denied.json',
    );
    expect(response?.ok).toBe(false);
    expect(response?.error).toContain('global memory writes');
  });

  it('keeps user-scoped memory isolated between senders in one group while sharing group facts', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeMemoryRequest('team', {
      requestId: 'mem-user-a',
      action: 'memory_save',
      payload: {
        scope: 'user',
        user_id: 'sender-a',
        kind: 'preference',
        key: 'pref:snack',
        value: 'Sender A likes cardamom tea.',
      },
    });
    harness.writeMemoryRequest('team', {
      requestId: 'mem-user-b',
      action: 'memory_save',
      payload: {
        scope: 'user',
        user_id: 'sender-b',
        kind: 'preference',
        key: 'pref:snack',
        value: 'Sender B likes black coffee.',
      },
    });
    harness.writeMemoryRequest('team', {
      requestId: 'mem-group-shared',
      action: 'memory_save',
      payload: {
        scope: 'group',
        kind: 'fact',
        key: 'fact:standup',
        value: 'The team standup happens at 10:00.',
      },
    });

    await harness.waitFor(() =>
      Boolean(
        harness.readIpcJson(
          'team',
          'memory-responses',
          'mem-group-shared.json',
        ),
      ),
    );

    harness.writeMemoryRequest('team', {
      requestId: 'mem-search-user-a',
      action: 'memory_search',
      payload: {
        query: 'likes standup',
        user_id: 'sender-a',
        limit: 10,
      },
    });
    await harness.waitFor(() =>
      Boolean(
        harness.readIpcJson(
          'team',
          'memory-responses',
          'mem-search-user-a.json',
        ),
      ),
    );

    const response = harness.readIpcJson<{
      ok: boolean;
      data?: { results?: Array<{ text?: string; user_id?: string | null }> };
    }>('team', 'memory-responses', 'mem-search-user-a.json');
    const texts = (response?.data?.results ?? []).map((item) => item.text);
    expect(texts.some((text) => text?.includes('cardamom tea'))).toBe(true);
    expect(texts.some((text) => text?.includes('team standup'))).toBe(true);
    expect(texts.some((text) => text?.includes('black coffee'))).toBe(false);
  });

  it('writes memory markdown under configured memory.root and not agent-scoped memory folders', async () => {
    const harness = await createHermeticRuntimeHarness({
      configureSettings: (settings) => {
        settings.memory.root = 'memory';
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeMemoryRequest('team', {
      requestId: 'mem-root-save',
      action: 'memory_save',
      payload: {
        scope: 'group',
        kind: 'decision',
        key: 'decision:memory-root',
        value: 'Memory writes must land under configured memory.root.',
      },
    });

    await harness.waitFor(() =>
      Boolean(
        harness.readIpcJson('team', 'memory-responses', 'mem-root-save.json'),
      ),
    );

    const memoryRoot = path.join(harness.runtimeHome, 'memory');
    const agentScopedMemoryRoot = path.join(
      harness.runtimeHome,
      'agents',
      'team',
      'memory',
    );
    const memoryFiles = fs
      .readdirSync(memoryRoot, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith('.md'));

    expect(memoryFiles.length).toBeGreaterThan(0);
    expect(fs.existsSync(agentScopedMemoryRoot)).toBe(false);
  });
});
