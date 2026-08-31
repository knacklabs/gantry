import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_APP_ID,
  DEFAULT_SKILL_CATALOG,
} from '@core/adapters/storage/postgres/seeds.js';
import { SkillService } from '@core/application/skills/skill-service.js';
import { browserSkillResponse } from '@core/control/server/routes/browser-skills.mapper.js';
import type { AgentId } from '@core/domain/agent/agent.js';
import type { AppId } from '@core/domain/app/app.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const appId = DEFAULT_APP_ID as AppId;
const now = '2026-08-31T00:00:00.000Z';

maybeDescribe('Skills browser facade with Postgres', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'skills_browser_facade',
    });
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.cleanup();
  });

  it('updates inventory without attaching and rolls back failed attachment replacement', async () => {
    const activeAgentId = 'agent:skills-browser-active' as AgentId;
    const disabledAgentId = 'agent:skills-browser-disabled' as AgentId;
    const rejectedAgentId = 'agent:skills-browser-rejected' as AgentId;
    for (const [id, status] of [
      [activeAgentId, 'active'],
      [disabledAgentId, 'disabled'],
      [rejectedAgentId, 'active'],
    ] as const) {
      await runtime.repositories.agents.saveAgent({
        id,
        appId,
        name: id,
        status,
        createdAt: now,
        updatedAt: now,
      });
    }
    const service = new SkillService(
      runtime.repositories.skills,
      runtime.storageRuntime.skillArtifacts,
    );
    const first = await service.installSkill({
      appId,
      assets: [
        {
          path: 'SKILL.md',
          content: Buffer.from(
            '---\nname: Browser Skill\nrequired_env_vars: PRIVATE_ACCESS_TOKEN\n---\n# One',
          ),
        },
      ],
      now,
    });
    const updated = await service.installSkill({
      appId,
      assets: [
        {
          path: 'SKILL.md',
          content: Buffer.from(
            '---\nname: Browser Skill\nrequired_env_vars: PRIVATE_ACCESS_TOKEN\n---\n# Two',
          ),
        },
      ],
      now: '2026-08-31T00:01:00.000Z',
    });
    expect(updated.id).toBe(first.id);
    await expect(
      runtime.repositories.skills.listAgentSkillBindingsForAgents({
        appId,
        agentIds: [activeAgentId, disabledAgentId, rejectedAgentId],
      }),
    ).resolves.toEqual([]);

    await runtime.repositories.skills.saveAgentSkillBinding({
      id: `agent-skill-binding:${activeAgentId}:${updated.id}` as never,
      appId,
      agentId: activeAgentId,
      skillId: updated.id,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.service.pool.query(
      `ALTER TABLE agent_skill_bindings ADD CONSTRAINT skills_browser_reject_agent CHECK (agent_id <> '${rejectedAgentId}' OR status <> 'active')`,
    );

    await expect(
      service.replaceSkillAgentBindings({
        appId,
        skillId: updated.id,
        agentIds: [disabledAgentId, rejectedAgentId],
        now: '2026-08-31T00:02:00.000Z',
      }),
    ).rejects.toThrow();
    await expect(
      runtime.repositories.skills.listAgentSkillBindingsForAgents({
        appId,
        agentIds: [activeAgentId, disabledAgentId, rejectedAgentId],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        agentId: activeAgentId,
        status: 'active',
      }),
    ]);

    await runtime.service.pool.query(
      'ALTER TABLE agent_skill_bindings DROP CONSTRAINT skills_browser_reject_agent',
    );
    const bindings = await service.replaceSkillAgentBindings({
      appId,
      skillId: updated.id,
      agentIds: [activeAgentId, disabledAgentId],
      now: '2026-08-31T00:03:00.000Z',
    });
    expect(bindings).toEqual([
      expect.objectContaining({ agentId: activeAgentId, status: 'active' }),
      expect.objectContaining({ agentId: disabledAgentId, status: 'active' }),
    ]);
    await expect(
      runtime.repositories.agents.getAgent(disabledAgentId),
    ).resolves.toMatchObject({ status: 'disabled' });
    await expect(
      runtime.repositories.skills.summarizeNavigation?.(appId),
    ).resolves.toEqual({ installed: DEFAULT_SKILL_CATALOG.length + 1 });

    const agents = await runtime.repositories.agents.listAgents(appId);
    const browserJson = JSON.stringify(
      browserSkillResponse(updated, agents, bindings),
    );
    expect(browserJson).not.toMatch(
      /storageRef|contentHash|PRIVATE_ACCESS_TOKEN|createdBy/,
    );
  });
});
