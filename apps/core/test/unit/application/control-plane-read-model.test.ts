import { describe, expect, it } from 'vitest';

import {
  buildControlPlaneReadModel,
  formatControlPlaneAgentDetail,
  selectControlPlaneNextAction,
} from '@core/application/control-plane/control-plane-read-model.js';

describe('control plane read model', () => {
  it('uses the documented next-action priority order', () => {
    expect(
      selectControlPlaneNextAction({
        runtimeBlocked: true,
        modelCredentialReady: false,
        providerCounts: { ready: 0, needsConnection: 1, blocked: 0 },
        conversationsReady: 0,
        conversationsTotal: 0,
        accessNeedsApprovalCount: 1,
        blockedJobs: 1,
        memoryStatus: 'Needs review',
      }).kind,
    ).toBe('runtime_blocked');

    expect(
      selectControlPlaneNextAction({
        runtimeBlocked: false,
        modelCredentialReady: false,
        providerCounts: { ready: 0, needsConnection: 1, blocked: 0 },
        conversationsReady: 0,
        conversationsTotal: 0,
        accessNeedsApprovalCount: 1,
        blockedJobs: 1,
        memoryStatus: 'Needs review',
      }).kind,
    ).toBe('missing_model_credential');

    expect(
      selectControlPlaneNextAction({
        runtimeBlocked: false,
        modelCredentialReady: true,
        providerCounts: { ready: 0, needsConnection: 0, blocked: 0 },
        conversationsReady: 0,
        conversationsTotal: 0,
        accessNeedsApprovalCount: 1,
        blockedJobs: 1,
        memoryStatus: 'Needs review',
      }).kind,
    ).toBe('missing_provider_connection');

    expect(
      selectControlPlaneNextAction({
        runtimeBlocked: false,
        modelCredentialReady: true,
        providerCounts: { ready: 0, needsConnection: 1, blocked: 0 },
        conversationsReady: 0,
        conversationsTotal: 0,
        accessNeedsApprovalCount: 1,
        blockedJobs: 1,
        memoryStatus: 'Needs review',
      }).kind,
    ).toBe('missing_provider_connection');

    expect(
      selectControlPlaneNextAction({
        runtimeBlocked: false,
        modelCredentialReady: true,
        providerCounts: { ready: 1, needsConnection: 0, blocked: 0 },
        conversationsReady: 0,
        conversationsTotal: 1,
        accessNeedsApprovalCount: 1,
        blockedJobs: 1,
        memoryStatus: 'Needs review',
      }).kind,
    ).toBe('missing_conversation_install');

    expect(
      selectControlPlaneNextAction({
        runtimeBlocked: false,
        modelCredentialReady: true,
        providerCounts: { ready: 1, needsConnection: 0, blocked: 0 },
        conversationsReady: 1,
        conversationsTotal: 1,
        accessNeedsApprovalCount: 1,
        blockedJobs: 1,
        memoryStatus: 'Needs review',
      }).kind,
    ).toBe('missing_access_approval');

    expect(
      selectControlPlaneNextAction({
        runtimeBlocked: false,
        modelCredentialReady: true,
        providerCounts: { ready: 1, needsConnection: 0, blocked: 0 },
        conversationsReady: 1,
        conversationsTotal: 1,
        accessNeedsApprovalCount: 0,
        blockedJobs: 1,
        memoryStatus: 'Needs review',
      }).kind,
    ).toBe('blocked_job');

    expect(
      selectControlPlaneNextAction({
        runtimeBlocked: false,
        modelCredentialReady: true,
        providerCounts: { ready: 1, needsConnection: 0, blocked: 0 },
        conversationsReady: 1,
        conversationsTotal: 1,
        accessNeedsApprovalCount: 0,
        blockedJobs: 0,
        memoryStatus: 'Needs review',
      }).kind,
    ).toBe('memory_review_setup');
  });

  it('builds agent detail with the same labels as main status', () => {
    const model = buildControlPlaneReadModel({
      workspaceKey: 'default',
      modelCredentialReady: true,
      providers: [{ id: 'telegram', label: 'Telegram', ready: true }],
      conversations: [{ id: 'main_dm', agentId: 'main_agent', ready: true }],
      agents: [
        {
          id: 'main_agent',
          name: 'Default Agent',
          modelAlias: 'opus',
          approvedCapabilities: 2,
        },
      ],
      jobs: [{ id: 'job_1', agentId: 'main_agent', status: 'ready' }],
      approvedAccessCount: 2,
      accessNeedsApprovalCount: 0,
      memoryStatus: 'Ready',
    });

    expect(model.runtime).toBe('Ready');
    expect(formatControlPlaneAgentDetail(model.agentDetails[0]!)).toBe(
      [
        'Agent: Default Agent',
        'Model: opus',
        'Workspace: default',
        'Conversations: 1',
        'Access: 2',
        'Jobs: 1',
        'Memory: Ready',
        'Next action: none',
      ].join('\n'),
    );
  });

  it('surfaces a blocked job as a copy-pasteable resume command with jobId params', () => {
    const model = buildControlPlaneReadModel({
      workspaceKey: 'default',
      modelCredentialReady: true,
      providers: [{ id: 'telegram', label: 'Telegram', ready: true }],
      conversations: [{ id: 'main_dm', agentId: 'main_agent', ready: true }],
      agents: [
        {
          id: 'main_agent',
          name: 'Default Agent',
          modelAlias: 'opus',
          approvedCapabilities: 1,
        },
      ],
      jobs: [{ id: 'job_7', agentId: 'main_agent', status: 'blocked' }],
      approvedAccessCount: 1,
      accessNeedsApprovalCount: 0,
      memoryStatus: 'Ready',
    });

    expect(model.nextAction.kind).toBe('blocked_job');
    expect(model.nextAction.label).toContain('gantry jobs resume job_7');
    expect(model.nextAction.params?.jobId).toBe('job_7');
  });

  it('surfaces a job needing action instead of reporting ready', () => {
    const model = buildControlPlaneReadModel({
      workspaceKey: 'default',
      modelCredentialReady: true,
      providers: [{ id: 'telegram', label: 'Telegram', ready: true }],
      conversations: [{ id: 'main_dm', agentId: 'main_agent', ready: true }],
      agents: [
        {
          id: 'main_agent',
          name: 'Default Agent',
          modelAlias: 'opus',
          approvedCapabilities: 1,
        },
      ],
      jobs: [
        { id: 'job_paused', agentId: 'main_agent', status: 'needs_action' },
      ],
      approvedAccessCount: 1,
      accessNeedsApprovalCount: 0,
      memoryStatus: 'Ready',
    });

    expect(model.jobs).toEqual({ ready: 0, needsAction: 1, blocked: 0 });
    expect(model.runtime).toBe('Blocked');
    expect(model.nextAction).toMatchObject({
      kind: 'blocked_job',
      params: { jobId: 'job_paused' },
    });
  });

  it('uses model credential readiness for agent detail next action', () => {
    const model = buildControlPlaneReadModel({
      workspaceKey: 'default',
      modelCredentialReady: false,
      providers: [{ id: 'telegram', label: 'Telegram', ready: true }],
      conversations: [{ id: 'main_dm', agentId: 'main_agent', ready: true }],
      agents: [
        {
          id: 'main_agent',
          name: 'Default Agent',
          modelAlias: 'opus',
          approvedCapabilities: 0,
        },
      ],
      jobs: [],
      approvedAccessCount: 0,
      accessNeedsApprovalCount: 0,
      memoryStatus: 'Ready',
    });

    expect(model.agents).toEqual({ ready: 0, total: 1 });
    expect(model.agentDetails[0]?.nextAction).toMatchObject({
      kind: 'missing_model_credential',
      label:
        'Run `gantry credentials model set <provider>` to connect model access.',
    });
  });

  it('uses pending access approvals for agent detail next action', () => {
    const model = buildControlPlaneReadModel({
      workspaceKey: 'default',
      modelCredentialReady: true,
      providers: [{ id: 'telegram', label: 'Telegram', ready: true }],
      conversations: [{ id: 'main_dm', agentId: 'main_agent', ready: true }],
      agents: [
        {
          id: 'main_agent',
          name: 'Default Agent',
          modelAlias: 'opus',
          approvedCapabilities: 1,
        },
      ],
      jobs: [],
      approvedAccessCount: 1,
      accessNeedsApprovalCount: 2,
      memoryStatus: 'Ready',
    });

    expect(model.agentDetails[0]?.nextAction).toMatchObject({
      kind: 'missing_access_approval',
      label:
        'Approve or deny the pending access prompt in its source conversation.',
    });
  });
});
