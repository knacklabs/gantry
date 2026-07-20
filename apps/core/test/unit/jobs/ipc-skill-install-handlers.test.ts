import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { SkillArtifactStore } from '@core/domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';
import type {
  AgentSkillBinding,
  SkillCatalogItem,
  SkillId,
} from '@core/domain/skills/skills.js';
import {
  configureSkillInstallHandlers,
  requestSkillInstallHandler,
} from '@core/jobs/ipc-skill-install-handlers.js';
import {
  collectInstalledSkillAssets,
  discoverInstalledSkillRoots,
  MAX_SKILL_DISCOVERY_DIRECTORIES,
  MAX_SKILLS_PER_INSTALL_COMMAND,
  rollbackInstalledSkillReplacement,
  safeInstallerEnv,
  skillInstallCommandReceipt,
} from '@core/jobs/skill-install-assets.js';

const RAW_SKILL_FAILURE_SENTINEL =
  'RAW_SKILL_FAILURE_SENTINEL: artifact storage exploded';

class MemorySkillRepository implements SkillCatalogRepository {
  readonly skills = new Map<string, SkillCatalogItem>();
  readonly bindings = new Map<string, AgentSkillBinding>();

  constructor(
    private failBindingSkillName?: string,
    private readonly failRollbackSkillName?: string,
  ) {}

  failBindingFor(skillName: string) {
    this.failBindingSkillName = skillName;
  }

  async getSkill(id: SkillId) {
    return this.skills.get(id) ?? null;
  }

  async listSkills(input: {
    appId: string;
    statuses?: SkillCatalogItem['status'][];
  }) {
    return [...this.skills.values()].filter(
      (skill) =>
        skill.appId === input.appId &&
        (!input.statuses || input.statuses.includes(skill.status)),
    );
  }

  async saveSkill(skill: SkillCatalogItem) {
    this.skills.set(skill.id, skill);
  }

  async saveAgentSkillBinding(binding: AgentSkillBinding) {
    if (this.skills.get(binding.skillId)?.name === this.failBindingSkillName) {
      const failedSkillName = this.failBindingSkillName;
      this.failBindingSkillName = undefined;
      throw new Error(`Could not bind ${failedSkillName}.`);
    }
    this.bindings.set(`${binding.agentId}:${binding.skillId}`, binding);
  }

  async disableAgentSkillBinding(input: {
    agentId: string;
    skillId: SkillId;
    updatedAt: string;
  }) {
    if (this.skills.get(input.skillId)?.name === this.failRollbackSkillName) {
      throw new Error(`Could not clean up ${this.failRollbackSkillName}.`);
    }
    const key = `${input.agentId}:${input.skillId}`;
    const binding = this.bindings.get(key);
    if (!binding) return null;
    const disabled = { ...binding, status: 'disabled' as const };
    this.bindings.set(key, disabled);
    return disabled;
  }

  async listAgentSkillBindings(input: { appId: string; agentId: string }) {
    return [...this.bindings.values()].filter(
      (binding) =>
        binding.appId === input.appId && binding.agentId === input.agentId,
    );
  }

  async listAgentSkillBindingsForAgents(input: {
    appId: string;
    agentIds: readonly string[];
  }) {
    return [...this.bindings.values()].filter(
      (binding) =>
        binding.appId === input.appId &&
        input.agentIds.includes(binding.agentId),
    );
  }

  async listEnabledSkillsForAgent(input: { appId: string; agentId: string }) {
    const ids = new Set(
      [...this.bindings.values()]
        .filter(
          (binding) =>
            binding.appId === input.appId &&
            binding.agentId === input.agentId &&
            binding.status === 'active',
        )
        .map((binding) => binding.skillId),
    );
    return [...this.skills.values()].filter((skill) => ids.has(skill.id));
  }
}

class MemorySkillArtifactStore implements SkillArtifactStore {
  readonly bundles = new Map<
    string,
    Awaited<ReturnType<SkillArtifactStore['getSkillArtifact']>>
  >();

  constructor(private readonly failSkillName?: string) {}

  async putSkillArtifact(
    input: Parameters<SkillArtifactStore['putSkillArtifact']>[0],
  ) {
    if (input.skillName === this.failSkillName) {
      throw new Error(RAW_SKILL_FAILURE_SENTINEL);
    }
    const stored = {
      storageType: 'local-filesystem' as const,
      storageRef: `skills/${input.skillName}`,
      contentHash: `sha256:${input.skillName}`,
      sizeBytes: input.bundle.assets.reduce(
        (total, asset) => total + asset.content.byteLength,
        0,
      ),
    };
    this.bundles.set(stored.storageRef, input.bundle);
    return stored;
  }

  async getSkillArtifact(storageRef: string) {
    return this.bundles.get(storageRef) ?? { assets: [] };
  }
}

function withStagingDir(run: (stagingDir: string) => void) {
  const stagingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-skill-assets-test-'),
  );
  try {
    run(stagingDir);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function writeSkill(
  root: string,
  relativeDir: string,
  name: string,
  requiredEnv?: string,
) {
  const skillDir = path.join(root, relativeDir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\n${requiredEnv ? `required_env: ${requiredEnv}\n` : ''}---\n# ${name}\n`,
  );
  fs.writeFileSync(path.join(skillDir, 'notes.md'), `${name} notes`);
}

describe('installed skill package collection', () => {
  it('keeps a root SKILL.md package as one skill', () => {
    withStagingDir((stagingDir) => {
      writeSkill(stagingDir, '.', 'root-skill');
      writeSkill(stagingDir, 'nested', 'nested-skill');

      const discovery = discoverInstalledSkillRoots(stagingDir);

      expect(discovery).toEqual({
        roots: [stagingDir],
        skippedBeyondLimit: false,
      });
      expect(
        collectInstalledSkillAssets(discovery.roots[0]).map(
          (asset) => asset.path,
        ),
      ).toEqual(['SKILL.md', 'nested/SKILL.md', 'nested/notes.md', 'notes.md']);
    });
  });

  it('collects a single nested skill relative to its folder', () => {
    withStagingDir((stagingDir) => {
      writeSkill(stagingDir, 'repo/only-skill', 'only-skill');

      const discovery = discoverInstalledSkillRoots(stagingDir);

      expect(discovery.roots).toEqual([
        path.join(stagingDir, 'repo/only-skill'),
      ]);
      expect(
        collectInstalledSkillAssets(discovery.roots[0]).map(
          (asset) => asset.path,
        ),
      ).toEqual(['SKILL.md', 'notes.md']);
    });
  });

  it('collects every nested skill in deterministic path order', () => {
    withStagingDir((stagingDir) => {
      writeSkill(stagingDir, 'skills/zeta', 'zeta');
      writeSkill(stagingDir, 'skills/alpha', 'alpha');

      expect(discoverInstalledSkillRoots(stagingDir).roots).toEqual([
        path.join(stagingDir, 'skills/alpha'),
        path.join(stagingDir, 'skills/zeta'),
      ]);
    });
  });

  it('does not rediscover skill roots nested inside another skill package', () => {
    withStagingDir((stagingDir) => {
      writeSkill(stagingDir, 'skills/alpha', 'alpha');
      writeSkill(stagingDir, 'skills/alpha/examples/nested', 'nested');
      writeSkill(stagingDir, 'skills/zeta', 'zeta');

      expect(discoverInstalledSkillRoots(stagingDir).roots).toEqual([
        path.join(stagingDir, 'skills/alpha'),
        path.join(stagingDir, 'skills/zeta'),
      ]);
    });
  });

  it('deduplicates identical skill copies before applying the cap', () => {
    withStagingDir((stagingDir) => {
      writeSkill(stagingDir, '.agents/skills/alpha', 'alpha');
      writeSkill(stagingDir, '.claude/skills/alpha', 'alpha');

      expect(discoverInstalledSkillRoots(stagingDir).roots).toEqual([
        path.join(stagingDir, '.agents/skills/alpha'),
      ]);
    });
  });

  it('keeps the existing zero-skill error', () => {
    withStagingDir((stagingDir) => {
      fs.writeFileSync(path.join(stagingDir, 'README.md'), '# No skills');

      expect(() => discoverInstalledSkillRoots(stagingDir)).toThrow(
        'Installer command did not produce a SKILL.md file.',
      );
    });
  });

  it('caps nested discovery at 25 deterministic roots', () => {
    withStagingDir((stagingDir) => {
      for (let index = 29; index >= 0; index -= 1) {
        writeSkill(
          stagingDir,
          `skills/skill-${String(index).padStart(2, '0')}`,
          `skill-${index}`,
        );
      }

      const discovery = discoverInstalledSkillRoots(stagingDir);

      expect(discovery.roots).toHaveLength(MAX_SKILLS_PER_INSTALL_COMMAND);
      expect(discovery.roots[0]).toBe(path.join(stagingDir, 'skills/skill-00'));
      expect(discovery.roots.at(-1)).toBe(
        path.join(stagingDir, 'skills/skill-24'),
      );
      expect(discovery.skippedBeyondLimit).toBe(true);
    });
  });

  it('bounds traversal through installer output without skills', () => {
    withStagingDir((stagingDir) => {
      for (let index = 0; index < MAX_SKILL_DISCOVERY_DIRECTORIES; index += 1) {
        fs.mkdirSync(path.join(stagingDir, `directory-${index}`));
      }

      expect(() => discoverInstalledSkillRoots(stagingDir)).toThrow(
        'Installer output exceeds the skill discovery limit.',
      );
    });
  });

  it('bounds traversal within a discovered skill package', () => {
    withStagingDir((stagingDir) => {
      writeSkill(stagingDir, '.', 'alpha');
      for (let index = 0; index < MAX_SKILL_DISCOVERY_DIRECTORIES; index += 1) {
        fs.mkdirSync(path.join(stagingDir, `directory-${index}`));
      }

      expect(() => collectInstalledSkillAssets(stagingDir)).toThrow(
        'Installed skill package exceeds the traversal limit.',
      );
    });
  });
});

describe('safe installer env', () => {
  it('marks the headless sandbox as agent-driven so installers skip prompts', () => {
    expect(safeInstallerEnv({ PATH: '/bin', SECRET: 'x' })).toEqual({
      PATH: '/bin',
      AI_AGENT: '1',
    });
  });
});

describe('skill install command receipt', () => {
  it('keeps the operational failure reason out of the agent-facing receipt', () => {
    const receipt = skillInstallCommandReceipt({
      skills: [],
      failed: [{ name: 'bad', reason: RAW_SKILL_FAILURE_SENTINEL }],
      skippedBeyondLimit: false,
    });

    expect(receipt).toBe(
      "I couldn't install bad. I left it unchanged and can try again after the setup issue is fixed.",
    );
    expect(receipt).not.toContain(RAW_SKILL_FAILURE_SENTINEL);
    expect(receipt).not.toMatch(/^(?:Installed|Activation|Skipped|Failed):/m);
  });
});

describe('replacement rollback partial-write heal', () => {
  it('restores the snapshot even when the partial artifact cannot be read', async () => {
    const skill = {
      id: 'skill:1',
      appId: 'app:test',
      name: 'alpha',
      status: 'installed',
      storage: {
        storageType: 'local-filesystem',
        storageRef: 'skills/alpha',
        contentHash: 'sha256:old',
        sizeBytes: 1,
      },
    } as never as SkillCatalogItem;
    const snapshot = {
      skill,
      agentId: 'agent:test',
      bundle: { assets: [{ path: 'SKILL.md', content: new Uint8Array([1]) }] },
    } as never;
    const saveSkill = vi.fn(async () => undefined);
    const putSkillArtifact = vi.fn(async () => ({
      storageType: 'local-filesystem' as const,
      storageRef: 'skills/alpha',
      contentHash: 'sha256:restored',
      sizeBytes: 1,
    }));
    const syncAfterRestore = vi.fn(async () => undefined);

    const result = await rollbackInstalledSkillReplacement({
      reason: 'Could not store alpha.',
      snapshot,
      attemptedAssets: [],
      skills: {
        getSkill: async () => skill,
        listAgentSkillBindings: async () => [],
        saveSkill,
      } as never,
      artifacts: {
        getSkillArtifact: async () => {
          throw new Error('partial bundle is missing SKILL.md');
        },
        putSkillArtifact,
      } as never,
      syncAfterRestore,
    });

    expect(putSkillArtifact).toHaveBeenCalledTimes(1);
    expect(saveSkill).toHaveBeenCalledTimes(1);
    expect(syncAfterRestore).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      reason: 'Could not store alpha.',
      stopAfterFailure: false,
    });
  });

  it('restores the snapshot when the replacement row is durable but install never returned', async () => {
    // installSkill can save the replacement row and then fail in duplicate
    // cleanup — the caller never sees the installed skill, yet the row and
    // artifact are already replaced.
    const snapshotSkill = {
      id: 'skill:1',
      appId: 'app:test',
      name: 'alpha',
      status: 'installed',
      storage: {
        storageType: 'local-filesystem',
        storageRef: 'skills/alpha',
        contentHash: 'sha256:old',
        sizeBytes: 1,
      },
    } as never as SkillCatalogItem;
    const replacementRow = {
      ...snapshotSkill,
      updatedAt: 'later',
      storage: { ...snapshotSkill.storage!, contentHash: 'sha256:new' },
    };
    const snapshot = {
      skill: snapshotSkill,
      agentId: 'agent:test',
      bundle: { assets: [{ path: 'SKILL.md', content: new Uint8Array([1]) }] },
    } as never;
    const saveSkill = vi.fn(async (_skill: SkillCatalogItem) => undefined);
    const putSkillArtifact = vi.fn(async () => ({
      storageType: 'local-filesystem' as const,
      storageRef: 'skills/alpha',
      contentHash: 'sha256:restored',
      sizeBytes: 1,
    }));
    const syncAfterRestore = vi.fn(async () => undefined);

    const result = await rollbackInstalledSkillReplacement({
      reason: 'Duplicate cleanup failed.',
      snapshot,
      attemptedAssets: [{ path: 'SKILL.md', content: new Uint8Array([2]) }],
      skills: {
        getSkill: async () => replacementRow,
        listAgentSkillBindings: async () => [],
        saveSkill,
      } as never,
      artifacts: {
        getSkillArtifact: async () => ({
          assets: [{ path: 'SKILL.md', content: new Uint8Array([2]) }],
        }),
        putSkillArtifact,
      } as never,
      syncAfterRestore,
    });

    expect(putSkillArtifact).toHaveBeenCalledTimes(1);
    expect(saveSkill.mock.calls[0]?.[0]).toMatchObject({
      id: 'skill:1',
      storage: { contentHash: 'sha256:restored' },
    });
    expect(saveSkill.mock.calls[0]?.[0]?.updatedAt).not.toBe('later');
    expect(syncAfterRestore).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      reason: 'Duplicate cleanup failed.',
      stopAfterFailure: false,
    });
  });
});

describe('approved command skill installs', () => {
  function setup(input?: {
    failArtifactSkillName?: string;
    failBindingSkillName?: string;
    failRollbackSkillName?: string;
    failSyncOnCall?: number;
    failSyncFromCall?: number;
    onFailedSync?: (skills: MemorySkillRepository) => void;
  }) {
    const skills = new MemorySkillRepository(
      input?.failBindingSkillName,
      input?.failRollbackSkillName,
    );
    const skillArtifacts = new MemorySkillArtifactStore(
      input?.failArtifactSkillName,
    );
    let syncCalls = 0;
    const syncApprovedCapabilitySettings = vi.fn(async () => {
      syncCalls += 1;
      if (
        syncCalls === input?.failSyncOnCall ||
        (input?.failSyncFromCall !== undefined &&
          syncCalls >= input.failSyncFromCall)
      ) {
        input?.onFailedSync?.(skills);
        throw new Error('Could not sync settings.');
      }
    });
    const logError = vi.fn();
    configureSkillInstallHandlers({
      getStorage: () => ({
        repositories: { skills },
        skillArtifacts,
      }),
      logInfo: vi.fn(),
      logError,
      syncApprovedCapabilitySettings,
    });
    return { skills, skillArtifacts, logError, syncApprovedCapabilitySettings };
  }

  function context(input: {
    runApprovedCommand: (input: { cwd: string }) => Promise<unknown>;
    sendMessage: ReturnType<typeof vi.fn>;
  }) {
    return {
      data: {
        appId: 'app:test',
        chatJid: 'chat:one',
        payload: {
          reason: 'Install requested skills.',
          installCommandArgv: ['skill-installer', 'install', 'example'],
        },
      },
      sourceAgentFolder: 'main_agent',
      sourceAgentFolderJids: ['chat:one'],
      conversationBindings: {},
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          decidedBy: 'user:approver',
        })),
        sendMessage: input.sendMessage,
        runApprovedCommand: input.runApprovedCommand,
      },
    } as never;
  }

  it('installs and binds every discovered skill and lists their names', async () => {
    const { skills, syncApprovedCapabilitySettings } = setup();
    const sendMessage = vi.fn(async () => undefined);

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, 'skills/zeta', 'zeta');
          writeSkill(cwd, 'skills/alpha', 'alpha');
        },
      }),
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect([...skills.skills.values()].map((skill) => skill.name)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(
      [...skills.bindings.values()].filter(
        (binding) => binding.status === 'active',
      ),
    ).toHaveLength(2);
    expect(syncApprovedCapabilitySettings).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[1]).toBe(
      'I installed alpha, zeta.\n' +
        'The installed skill content is shared with me in this conversation now, up to a size budget; every installed skill is registered and loads automatically from your next message.',
    );
  });

  it('keeps the stable fallback for a root package without a declared name', async () => {
    const { skills } = setup();
    const sendMessage = vi.fn(async () => undefined);

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async ({ cwd }) => {
          fs.writeFileSync(path.join(cwd, 'SKILL.md'), '# Unnamed skill\n');
        },
      }),
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect([...skills.skills.values()][0]?.name).toBe('installed-skill');
  });

  it('keeps successful skills when one discovered skill fails', async () => {
    const { skills, logError, syncApprovedCapabilitySettings } = setup({
      failArtifactSkillName: 'bad',
    });
    const sendMessage = vi.fn(async () => undefined);

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, 'skills/alpha', 'alpha');
          writeSkill(cwd, 'skills/bad', 'bad');
          writeSkill(cwd, 'skills/zeta', 'zeta');
        },
      }),
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect([...skills.skills.values()].map((skill) => skill.name)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(syncApprovedCapabilitySettings).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledWith(
      {
        appId: 'app:test',
        agentId: 'agent:main_agent',
        skillName: 'bad',
        reason: RAW_SKILL_FAILURE_SENTINEL,
      },
      'Skill install failed for skill',
    );
    expect(sendMessage.mock.calls[0]?.[1]).toBe(
      'I installed alpha, zeta.\n' +
        'The installed skill content is shared with me in this conversation now, up to a size budget; every installed skill is registered and loads automatically from your next message.',
    );
    expect(sendMessage.mock.calls[0]?.[1]).not.toContain(
      RAW_SKILL_FAILURE_SENTINEL,
    );
  });

  it('keeps oversized package failures inside the per-skill install loop', async () => {
    const { skills, logError } = setup();
    const sendMessage = vi.fn(async () => undefined);

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, 'skills/alpha', 'alpha');
          writeSkill(cwd, 'skills/bad', 'bad');
          fs.appendFileSync(
            path.join(cwd, 'skills/bad/SKILL.md'),
            'x'.repeat(1_000_000),
          );
        },
      }),
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect([...skills.skills.values()].map((skill) => skill.name)).toEqual([
      'alpha',
    ]);
    expect(logError).toHaveBeenCalledWith(
      {
        appId: 'app:test',
        agentId: 'agent:main_agent',
        skillName: 'bad',
        reason: 'Installed skill package is larger than 1 MB.',
      },
      'Skill install failed for skill',
    );
    expect(sendMessage.mock.calls[0]?.[1]).toBe('I installed alpha.');
  });

  it('fails an over-cap skill without affecting other discovered skills', async () => {
    const { skills } = setup();
    const sendMessage = vi.fn(async () => undefined);

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, 'skills/alpha', 'alpha');
          writeSkill(cwd, 'skills/bad', 'bad');
          for (let index = 0; index < 49; index += 1) {
            fs.writeFileSync(
              path.join(cwd, 'skills/bad', `extra-${index}.txt`),
              `${index}`,
            );
          }
          writeSkill(cwd, 'skills/zeta', 'zeta');
        },
      }),
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect([...skills.skills.values()].map((skill) => skill.name)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(sendMessage.mock.calls[0]?.[1]).toBe(
      'I installed alpha, zeta.\n' +
        'The installed skill content is shared with me in this conversation now, up to a size budget; every installed skill is registered and loads automatically from your next message.',
    );
  });

  it('restores an existing skill and binding after settings sync fails', async () => {
    const { skills, skillArtifacts, syncApprovedCapabilitySettings } = setup({
      failSyncOnCall: 3,
    });
    const initialMessage = vi.fn(async () => undefined);
    await requestSkillInstallHandler(
      context({
        sendMessage: initialMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, '.', 'beta');
        },
      }),
    );
    await vi.waitFor(() => expect(initialMessage).toHaveBeenCalledTimes(1));
    const sendMessage = vi.fn(async () => undefined);

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, 'skills/alpha', 'alpha');
          writeSkill(cwd, 'skills/beta', 'beta');
          fs.writeFileSync(
            path.join(cwd, 'skills/beta/notes.md'),
            'replacement notes',
          );
          writeSkill(cwd, 'skills/zeta', 'zeta');
        },
      }),
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(
      [...skills.skills.values()].map((skill) => skill.name).sort(),
    ).toEqual(['alpha', 'beta', 'zeta']);
    expect(
      [...skills.bindings.values()].find(
        (binding) => skills.skills.get(binding.skillId)?.name === 'beta',
      )?.status,
    ).toBe('active');
    expect(syncApprovedCapabilitySettings).toHaveBeenCalledTimes(5);
    const restored = await skillArtifacts.getSkillArtifact('skills/beta');
    expect(
      Buffer.from(
        restored.assets.find((asset) => asset.path === 'notes.md')!.content,
      ).toString('utf-8'),
    ).toBe('beta notes');
    expect(sendMessage.mock.calls[0]?.[1]).toBe(
      'I installed alpha, zeta.\n' +
        'The installed skill content is shared with me in this conversation now, up to a size budget; every installed skill is registered and loads automatically from your next message.',
    );
  });

  it('restores existing state when binding the replacement fails', async () => {
    const { skills, skillArtifacts, syncApprovedCapabilitySettings } = setup();
    const initialMessage = vi.fn(async () => undefined);
    await requestSkillInstallHandler(
      context({
        sendMessage: initialMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, '.', 'beta');
        },
      }),
    );
    await vi.waitFor(() => expect(initialMessage).toHaveBeenCalledTimes(1));
    skills.failBindingFor('beta');
    const sendMessage = vi.fn(async () => undefined);

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, '.', 'beta');
          fs.writeFileSync(path.join(cwd, 'notes.md'), 'replacement notes');
        },
      }),
    );

    await vi.waitFor(() =>
      expect(syncApprovedCapabilitySettings).toHaveBeenCalledTimes(2),
    );
    const restored = await skillArtifacts.getSkillArtifact('skills/beta');
    expect(
      Buffer.from(
        restored.assets.find((asset) => asset.path === 'notes.md')!.content,
      ).toString('utf-8'),
    ).toBe('beta notes');
    expect(
      [...skills.bindings.values()].find(
        (binding) => skills.skills.get(binding.skillId)?.name === 'beta',
      )?.status,
    ).toBe('active');
    expect(syncApprovedCapabilitySettings).toHaveBeenCalledTimes(2);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('restores the snapshot when the failing sync mutated skill state', async () => {
    const { skills, skillArtifacts, syncApprovedCapabilitySettings } = setup();
    const initialMessage = vi.fn(async () => undefined);
    await requestSkillInstallHandler(
      context({
        sendMessage: initialMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, '.', 'beta');
        },
      }),
    );
    await vi.waitFor(() => expect(initialMessage).toHaveBeenCalledTimes(1));
    syncApprovedCapabilitySettings
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        const beta = [...skills.skills.values()].find(
          (skill) => skill.name === 'beta',
        )!;
        const bundle = {
          assets: [
            {
              path: 'SKILL.md',
              content: Buffer.from('---\nname: beta\n---\n# beta\n'),
            },
            {
              path: 'notes.md',
              content: Buffer.from('concurrent newer notes'),
            },
          ],
        };
        const storage = await skillArtifacts.putSkillArtifact({
          appId: beta.appId,
          skillId: beta.id,
          skillName: beta.name,
          bundle,
        });
        await skills.saveSkill({
          ...beta,
          description: 'concurrent newer description',
          storage,
          updatedAt: '9999-12-31T23:59:59.999Z' as never,
        });
        const binding = [...skills.bindings.values()].find(
          (candidate) => candidate.skillId === beta.id,
        )!;
        await skills.saveAgentSkillBinding({
          ...binding,
          updatedAt: '9999-12-31T23:59:59.999Z' as never,
        });
        throw new Error('Could not sync settings.');
      });
    const sendMessage = vi.fn(async () => undefined);

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, 'skills/alpha', 'alpha');
          writeSkill(cwd, 'skills/beta', 'beta');
          fs.writeFileSync(
            path.join(cwd, 'skills/beta/notes.md'),
            'replacement notes',
          );
          writeSkill(cwd, 'skills/zeta', 'zeta');
        },
      }),
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    // The mutation happened while THIS attempt held the lock, so it is the
    // attempt's own partial state and must be rolled back to the snapshot.
    const beta = [...skills.skills.values()].find(
      (skill) => skill.name === 'beta',
    )!;
    expect(beta.description).not.toBe('concurrent newer description');
    expect(
      [...skills.bindings.values()].find(
        (binding) => binding.skillId === beta.id,
      )?.updatedAt,
    ).not.toBe('9999-12-31T23:59:59.999Z');
    const current = await skillArtifacts.getSkillArtifact('skills/beta');
    expect(
      Buffer.from(
        current.assets.find((asset) => asset.path === 'notes.md')!.content,
      ).toString('utf-8'),
    ).toBe('beta notes');
    expect(syncApprovedCapabilitySettings).toHaveBeenCalledTimes(5);
    expect(sendMessage.mock.calls[0]?.[1]).toBe(
      'I installed alpha, zeta.\n' +
        'The installed skill content is shared with me in this conversation now, up to a size budget; every installed skill is registered and loads automatically from your next message.',
    );
  });

  it('preserves credential setup guidance for all installed skills', async () => {
    setup();
    const sendMessage = vi.fn(async () => undefined);

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, 'skills/alpha', 'alpha', 'ALPHA_TOKEN');
          writeSkill(cwd, 'skills/zeta', 'zeta', 'ZETA_TOKEN');
        },
      }),
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]?.[1]).toContain('Credential Center');
    expect(sendMessage.mock.calls[0]?.[1]).not.toContain('ALPHA_TOKEN');
    expect(sendMessage.mock.calls[0]?.[1]).not.toContain('ZETA_TOKEN');
    expect(sendMessage.mock.calls[0]?.[1]).not.toContain('gantry credentials');
  });

  it('does not overwrite a skill when two roots share a materialization name', async () => {
    const { skills } = setup();
    const sendMessage = vi.fn(async () => undefined);

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, 'skills/alpha', "writer's-tool");
          writeSkill(cwd, 'skills/zeta', "writer's-tool");
          fs.writeFileSync(
            path.join(cwd, 'skills/zeta/notes.md'),
            'conflicting notes',
          );
        },
      }),
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(skills.skills.size).toBe(1);
    expect(sendMessage.mock.calls[0]?.[1]).toBe("I installed writer's-tool.");
  });

  it('reconciles an active binding when rollback fails after settings sync', async () => {
    const { skills, syncApprovedCapabilitySettings } = setup({
      failRollbackSkillName: 'beta',
      failSyncOnCall: 2,
    });
    const sendMessage = vi.fn(async () => undefined);

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, 'skills/alpha', 'alpha');
          writeSkill(cwd, 'skills/beta', 'beta');
          writeSkill(cwd, 'skills/zeta', 'zeta');
        },
      }),
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect([...skills.skills.values()].map((skill) => skill.name)).toEqual([
      'alpha',
      'beta',
      'zeta',
    ]);
    expect(syncApprovedCapabilitySettings).toHaveBeenCalledTimes(4);
    expect(sendMessage.mock.calls[0]?.[1]).toBe(
      'I installed alpha, beta, zeta.\n' +
        'The installed skill content is shared with me in this conversation now, up to a size budget; every installed skill is registered and loads automatically from your next message.',
    );
  });

  it('writes a compensating settings revision after rolling back a failed sync', async () => {
    const { skills, syncApprovedCapabilitySettings } = setup({
      failSyncOnCall: 2,
    });
    const sendMessage = vi.fn(async () => undefined);

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, 'skills/alpha', 'alpha');
          writeSkill(cwd, 'skills/beta', 'beta');
          writeSkill(cwd, 'skills/zeta', 'zeta');
        },
      }),
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(
      [...skills.bindings.values()]
        .filter((binding) => binding.status === 'active')
        .map((binding) => skills.skills.get(binding.skillId)?.name),
    ).toEqual(['alpha', 'zeta']);
    expect(syncApprovedCapabilitySettings).toHaveBeenCalledTimes(4);
    expect(sendMessage.mock.calls[0]?.[1]).toBe(
      'I installed alpha, zeta.\n' +
        'The installed skill content is shared with me in this conversation now, up to a size budget; every installed skill is registered and loads automatically from your next message.',
    );
  });

  it('unbinds a failed fresh install even when the failing sync mutated the binding', async () => {
    const { skills } = setup({
      failSyncOnCall: 2,
      onFailedSync: (repo) => {
        for (const [key, binding] of repo.bindings) {
          if (repo.skills.get(binding.skillId)?.name === 'beta') {
            repo.bindings.set(key, {
              ...binding,
              updatedAt: 'sync-reconciliation',
            });
          }
        }
      },
    });
    const sendMessage = vi.fn(async () => undefined);

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, 'skills/alpha', 'alpha');
          writeSkill(cwd, 'skills/beta', 'beta');
        },
      }),
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    // The mutation is the failing sync's own write under this attempt's
    // lock — cleanup must still unbind rather than misread it as a
    // concurrent writer and strand the binding.
    const betaBinding = [...skills.bindings.values()].find(
      (binding) => skills.skills.get(binding.skillId)?.name === 'beta',
    );
    expect(betaBinding?.status).toBe('disabled');
    expect(sendMessage.mock.calls[0]?.[1]).toBe('I installed alpha.');
  });

  it('stops with a partial receipt when settings reconciliation stays unavailable', async () => {
    const { skills, syncApprovedCapabilitySettings } = setup({
      failSyncFromCall: 2,
    });
    const sendMessage = vi.fn(async () => undefined);

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async ({ cwd }) => {
          writeSkill(cwd, 'skills/alpha', 'alpha');
          writeSkill(cwd, 'skills/beta', 'beta');
          writeSkill(cwd, 'skills/zeta', 'zeta');
        },
      }),
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect([...skills.skills.values()].map((skill) => skill.name)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(syncApprovedCapabilitySettings).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[0]?.[1]).toBe('I installed alpha.');
  });

  it('installs only the first 25 alphabetical skills and reports the cap', async () => {
    const { skills, syncApprovedCapabilitySettings } = setup();
    const sendMessage = vi.fn(async () => undefined);

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async ({ cwd }) => {
          for (let index = 29; index >= 0; index -= 1) {
            writeSkill(
              cwd,
              `skills/skill-${String(index).padStart(2, '0')}`,
              `skill-${String(index).padStart(2, '0')}`,
            );
          }
        },
      }),
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect([...skills.skills.values()].map((skill) => skill.name)).toEqual(
      Array.from(
        { length: 25 },
        (_, index) => `skill-${String(index).padStart(2, '0')}`,
      ),
    );
    expect(syncApprovedCapabilitySettings).toHaveBeenCalledTimes(25);
    expect(sendMessage.mock.calls[0]?.[1]).toContain(
      'I stopped after 25 skills because one request cannot install more than that.',
    );
  });

  it('keeps command failure output in logs and out of chat', async () => {
    const { logError } = setup();
    const sendMessage = vi.fn(async () => undefined);
    const rawReason =
      'RAW_INSTALLER_COMMAND_SENTINEL: Command failed with exit code 1';

    await requestSkillInstallHandler(
      context({
        sendMessage,
        runApprovedCommand: async () => {
          throw new Error(rawReason);
        },
      }),
    );

    await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
    expect(logError.mock.calls[0]?.[0]).toMatchObject({
      toolName: 'request_skill_install',
    });
    expect(
      (logError.mock.calls[0]?.[0] as { err?: Error } | undefined)?.err
        ?.message,
    ).toBe(rawReason);
    expect(logError.mock.calls[0]?.[1]).toBe(
      'Skill install command review failed',
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('installedSkillContext', () => {
  it('carries ALL installed skills for same-session inlining', async () => {
    const { installedSkillContext } =
      await import('@core/jobs/skill-install-assets.js');
    const skill = (id: string, name: string, envVars: string[] = []) =>
      ({
        id,
        name,
        description: `${name} description`,
        requiredEnvVars: envVars,
      }) as never;
    const assets = (content: string) => [
      { path: 'SKILL.md', content: Buffer.from(content) },
    ];

    const context = installedSkillContext([
      {
        skill: skill('skill:alpha', 'alpha', ['TOKEN_A']),
        assets: assets('# alpha'),
      },
      {
        skill: skill('skill:beta', 'beta', ['TOKEN_B']),
        assets: assets('# beta'),
      },
      { skill: skill('skill:gamma', 'gamma'), assets: assets('# gamma') },
    ]);

    expect(context).toMatchObject({
      type: 'installed_skill_context',
      skill: { id: 'skill:alpha', name: 'alpha' },
      files: [{ path: 'SKILL.md', content: '# alpha' }],
      requiredEnvVars: ['TOKEN_A', 'TOKEN_B'],
      additionalSkills: [
        {
          skill: { id: 'skill:beta', name: 'beta' },
          files: [{ path: 'SKILL.md', content: '# beta' }],
        },
        {
          skill: { id: 'skill:gamma', name: 'gamma' },
          files: [{ path: 'SKILL.md', content: '# gamma' }],
        },
      ],
    });
  });

  it('omits additionalSkills for a single installed skill', async () => {
    const { installedSkillContext } =
      await import('@core/jobs/skill-install-assets.js');

    const context = installedSkillContext([
      {
        skill: { id: 'skill:solo', name: 'solo' } as never,
        assets: [{ path: 'SKILL.md', content: Buffer.from('# solo') }],
      },
    ]);

    expect(context.additionalSkills).toBeUndefined();
    expect(context.skill).toMatchObject({ id: 'skill:solo' });
  });
});
