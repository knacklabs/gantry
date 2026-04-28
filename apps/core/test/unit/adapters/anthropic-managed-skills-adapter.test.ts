import { describe, expect, it, vi } from 'vitest';

import {
  AnthropicManagedSkillsAdapter,
  toAnthropicSkillParam,
  toAnthropicSkillParams,
} from '@core/adapters/llm/anthropic/managed-skills/anthropic-managed-skills-adapter.js';

async function* page<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

function createClient() {
  const skills = {
    create: vi.fn(async () => ({
      id: 'skill_123',
      display_title: 'Review helper',
      latest_version: '1759178010641129',
      source: 'custom',
      created_at: '2026-04-28T00:00:00.000Z',
      updated_at: '2026-04-28T00:00:00.000Z',
    })),
    retrieve: vi.fn(async () => ({
      id: 'skill_123',
      display_title: 'Review helper',
      latest_version: '1759178010641129',
      source: 'custom',
      created_at: '2026-04-28T00:00:00.000Z',
      updated_at: '2026-04-28T00:00:00.000Z',
    })),
    list: vi.fn(() =>
      page([
        {
          id: 'xlsx',
          display_title: 'Spreadsheets',
          latest_version: 'latest',
          source: 'anthropic',
          created_at: '2026-04-28T00:00:00.000Z',
          updated_at: '2026-04-28T00:00:00.000Z',
        },
      ]),
    ),
    delete: vi.fn(async () => ({ deleted: true })),
    versions: {
      create: vi.fn(async () => ({
        id: 'version_123',
        skill_id: 'skill_123',
        version: '1759178010641129',
        name: 'review-helper',
        description: 'Reviews code',
        directory: 'review-helper',
        created_at: '2026-04-28T00:00:00.000Z',
      })),
      retrieve: vi.fn(async () => ({
        id: 'version_123',
        skill_id: 'skill_123',
        version: '1759178010641129',
        name: 'review-helper',
        description: 'Reviews code',
        directory: 'review-helper',
        created_at: '2026-04-28T00:00:00.000Z',
      })),
      list: vi.fn(() =>
        page([
          {
            id: 'version_123',
            skill_id: 'skill_123',
            version: '1759178010641129',
            name: 'review-helper',
            description: 'Reviews code',
            directory: 'review-helper',
            created_at: '2026-04-28T00:00:00.000Z',
          },
        ]),
      ),
      delete: vi.fn(async () => ({ deleted: true })),
    },
  };

  return {
    beta: { skills },
    skills,
  };
}

describe('AnthropicManagedSkillsAdapter', () => {
  it('wraps native Anthropic skill and version APIs', async () => {
    const client = createClient();
    const adapter = new AnthropicManagedSkillsAdapter(client);

    await expect(
      adapter.createSkill({ file: 'upload' }),
    ).resolves.toMatchObject({
      id: 'skill_123',
      latestVersion: '1759178010641129',
      source: 'custom',
    });
    expect(client.skills.create).toHaveBeenCalledWith({ file: 'upload' });

    await expect(adapter.getSkill('skill_123')).resolves.toMatchObject({
      id: 'skill_123',
      displayTitle: 'Review helper',
    });
    expect(client.skills.retrieve).toHaveBeenCalledWith('skill_123');

    await expect(adapter.listSkills({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({ id: 'xlsx', source: 'anthropic' }),
    ]);
    expect(client.skills.list).toHaveBeenCalledWith({ limit: 20 });

    await expect(
      adapter.createSkillVersion('skill_123', { file: 'upload-v2' }),
    ).resolves.toMatchObject({
      id: 'version_123',
      skillId: 'skill_123',
      version: '1759178010641129',
    });
    expect(client.skills.versions.create).toHaveBeenCalledWith('skill_123', {
      file: 'upload-v2',
    });

    await adapter.getSkillVersion('skill_123', '1759178010641129');
    expect(client.skills.versions.retrieve).toHaveBeenCalledWith(
      '1759178010641129',
      { skill_id: 'skill_123' },
    );

    await adapter.listSkillVersions('skill_123', { limit: 10 });
    expect(client.skills.versions.list).toHaveBeenCalledWith('skill_123', {
      limit: 10,
    });

    await adapter.deleteSkillVersion('skill_123', '1759178010641129');
    expect(client.skills.versions.delete).toHaveBeenCalledWith(
      '1759178010641129',
      { skill_id: 'skill_123' },
    );

    await adapter.createCustomSkillFromAssets({
      displayTitle: 'Review helper',
      assets: [{ path: 'SKILL.md', content: Buffer.from('# Skill') }],
    });
    expect(client.skills.create).toHaveBeenLastCalledWith({
      display_title: 'Review helper',
      files: [expect.any(File)],
    });

    await adapter.createCustomSkillVersionFromAssets({
      skillId: 'skill_123',
      assets: [{ path: 'SKILL.md', content: Buffer.from('# Skill v2') }],
    });
    expect(client.skills.versions.create).toHaveBeenLastCalledWith(
      'skill_123',
      { files: [expect.any(File)] },
    );
  });

  it('converts opaque refs to Anthropic skill params', () => {
    expect(
      toAnthropicSkillParam({
        skillId: 'xlsx',
        type: 'anthropic',
      }),
    ).toEqual({ skill_id: 'xlsx', type: 'anthropic' });

    expect(
      toAnthropicSkillParams([
        {
          skillId: 'skill_123',
          type: 'custom',
          version: '1759178010641129',
        },
      ]),
    ).toEqual([
      {
        skill_id: 'skill_123',
        type: 'custom',
        version: '1759178010641129',
      },
    ]);
  });
});
