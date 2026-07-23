import { describe, expect, it, vi } from 'vitest';

import { startSkillPermissionReview } from '@core/jobs/ipc-skill-permission-review.js';
import { skillNameForReceipt } from '@core/jobs/skill-install-assets.js';
import { withSkillMaterializationLock } from '@core/shared/skill-install-lock.js';
import { materializedSkillDirectoryNameFor } from '@core/domain/skills/skills.js';

describe('skill permission review install sequence', () => {
  it('shows an update approval and replaces a skill only after approval', async () => {
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'user:admin',
    }));
    const sendMessage = vi.fn(async () => undefined);
    const acceptData = vi.fn();
    const currentSkill = {
      id: 'skill:1',
      appId: 'app:test',
      name: 'demo-skill',
      status: 'installed',
      storage: { contentHash: 'sha256:old' },
    };
    const updatedSkill = {
      ...currentSkill,
      storage: { contentHash: 'sha256:new' },
    };
    const service = {
      installMaterializationCollisionForAgent: vi.fn(async () => null),
      requireSkill: vi.fn(async () => currentSkill),
      installSkill: vi.fn(async () => updatedSkill),
      bindSkillToAgent: vi.fn(async () => undefined),
    };

    await new Promise<void>((resolve) => {
      startSkillPermissionReview({
        deps: { requestPermissionApproval, sendMessage },
        responder: { acceptData, reject: vi.fn() },
        service,
        syncApprovedCapabilitySettings: vi.fn(async () => undefined),
        appId: 'app:test',
        agentId: 'agent:test',
        sourceAgentFolder: 'main_agent',
        targetJid: 'sl:C123',
        skill: { id: 'skill:1', name: 'demo-skill' },
        operation: 'update',
        expectedContentHash: 'sha256:old',
        replacement: {
          currentSkill,
          snapshot: { skill: currentSkill, agentId: 'agent:test', bundle: {} },
          skills: {},
          artifacts: {},
        },
        assets: [],
        fileSummaries: [],
        skillMarkdownPreview: {
          path: 'SKILL.md',
          content: '',
          truncated: false,
        },
        totalSizeBytes: 0,
        reason: 'improve the workflow',
        requestToolName: 'request_skill_proposal',
        onSettled: resolve,
      } as never);
    });

    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Update skill for this agent',
        toolInput: expect.objectContaining({
          operation: 'update',
          skillId: 'skill:1',
          currentContentHash: 'sha256:old',
          expectedContentHash: 'sha256:old',
        }),
        interaction: expect.objectContaining({
          title: 'Update skill demo-skill',
        }),
      }),
    );
    expect(service.installSkill).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.stringContaining('Updated'),
      undefined,
    );
    expect(acceptData).toHaveBeenCalledWith(
      expect.stringContaining('Updated'),
      expect.anything(),
      'skill_updated',
    );
  });

  it('rejects an approved update if its installed base changed while waiting', async () => {
    const currentSkill = {
      id: 'skill:1',
      appId: 'app:test',
      name: 'demo-skill',
      status: 'installed',
      storage: { contentHash: 'sha256:old' },
    };
    const service = {
      installMaterializationCollisionForAgent: vi.fn(async () => null),
      requireSkill: vi.fn(async () => ({
        ...currentSkill,
        storage: { contentHash: 'sha256:newer' },
      })),
      installSkill: vi.fn(),
      bindSkillToAgent: vi.fn(),
    };
    const reject = vi.fn();

    await new Promise<void>((resolve) => {
      startSkillPermissionReview({
        deps: {
          requestPermissionApproval: vi.fn(async () => ({
            approved: true,
            decidedBy: 'user:admin',
          })),
          sendMessage: vi.fn(async () => undefined),
        },
        responder: { acceptData: vi.fn(), reject },
        service,
        syncApprovedCapabilitySettings: vi.fn(async () => undefined),
        appId: 'app:test',
        agentId: 'agent:test',
        sourceAgentFolder: 'main_agent',
        targetJid: 'sl:C123',
        skill: { id: 'skill:1', name: 'demo-skill' },
        operation: 'update',
        replacement: {
          currentSkill,
          snapshot: { skill: currentSkill, agentId: 'agent:test', bundle: {} },
          skills: {},
          artifacts: {},
        },
        assets: [],
        fileSummaries: [],
        skillMarkdownPreview: {
          path: 'SKILL.md',
          content: '',
          truncated: false,
        },
        totalSizeBytes: 0,
        reason: 'improve the workflow',
        requestToolName: 'request_skill_proposal',
        onSettled: resolve,
      } as never);
    });

    expect(service.installSkill).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      expect.stringContaining(
        'changed while this update was awaiting approval',
      ),
      'skill_update_conflict',
    );
  });

  it('holds the materialization lock across install, bind failure, and rollback', async () => {
    const rawReason = 'RAW_SKILL_REVIEW_SENTINEL: bind failed';
    const order: string[] = [];
    const key = materializedSkillDirectoryNameFor(
      skillNameForReceipt([], 'demo-skill'),
    ).toLowerCase();
    const rollbackInstalledSkillBinding = vi.fn(async () => {
      order.push('rollback');
    });
    const service = {
      installMaterializationCollisionForAgent: vi.fn(async () => null),
      installSkill: vi.fn(async () => {
        order.push('install');
        // A same-key writer queued mid-sequence must wait for the full
        // install→bind→rollback compensation, not just the install step.
        void withSkillMaterializationLock(key, async () => {
          order.push('concurrent');
        });
        return { id: 'skill:1', name: 'demo-skill' };
      }),
      bindSkillToAgent: vi.fn(async () => {
        order.push('bind');
        throw new Error(rawReason);
      }),
      rollbackInstalledSkillBinding,
    };
    const reject = vi.fn();
    const logError = vi.fn();
    const onBlocked = vi.fn(async () => undefined);
    const requestPermissionApproval = vi.fn(
      async (_input: { interaction?: unknown }) => ({
        approved: true,
        decidedBy: 'user:approver',
      }),
    );

    await new Promise<void>((resolve) => {
      startSkillPermissionReview({
        deps: {
          requestPermissionApproval,
          sendMessage: vi.fn(async () => undefined),
        },
        responder: { acceptData: vi.fn(), reject },
        logError,
        service,
        syncApprovedCapabilitySettings: vi.fn(async () => undefined),
        appId: 'app:test',
        agentId: 'agent:test',
        sourceAgentFolder: 'main_agent',
        targetJid: 'chat:one',
        skill: {
          name: 'demo-skill',
          requiredEnvVars: ['PRIVATE_TOKEN_NAME'],
        },
        assets: [],
        fileSummaries: [],
        skillMarkdownPreview: {
          path: 'SKILL.md',
          content: '',
          truncated: false,
        },
        totalSizeBytes: 0,
        reason: 'test install',
        requestToolName: 'request_skill_install',
        onBlocked,
        onSettled: resolve,
      } as never);
    });
    await withSkillMaterializationLock(key, async () => {
      order.push('after-settle');
    });

    expect(order).toEqual([
      'install',
      'bind',
      'rollback',
      'concurrent',
      'after-settle',
    ]);
    expect(rollbackInstalledSkillBinding).toHaveBeenCalledWith({
      appId: 'app:test',
      agentId: 'agent:test',
      skillId: 'skill:1',
    });
    expect(onBlocked).toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      'The skill could not be installed. Explain this in plain language and say you can try again after the setup issue is fixed.',
      'permission_review_failed',
    );
    expect(
      (logError.mock.calls[0]?.[0] as { err?: Error } | undefined)?.err
        ?.message,
    ).toBe(rawReason);
    expect(JSON.stringify(reject.mock.calls)).not.toContain(rawReason);
    const interaction =
      requestPermissionApproval.mock.calls[0]?.[0].interaction;
    expect(JSON.stringify(interaction)).toContain('Credential Center');
    expect(JSON.stringify(interaction)).not.toContain('PRIVATE_TOKEN_NAME');
  });
  it('routes denied skill review messages through the originating provider account', async () => {
    const requestPermissionApproval = vi.fn(async () => ({
      approved: false,
      reason: 'not today',
    }));
    const sendMessage = vi.fn(async () => undefined);
    const reject = vi.fn();
    const service = {
      installMaterializationCollisionForAgent: vi.fn(async () => null),
    };

    await new Promise<void>((resolve) => {
      startSkillPermissionReview({
        deps: {
          requestPermissionApproval,
          sendMessage,
        },
        responder: { acceptData: vi.fn(), reject },
        service: service as never,
        syncApprovedCapabilitySettings: vi.fn(async () => undefined),
        appId: 'app:test',
        agentId: 'agent:test',
        sourceAgentFolder: 'main_agent',
        targetJid: 'sl:C123',
        threadId: '171234.567',
        providerAccountId: 'slack_default',
        skill: {
          name: 'demo-skill',
        },
        assets: [],
        fileSummaries: [],
        skillMarkdownPreview: {
          path: 'SKILL.md',
          content: '',
          truncated: false,
        },
        totalSizeBytes: 0,
        reason: 'test install',
        requestToolName: 'request_skill_install',
        onSettled: resolve,
      } as never);
    });

    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        targetJid: 'sl:C123',
        threadId: '171234.567',
        providerAccountId: 'slack_default',
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.stringContaining('demo-skill'),
      {
        threadId: '171234.567',
        providerAccountId: 'slack_default',
        agentId: 'agent:test',
      },
    );
    expect(reject).toHaveBeenCalledWith(
      expect.stringContaining('demo-skill'),
      'permission_denied',
    );
  });

  it('rejects an install-time materialization collision before asking for approval', async () => {
    const collisionMessage =
      'Skill "demo-skill" cannot be installed: it materializes to the same runtime directory "demo-skill" as the currently selected skill legacy (skill:legacy). Rename the skill or unselect the colliding skill first.';
    const service = {
      installMaterializationCollisionForAgent: vi.fn(
        async () => collisionMessage,
      ),
      installSkill: vi.fn(),
      bindSkillToAgent: vi.fn(),
    };
    const reject = vi.fn();
    const requestPermissionApproval = vi.fn();
    const onBlocked = vi.fn(async () => undefined);

    await new Promise<void>((resolve) => {
      startSkillPermissionReview({
        deps: {
          requestPermissionApproval,
          sendMessage: vi.fn(async () => undefined),
        },
        responder: { acceptData: vi.fn(), reject },
        logError: vi.fn(),
        service,
        syncApprovedCapabilitySettings: vi.fn(async () => undefined),
        appId: 'app:test',
        agentId: 'agent:test',
        sourceAgentFolder: 'main_agent',
        targetJid: 'chat:one',
        skill: { name: 'demo-skill' },
        assets: [],
        fileSummaries: [],
        skillMarkdownPreview: {
          path: 'SKILL.md',
          content: '',
          truncated: false,
        },
        totalSizeBytes: 0,
        reason: 'test install',
        requestToolName: 'request_skill_install',
        onBlocked,
        onSettled: resolve,
      } as never);
    });

    expect(
      service.installMaterializationCollisionForAgent,
    ).toHaveBeenCalledWith({
      appId: 'app:test',
      agentId: 'agent:test',
      name: 'demo-skill',
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(service.installSkill).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      collisionMessage,
      'skill_materialization_collision',
    );
  });

  it('rechecks collision identity under the install lock after approval', async () => {
    const collisionMessage =
      'Skill "demo-skill" cannot be installed because a distinct selected skill now owns the same runtime directory.';
    const service = {
      installMaterializationCollisionForAgent: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(collisionMessage),
      installSkill: vi.fn(),
      bindSkillToAgent: vi.fn(),
    };
    const reject = vi.fn();
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'user:approver',
    }));

    await new Promise<void>((resolve) => {
      startSkillPermissionReview({
        deps: {
          requestPermissionApproval,
          sendMessage: vi.fn(async () => undefined),
        },
        responder: { acceptData: vi.fn(), reject },
        logError: vi.fn(),
        service,
        syncApprovedCapabilitySettings: vi.fn(async () => undefined),
        appId: 'app:test',
        agentId: 'agent:test',
        sourceAgentFolder: 'main_agent',
        targetJid: 'chat:one',
        skill: { id: 'skill:requested', name: 'demo-skill' },
        assets: [],
        fileSummaries: [],
        skillMarkdownPreview: {
          path: 'SKILL.md',
          content: '',
          truncated: false,
        },
        totalSizeBytes: 0,
        reason: 'test install',
        requestToolName: 'request_skill_install',
        onSettled: resolve,
      } as never);
    });

    expect(requestPermissionApproval).toHaveBeenCalledOnce();
    expect(
      service.installMaterializationCollisionForAgent,
    ).toHaveBeenNthCalledWith(2, {
      appId: 'app:test',
      agentId: 'agent:test',
      name: 'demo-skill',
      skillId: 'skill:requested',
    });
    expect(service.installSkill).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      collisionMessage,
      'skill_materialization_collision',
    );
  });
});
