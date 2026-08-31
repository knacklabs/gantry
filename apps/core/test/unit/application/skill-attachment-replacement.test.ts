import { expect, it, vi } from 'vitest';

import { SkillService } from '@core/application/skills/skill-service.js';
import type { SkillArtifactStore } from '@core/domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';

it('replaces skill agent bindings atomically', async () => {
  const replacement = vi.fn().mockResolvedValue([
    {
      id: 'agent-skill-binding:agent:one:skill:one',
      appId: 'app:one',
      agentId: 'agent:one',
      skillId: 'skill:one',
      status: 'active',
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    },
  ]);
  const saveOne = vi.fn();
  const disableOne = vi.fn();
  const service = new SkillService(
    {
      replaceSkillAgentBindings: replacement,
      saveAgentSkillBinding: saveOne,
      disableAgentSkillBinding: disableOne,
    } as unknown as SkillCatalogRepository,
    {} as SkillArtifactStore,
  );

  await expect(
    service.replaceSkillAgentBindings({
      appId: 'app:one' as never,
      skillId: 'skill:one' as never,
      agentIds: ['agent:one' as never],
      now: '2026-08-31T00:00:00.000Z',
    }),
  ).resolves.toEqual([
    expect.objectContaining({ agentId: 'agent:one', status: 'active' }),
  ]);
  expect(replacement).toHaveBeenCalledOnce();
  expect(replacement).toHaveBeenCalledWith({
    appId: 'app:one',
    skillId: 'skill:one',
    agentIds: ['agent:one'],
    updatedAt: '2026-08-31T00:00:00.000Z',
  });
  expect(saveOne).not.toHaveBeenCalled();
  expect(disableOne).not.toHaveBeenCalled();

  expect(() =>
    service.replaceSkillAgentBindings({
      appId: 'app:one' as never,
      skillId: 'skill:one' as never,
      agentIds: ['agent:one' as never, 'agent:one' as never],
    }),
  ).toThrow('distinct');
  expect(() =>
    service.replaceSkillAgentBindings({
      appId: 'app:one' as never,
      skillId: 'skill:one' as never,
      agentIds: Array.from(
        { length: 101 },
        (_, index) => `agent:${index}` as never,
      ),
    }),
  ).toThrow('at most 100');
  expect(replacement).toHaveBeenCalledTimes(1);
});
