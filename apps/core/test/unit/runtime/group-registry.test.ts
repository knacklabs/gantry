import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RegisteredGroup, ThinkingOverride } from '@core/domain/types.js';

// --- Mocks ---

vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

vi.mock('@core/config/index.js', () => ({
  ASSISTANT_NAME: 'Andy',
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@core/platform/group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(),
}));

// Vitest hoists vi.mock calls, so these imports resolve to the mocked versions.
import fs from 'fs';
import { logger } from '@core/infrastructure/logging/logger.js';
import { resolveGroupFolderPath } from '@core/platform/group-folder.js';
import {
  registerGroup,
  setGroupModelOverride,
  setGroupThinkingOverride,
  listAvailableGroups,
} from '@core/runtime/group-registry.js';

type PersistGroupFn = (jid: string, group: RegisteredGroup) => void;

// Typed handles for convenience
const mockFs = vi.mocked(fs);
const mockResolve = vi.mocked(resolveGroupFolderPath);

// Helper to build a minimal RegisteredGroup
function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '!test',
    added_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// registerGroup
// ─────────────────────────────────────────────
describe('registerGroup', () => {
  let groups: Record<string, RegisteredGroup>;
  let persist: ReturnType<typeof vi.fn<PersistGroupFn>>;
  let ensureCredentialBinding: ReturnType<typeof vi.fn<PersistGroupFn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.mkdirSync.mockReset();
    mockFs.existsSync.mockReset();
    mockFs.readFileSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockResolve.mockReset();
    groups = {};
    persist = vi.fn<PersistGroupFn>();
    ensureCredentialBinding = vi.fn<PersistGroupFn>();
    mockResolve.mockReturnValue('/resolved/test-group');
    mockFs.existsSync.mockReturnValue(false);
  });

  it('registers the group and calls persist + ensureCredentialBinding', async () => {
    const group = makeGroup();
    await registerGroup(groups, 'g1@g.us', group, {
      persist,
      ensureCredentialBinding,
    });

    expect(groups['g1@g.us']).toBe(group);
    expect(persist).toHaveBeenCalledWith('g1@g.us', group);
    expect(ensureCredentialBinding).toHaveBeenCalledWith('g1@g.us', group);
    expect(mockFs.mkdirSync).toHaveBeenCalledWith('/resolved/test-group/logs', {
      recursive: true,
    });
    expect(logger.info).toHaveBeenCalledWith(
      { jid: 'g1@g.us', name: 'Test Group', folder: 'test-group' },
      'Group registered',
    );
  });

  it('rejects registration when resolveGroupFolderPath throws', async () => {
    mockResolve.mockImplementation(() => {
      throw new Error('invalid folder');
    });
    const group = makeGroup({ folder: '../../etc' });

    await registerGroup(groups, 'bad@g.us', group, {
      persist,
      ensureCredentialBinding,
    });

    expect(groups).not.toHaveProperty('bad@g.us');
    expect(persist).not.toHaveBeenCalled();
    expect(ensureCredentialBinding).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'bad@g.us', folder: '../../etc' }),
      'Rejecting group registration with invalid folder',
    );
  });

  it('creates default CLAUDE.md when template file does not exist', async () => {
    const group = makeGroup({ isMain: false });
    mockFs.existsSync.mockReturnValueOnce(false).mockReturnValueOnce(false);

    await registerGroup(groups, 'g1@g.us', group, {
      persist,
      ensureCredentialBinding,
    });

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      '/resolved/test-group/CLAUDE.md',
      expect.stringContaining('# Andy'),
    );
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      '/resolved/test-group/CLAUDE.md',
      expect.stringContaining('assistant for this chat'),
    );
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      '/resolved/test-group/CLAUDE.md',
      expect.stringContaining(
        'Use request_skill_install, request_skill_proposal, request_skill_dependency_install, request_mcp_server, or request_permission for capability changes.',
      ),
    );
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      '/resolved/test-group/CLAUDE.md',
      expect.stringContaining(
        'Agents with selected admin capabilities may use service_restart after approved changes and register_agent for conversation binding.',
      ),
    );
  });

  it('uses provided assistant name in default CLAUDE.md', async () => {
    const group = makeGroup({ isMain: true });
    mockFs.existsSync.mockReturnValueOnce(false);

    await registerGroup(groups, 'g1@g.us', group, {
      assistantName: 'Kai',
      persist,
      ensureCredentialBinding,
    });

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      '/resolved/test-group/CLAUDE.md',
      expect.stringContaining('# Kai'),
    );
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      '/resolved/test-group/CLAUDE.md',
      expect.stringContaining('main control chat'),
    );
  });

  it('skips template creation when CLAUDE.md already exists', async () => {
    const group = makeGroup();
    // existsSync for groupMdFile => true (file already exists)
    mockFs.existsSync.mockReturnValue(true);

    await registerGroup(groups, 'g1@g.us', group, {
      persist,
      ensureCredentialBinding,
    });

    expect(mockFs.readFileSync).not.toHaveBeenCalled();
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// setGroupModelOverride
// ─────────────────────────────────────────────
describe('setGroupModelOverride', () => {
  let groups: Record<string, RegisteredGroup>;
  let persist: ReturnType<typeof vi.fn<PersistGroupFn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    groups = {};
    persist = vi.fn<PersistGroupFn>();
  });

  it('does nothing when group does not exist', () => {
    setGroupModelOverride(groups, 'missing@g.us', 'gpt-4', persist);
    expect(persist).not.toHaveBeenCalled();
  });

  it('does nothing when model is unchanged', () => {
    groups['g1@g.us'] = makeGroup({
      agentConfig: { model: 'sonnet' },
    });
    setGroupModelOverride(groups, 'g1@g.us', 'sonnet', persist);
    expect(persist).not.toHaveBeenCalled();
  });

  it('does nothing when both previous and new model are undefined', () => {
    groups['g1@g.us'] = makeGroup();
    setGroupModelOverride(groups, 'g1@g.us', undefined, persist);
    expect(persist).not.toHaveBeenCalled();
  });

  it('sets model on a group with no agentConfig', () => {
    groups['g1@g.us'] = makeGroup();
    setGroupModelOverride(groups, 'g1@g.us', 'haiku', persist);

    expect(groups['g1@g.us'].agentConfig).toEqual({
      model: 'haiku',
    });
    expect(persist).toHaveBeenCalledWith('g1@g.us', groups['g1@g.us']);
  });

  it('overwrites existing model', () => {
    groups['g1@g.us'] = makeGroup({
      agentConfig: { model: 'haiku' },
    });
    setGroupModelOverride(groups, 'g1@g.us', 'opus', persist);

    expect(groups['g1@g.us'].agentConfig?.model).toBe('opus');
    expect(persist).toHaveBeenCalled();
  });

  it('clears model when set to undefined', () => {
    groups['g1@g.us'] = makeGroup({
      agentConfig: { model: 'some-model', thinking: { mode: 'enabled' } },
    });
    setGroupModelOverride(groups, 'g1@g.us', undefined, persist);

    // model removed but thinking stays
    expect(groups['g1@g.us'].agentConfig).toEqual({
      thinking: { mode: 'enabled' },
    });
    expect(persist).toHaveBeenCalled();
  });

  it('sets agentConfig to undefined when last key is removed', () => {
    groups['g1@g.us'] = makeGroup({ agentConfig: { model: 'only-key' } });
    setGroupModelOverride(groups, 'g1@g.us', undefined, persist);

    expect(groups['g1@g.us'].agentConfig).toBeUndefined();
    expect(persist).toHaveBeenCalled();
  });

  it('does not mutate model when async persistence rejects', async () => {
    groups['g1@g.us'] = makeGroup({ agentConfig: { model: 'haiku' } });
    persist = vi.fn<PersistGroupFn>().mockRejectedValue(new Error('db down'));

    await expect(
      setGroupModelOverride(groups, 'g1@g.us', 'sonnet', persist),
    ).rejects.toThrow('db down');

    expect(groups['g1@g.us'].agentConfig?.model).toBe('haiku');
  });

  it('rejects unknown models without clearing the current override', () => {
    groups['g1@g.us'] = makeGroup({ agentConfig: { model: 'haiku' } });

    expect(() =>
      setGroupModelOverride(groups, 'g1@g.us', 'new-model', persist),
    ).toThrow('Unknown model "new-model"');

    expect(groups['g1@g.us'].agentConfig?.model).toBe('haiku');
    expect(persist).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// setGroupThinkingOverride
// ─────────────────────────────────────────────
describe('setGroupThinkingOverride', () => {
  let groups: Record<string, RegisteredGroup>;
  let persist: ReturnType<typeof vi.fn<PersistGroupFn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    groups = {};
    persist = vi.fn<PersistGroupFn>();
  });

  it('does nothing when group does not exist', () => {
    const thinking: ThinkingOverride = { mode: 'enabled' };
    setGroupThinkingOverride(groups, 'missing@g.us', thinking, persist);
    expect(persist).not.toHaveBeenCalled();
  });

  it('does nothing when thinking is unchanged (deep equality)', () => {
    const thinking: ThinkingOverride = { mode: 'adaptive', effort: 'high' };
    groups['g1@g.us'] = makeGroup({
      agentConfig: { thinking: { mode: 'adaptive', effort: 'high' } },
    });

    setGroupThinkingOverride(groups, 'g1@g.us', thinking, persist);
    expect(persist).not.toHaveBeenCalled();
  });

  it('does nothing when both previous and new thinking are undefined', () => {
    groups['g1@g.us'] = makeGroup();
    setGroupThinkingOverride(groups, 'g1@g.us', undefined, persist);
    expect(persist).not.toHaveBeenCalled();
  });

  it('sets thinking on a group with no agentConfig', () => {
    groups['g1@g.us'] = makeGroup();
    const thinking: ThinkingOverride = { mode: 'enabled', budgetTokens: 5000 };

    setGroupThinkingOverride(groups, 'g1@g.us', thinking, persist);

    expect(groups['g1@g.us'].agentConfig).toEqual({ thinking });
    expect(persist).toHaveBeenCalledWith('g1@g.us', groups['g1@g.us']);
  });

  it('overwrites existing thinking', () => {
    groups['g1@g.us'] = makeGroup({
      agentConfig: { thinking: { mode: 'disabled' } },
    });
    const thinking: ThinkingOverride = { mode: 'enabled', effort: 'max' };

    setGroupThinkingOverride(groups, 'g1@g.us', thinking, persist);

    expect(groups['g1@g.us'].agentConfig?.thinking).toEqual(thinking);
    expect(persist).toHaveBeenCalled();
  });

  it('clears thinking when set to undefined', () => {
    groups['g1@g.us'] = makeGroup({
      agentConfig: { model: 'gpt-4', thinking: { mode: 'enabled' } },
    });

    setGroupThinkingOverride(groups, 'g1@g.us', undefined, persist);

    // thinking removed but model stays
    expect(groups['g1@g.us'].agentConfig).toEqual({ model: 'gpt-4' });
    expect(persist).toHaveBeenCalled();
  });

  it('sets agentConfig to undefined when last key is removed', () => {
    groups['g1@g.us'] = makeGroup({
      agentConfig: { thinking: { mode: 'adaptive' } },
    });

    setGroupThinkingOverride(groups, 'g1@g.us', undefined, persist);

    expect(groups['g1@g.us'].agentConfig).toBeUndefined();
    expect(persist).toHaveBeenCalled();
  });

  it('does not mutate thinking when async persistence rejects', async () => {
    groups['g1@g.us'] = makeGroup({
      agentConfig: { thinking: { mode: 'disabled' } },
    });
    persist = vi.fn<PersistGroupFn>().mockRejectedValue(new Error('db down'));

    await expect(
      setGroupThinkingOverride(groups, 'g1@g.us', { mode: 'enabled' }, persist),
    ).rejects.toThrow('db down');

    expect(groups['g1@g.us'].agentConfig?.thinking).toEqual({
      mode: 'disabled',
    });
  });
});

// ─────────────────────────────────────────────
// listAvailableGroups
// ─────────────────────────────────────────────
describe('listAvailableGroups', () => {
  it('returns groups with registration status', () => {
    const chats = [
      {
        jid: 'g1@g.us',
        name: 'Group One',
        last_message_time: '2026-01-01',
        is_group: true,
      },
      {
        jid: 'g2@g.us',
        name: 'Group Two',
        last_message_time: '2026-01-02',
        is_group: 1,
      },
    ];
    const registered: Record<string, RegisteredGroup> = {
      'g1@g.us': makeGroup(),
    };

    const result = listAvailableGroups(chats, registered);

    expect(result).toEqual([
      {
        jid: 'g1@g.us',
        name: 'Group One',
        lastActivity: '2026-01-01',
        isRegistered: true,
      },
      {
        jid: 'g2@g.us',
        name: 'Group Two',
        lastActivity: '2026-01-02',
        isRegistered: false,
      },
    ]);
  });

  it('filters out __group_sync__ sentinel', () => {
    const chats = [
      {
        jid: '__group_sync__',
        name: null,
        last_message_time: '',
        is_group: true,
      },
      { jid: 'g1@g.us', name: 'Real', last_message_time: 't1', is_group: true },
    ];

    const result = listAvailableGroups(chats, {});
    expect(result).toHaveLength(1);
    expect(result[0].jid).toBe('g1@g.us');
  });

  it('filters out non-group chats', () => {
    const chats = [
      {
        jid: 'solo@s.whatsapp.net',
        name: 'Solo',
        last_message_time: 't1',
        is_group: false,
      },
      {
        jid: 'zero@s.whatsapp.net',
        name: 'Zero',
        last_message_time: 't2',
        is_group: 0,
      },
      {
        jid: 'g1@g.us',
        name: 'Group',
        last_message_time: 't3',
        is_group: true,
      },
    ];

    const result = listAvailableGroups(chats, {});
    expect(result).toHaveLength(1);
    expect(result[0].jid).toBe('g1@g.us');
  });

  it('uses jid as name fallback when name is null', () => {
    const chats = [
      { jid: 'g1@g.us', name: null, last_message_time: 't1', is_group: true },
    ];

    const result = listAvailableGroups(chats, {});
    expect(result[0].name).toBe('g1@g.us');
  });

  it('uses jid as name fallback when name is empty string', () => {
    const chats = [
      { jid: 'g1@g.us', name: '', last_message_time: 't1', is_group: true },
    ];

    const result = listAvailableGroups(chats, {});
    expect(result[0].name).toBe('g1@g.us');
  });

  it('returns empty array when no groups match', () => {
    const chats = [
      {
        jid: '__group_sync__',
        name: null,
        last_message_time: '',
        is_group: true,
      },
      {
        jid: 'solo@s.whatsapp.net',
        name: 'Solo',
        last_message_time: 't1',
        is_group: false,
      },
    ];

    const result = listAvailableGroups(chats, {});
    expect(result).toEqual([]);
  });
});
