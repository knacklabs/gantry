import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { materializeClaudeRuntime } from '@core/adapters/llm/anthropic-claude-agent/claude-config-materializer.js';
import {
  ArtifactClaudeSkillSource,
  BundledGantrySkillSource,
  GANTRY_BUNDLED_SKILL_IDS,
  RuntimeInstalledGantryBrowserSkillSource,
  materializeClaudeSkills,
  type SkillSource,
} from '@core/adapters/llm/anthropic-claude-agent/claude-skill-materializer.js';
import type { SkillArtifactStore } from '@core/domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';
import type { SkillCatalogItem } from '@core/domain/skills/skills.js';

function createSkillSource(root: string): SkillSource {
  const enabledDir = path.join(root, 'enabled-skill');
  const disabledDir = path.join(root, 'disabled-skill');
  fs.mkdirSync(enabledDir, { recursive: true });
  fs.mkdirSync(disabledDir, { recursive: true });
  fs.writeFileSync(path.join(enabledDir, 'SKILL.md'), '# Enabled');
  fs.writeFileSync(path.join(disabledDir, 'SKILL.md'), '# Disabled');
  return {
    listSkills: async () => [
      {
        id: 'enabled-skill',
        name: 'enabled-skill',
        sourceDir: enabledDir,
        enabled: true,
      },
      {
        id: 'disabled-skill',
        name: 'disabled-skill',
        sourceDir: disabledDir,
        enabled: false,
      },
    ],
  };
}

describe('Claude config materializer', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-materializer-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates explicit Claude config, settings, and skills without restoring provider SDK files', async () => {
    const materialization = await materializeClaudeRuntime({
      baseTempDir: path.join(tempRoot, 'run'),
      groupDir: path.join(tempRoot, 'agents', 'test'),
      cliEntryPoint: path.join(tempRoot, 'dist', 'cli', 'index.js'),
      packageRoot: tempRoot,
      settings: { model: 'sonnet' },
      skillSource: createSkillSource(tempRoot),
    });

    expect(materialization.claudeConfigDir).toContain(tempRoot);
    expect(
      fs.existsSync(
        path.join(materialization.claudeConfigDir, 'settings.json'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(materialization.skillsDir, 'enabled-skill')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(materialization.skillsDir, 'disabled-skill')),
    ).toBe(false);
    expect(fs.readdirSync(materialization.projectDir)).toEqual([]);

    materialization.cleanup();
    expect(fs.existsSync(materialization.baseTempDir)).toBe(false);
  });

  it('uses a stable default Claude config directory so provider sessions survive restart', async () => {
    const groupDir = path.join(tempRoot, 'agents', 'test');

    const materialization = await materializeClaudeRuntime({
      groupDir,
      cliEntryPoint: path.join(tempRoot, 'dist', 'cli', 'index.js'),
      packageRoot: tempRoot,
      settings: { model: 'sonnet' },
      skillSource: createSkillSource(tempRoot),
    });

    expect(materialization.baseTempDir).toBe(
      path.join(groupDir, '.llm-runtime'),
    );
    expect(materialization.claudeConfigDir).toBe(
      path.join(groupDir, '.llm-runtime', 'claude'),
    );
    const providerSessionFile = path.join(
      materialization.projectDir,
      'provider-session.jsonl',
    );
    fs.writeFileSync(providerSessionFile, '{}\n');

    materialization.cleanup();
    expect(fs.existsSync(providerSessionFile)).toBe(true);

    const nextMaterialization = await materializeClaudeRuntime({
      groupDir,
      cliEntryPoint: path.join(tempRoot, 'dist', 'cli', 'index.js'),
      packageRoot: tempRoot,
      settings: { model: 'sonnet' },
      skillSource: createSkillSource(tempRoot),
    });

    expect(nextMaterialization.projectDir).toBe(materialization.projectDir);
    expect(fs.existsSync(providerSessionFile)).toBe(true);
    nextMaterialization.cleanup();
  });

  it('cleans stale skills when reusing an explicit base dir', async () => {
    const baseTempDir = path.join(tempRoot, 'persistent-run');
    const groupDir = path.join(tempRoot, 'agents', 'test');
    const staleSkillDir = path.join(baseTempDir, 'claude', 'skills', 'stale');
    fs.mkdirSync(staleSkillDir, { recursive: true });
    fs.writeFileSync(path.join(staleSkillDir, 'SKILL.md'), '# Stale');

    const materialization = await materializeClaudeRuntime({
      baseTempDir,
      groupDir,
      cliEntryPoint: path.join(tempRoot, 'dist', 'cli', 'index.js'),
      packageRoot: tempRoot,
      skillSource: createSkillSource(tempRoot),
    });

    expect(fs.existsSync(path.join(materialization.skillsDir, 'stale'))).toBe(
      false,
    );
    expect(
      fs.existsSync(path.join(materialization.skillsDir, 'enabled-skill')),
    ).toBe(true);
  });

  it('materializes only Gantry-owned bundled skills from packageRoot', async () => {
    const skillsRoot = path.join(tempRoot, '.agents', 'skills');
    for (const skillId of [
      ...GANTRY_BUNDLED_SKILL_IDS,
      'external-helper',
      'claude-api',
    ]) {
      const skillDir = path.join(skillsRoot, skillId);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${skillId}`);
    }

    const skillsDir = path.join(tempRoot, 'run', 'claude', 'skills');
    const materialized = await materializeClaudeSkills({
      skillsDir,
      skillSource: new BundledGantrySkillSource(tempRoot),
    });

    expect(materialized.map((skill) => skill.id)).toEqual([
      ...GANTRY_BUNDLED_SKILL_IDS,
    ]);
    for (const skillId of GANTRY_BUNDLED_SKILL_IDS) {
      expect(fs.existsSync(path.join(skillsDir, skillId, 'SKILL.md'))).toBe(
        true,
      );
    }
    expect(fs.existsSync(path.join(skillsDir, 'external-helper'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'claude-api'))).toBe(false);
  });

  it('materializes approved artifact skills and skips invalid artifact paths', async () => {
    const skillsDir = path.join(tempRoot, 'skills');
    await materializeClaudeSkills({
      skillsDir,
      skillSource: {
        listSkills: async () => [
          {
            id: 'approved',
            name: 'approved',
            enabled: true,
            assets: [
              { path: 'SKILL.md', content: Buffer.from('# Approved') },
              { path: 'nested/context.md', content: Buffer.from('context') },
            ],
          },
          {
            id: 'draft',
            name: 'draft',
            enabled: false,
            assets: [{ path: 'SKILL.md', content: Buffer.from('# Draft') }],
          },
          {
            id: 'invalid',
            name: 'invalid',
            enabled: true,
            assets: [{ path: '../SKILL.md', content: Buffer.from('# Bad') }],
          },
        ],
      },
    });

    expect(
      fs.readFileSync(path.join(skillsDir, 'approved', 'SKILL.md'), 'utf-8'),
    ).toBe('# Approved');
    expect(
      fs.readFileSync(
        path.join(skillsDir, 'approved', 'nested', 'context.md'),
        'utf-8',
      ),
    ).toBe('context');
    expect(fs.existsSync(path.join(skillsDir, 'draft'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'invalid'))).toBe(false);
  });

  it('rejects enabled skills that collide with Claude-native skill names', async () => {
    const skillsDir = path.join(tempRoot, 'skills');
    await expect(
      materializeClaudeSkills({
        skillsDir,
        skillSource: {
          listSkills: async () => [
            {
              id: 'skill:commands',
              name: 'commands',
              enabled: true,
              assets: [
                {
                  path: 'SKILL.md',
                  content: Buffer.from('# Legacy Commands'),
                },
              ],
            },
          ],
        },
      }),
    ).rejects.toThrow('Claude-native reserved skill name');
    expect(fs.existsSync(path.join(skillsDir, 'commands'))).toBe(false);
  });

  it('rejects asset skills that declare a Claude-native skill name in SKILL.md', async () => {
    const skillsDir = path.join(tempRoot, 'skills');
    await expect(
      materializeClaudeSkills({
        skillsDir,
        skillSource: {
          listSkills: async () => [
            {
              id: 'skill:linkedin-posting',
              name: 'LinkedIn Posting',
              enabled: true,
              assets: [
                {
                  path: 'SKILL.md',
                  content: Buffer.from(`---
name: commands
description: legacy commands
---

# Legacy Commands`),
                },
              ],
            },
          ],
        },
      }),
    ).rejects.toThrow('declares Claude-native reserved skill name "commands"');
    expect(fs.existsSync(path.join(skillsDir, 'LinkedIn-Posting'))).toBe(false);
  });

  it('rejects source skills whose SKILL.md name differs from the materialized skill name', async () => {
    const skillsDir = path.join(tempRoot, 'skills');
    const sourceDir = path.join(tempRoot, 'source-skill');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'SKILL.md'),
      `---
name: other-skill
description: mismatch
---

# Other Skill`,
    );

    await expect(
      materializeClaudeSkills({
        skillsDir,
        skillSource: {
          listSkills: async () => [
            {
              id: 'skill:linkedin-posting',
              name: 'LinkedIn Posting',
              enabled: true,
              sourceDir,
            },
          ],
        },
      }),
    ).rejects.toThrow(
      'declares SDK skill name "other-skill" but materializes as "LinkedIn-Posting"',
    );
    expect(fs.existsSync(path.join(skillsDir, 'LinkedIn-Posting'))).toBe(false);
  });

  it('materializes the runtime-installed gantry-browser skill into the temp skills dir', async () => {
    const skillsDir = path.join(tempRoot, 'skills');
    const materialized = await materializeClaudeSkills({
      skillsDir,
      skillSource: new RuntimeInstalledGantryBrowserSkillSource(),
    });

    expect(materialized).toHaveLength(1);
    expect(materialized[0]).toMatchObject({
      id: 'gantry-browser',
      sourceType: 'runtime',
      enabled: true,
    });
    const skillText = fs.readFileSync(
      path.join(skillsDir, 'gantry-browser', 'SKILL.md'),
      'utf-8',
    );
    expect(skillText).toContain(
      'browser_status`, `browser_open`, `browser_inspect`, `browser_act`, and `browser_close',
    );
    expect(skillText).toContain('Search first when the destination is unknown');
    expect(skillText).toContain('Inspect before acting');
    expect(skillText).toContain('Use basic inspection by default');
    expect(skillText).toContain(
      'Close the browser with `browser_close` after scheduled jobs',
    );
    expect(skillText).toContain('Do not install browser skills');
    expect(fs.existsSync(path.join(tempRoot, '.agents', 'skills'))).toBe(false);
  });

  it('materializes artifact skills under their sanitized skill name', async () => {
    const skillsDir = path.join(tempRoot, 'skills');
    const materialized = await materializeClaudeSkills({
      skillsDir,
      skillSource: {
        listSkills: async () => [
          {
            id: 'skill:uploaded:1',
            name: 'LinkedIn Posting',
            enabled: true,
            assets: [{ path: 'SKILL.md', content: Buffer.from('# Uploaded') }],
          },
        ],
      },
    });

    expect(materialized[0]).toMatchObject({
      id: 'skill:uploaded:1',
      name: 'LinkedIn Posting',
      materializedName: 'LinkedIn-Posting',
    });
    expect(
      fs.readFileSync(
        path.join(skillsDir, 'LinkedIn-Posting', 'SKILL.md'),
        'utf-8',
      ),
    ).toBe('# Uploaded');
  });

  it('fails safely when enabled skills collide by sanitized name', async () => {
    const skillsDir = path.join(tempRoot, 'skills');
    await expect(
      materializeClaudeSkills({
        skillsDir,
        skillSource: {
          listSkills: async () => [
            {
              id: 'shared-name',
              name: 'shared-name',
              enabled: true,
              sourceDir: (() => {
                const sourceDir = path.join(tempRoot, 'shared-name-source');
                fs.mkdirSync(sourceDir, { recursive: true });
                fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Bundled');
                return sourceDir;
              })(),
            },
            {
              id: 'skill:uploaded:1',
              name: 'shared-name',
              enabled: true,
              assets: [
                { path: 'SKILL.md', content: Buffer.from('# Uploaded') },
              ],
            },
          ],
        },
      }),
    ).rejects.toThrow('Duplicate materialized skill directory shared-name');

    expect(
      fs.readFileSync(path.join(skillsDir, 'shared-name', 'SKILL.md'), 'utf-8'),
    ).toBe('# Bundled');
    expect(fs.existsSync(path.join(skillsDir, 'skill-uploaded-1'))).toBe(false);
  });

  it('fails safely when enabled skills collide by case-folded directory name', async () => {
    const skillsDir = path.join(tempRoot, 'skills');
    await expect(
      materializeClaudeSkills({
        skillsDir,
        skillSource: {
          listSkills: async () => [
            {
              id: 'skill:uploaded:1',
              name: 'Shared Name',
              enabled: true,
              assets: [
                { path: 'SKILL.md', content: Buffer.from('# Uploaded One') },
              ],
            },
            {
              id: 'skill:uploaded:2',
              name: 'shared name',
              enabled: true,
              assets: [
                { path: 'SKILL.md', content: Buffer.from('# Uploaded Two') },
              ],
            },
          ],
        },
      }),
    ).rejects.toThrow('Duplicate materialized skill directory shared-name');
  });

  it('forwards enabled skill filters to artifact sources', async () => {
    const enabledSkill = {
      id: 'skill:enabled',
      appId: 'default',
      agentId: 'agent:test',
      name: 'Enabled Uploaded',
      source: 'admin_uploaded',
      status: 'installed',
      promptRefs: [],
      toolIds: [],
      workflowRefs: [],
      storage: {
        storageType: 'local-filesystem',
        storageRef: 'skill-enabled',
        contentHash: 'sha256:enabled',
        sizeBytes: 1,
      },
      createdAt: '2026-04-28T00:00:00.000Z',
      updatedAt: '2026-04-28T00:00:00.000Z',
    } satisfies SkillCatalogItem;
    const skippedSkill = {
      ...enabledSkill,
      id: 'skill:skipped',
      name: 'Skipped Uploaded',
      storage: {
        ...enabledSkill.storage,
        storageRef: 'skill-skipped',
        contentHash: 'sha256:skipped',
      },
    } satisfies SkillCatalogItem;
    const repo = {
      listEnabledSkillsForAgent: async () => [enabledSkill, skippedSkill],
    } as Partial<SkillCatalogRepository> as SkillCatalogRepository;
    const artifactRefs: string[] = [];
    const artifacts = {
      getSkillArtifact: async (storageRef: string) => {
        artifactRefs.push(storageRef);
        return {
          assets: [{ path: 'SKILL.md', content: Buffer.from('# Skill') }],
        };
      },
    } as Partial<SkillArtifactStore> as SkillArtifactStore;

    const source = new ArtifactClaudeSkillSource(repo, artifacts, {
      appId: 'default' as never,
      agentId: 'agent:test' as never,
    });

    await expect(
      source.listSkills({ enabledSkillIds: ['skill:enabled'] }),
    ).resolves.toMatchObject([{ id: 'skill:enabled' }]);
    expect(artifactRefs).toEqual(['skill-enabled']);
  });

  it('ignores durable settings.local.json and excludes raw secrets from generated settings', async () => {
    fs.mkdirSync(path.join(tempRoot, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, '.claude', 'settings.local.json'),
      '{"env":{"ANTHROPIC_API_KEY":"secret"}}',
    );

    const materialization = await materializeClaudeRuntime({
      baseTempDir: path.join(tempRoot, 'run'),
      groupDir: path.join(tempRoot, 'agents', 'test'),
      cliEntryPoint: path.join(tempRoot, 'dist', 'cli', 'index.js'),
      packageRoot: tempRoot,
      settings: { model: 'opus' },
      skillSource: createSkillSource(tempRoot),
    });

    const settingsText = fs.readFileSync(
      path.join(materialization.claudeConfigDir, 'settings.json'),
      'utf-8',
    );
    expect(settingsText).toContain('"model": "opus"');
    expect(settingsText).toContain('"hooks": {}');
    expect(settingsText).not.toContain('memory-hook load');
    expect(settingsText).not.toContain('memory-hook extract');
    expect(settingsText).not.toContain('ANTHROPIC_API_KEY');
    expect(settingsText).not.toContain('secret');
  });

  it('fails before writing settings when provider options contain raw secrets', async () => {
    await expect(
      materializeClaudeRuntime({
        baseTempDir: path.join(tempRoot, 'run'),
        groupDir: path.join(tempRoot, 'agents', 'test'),
        cliEntryPoint: path.join(tempRoot, 'dist', 'cli', 'index.js'),
        packageRoot: tempRoot,
        settings: {
          providerOptions: {
            ANTHROPIC_API_KEY: 'secret',
          },
        },
        skillSource: createSkillSource(tempRoot),
      }),
    ).rejects.toThrow('raw secret');
    expect(
      fs.existsSync(path.join(tempRoot, 'run', 'claude', 'settings.json')),
    ).toBe(false);
  });

  it('skips invalid skill folders and symlinked skill content', async () => {
    const validDir = path.join(tempRoot, 'valid-skill');
    const invalidDir = path.join(tempRoot, 'invalid-skill');
    const outsideDir = path.join(tempRoot, 'outside');
    fs.mkdirSync(validDir, { recursive: true });
    fs.mkdirSync(invalidDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(validDir, 'SKILL.md'), '# Valid');
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');
    fs.symlinkSync(
      path.join(outsideDir, 'secret.txt'),
      path.join(validDir, 'secret-link.txt'),
    );

    const skillsDir = path.join(tempRoot, 'run', 'claude', 'skills');
    const materialized = await materializeClaudeSkills({
      skillsDir,
      skillSource: {
        listSkills: async () => [
          {
            id: 'valid-skill',
            name: 'valid-skill',
            sourceDir: validDir,
            enabled: true,
          },
          {
            id: 'invalid-skill',
            name: 'invalid-skill',
            sourceDir: invalidDir,
            enabled: true,
          },
        ],
      },
    });

    expect(materialized.map((skill) => skill.id)).toEqual(['valid-skill']);
    expect(fs.existsSync(path.join(skillsDir, 'valid-skill', 'SKILL.md'))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(skillsDir, 'valid-skill', 'secret-link.txt')),
    ).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'invalid-skill'))).toBe(false);
  });
});
