import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  configureSetupPausePermissionPrompt,
  raiseSetupPausePermissionPrompt,
  retireSetupPausePermissionPrompt,
  setupPausePermissionRequestId,
  type SetupPausePermissionPromptDeps,
} from '@core/application/jobs/setup-pause-permission-prompt.js';
import { JobManagementService } from '@core/application/jobs/job-management-service.js';
import {
  appendSetupPauseRequirementAfterPersistentGrant,
  setupPauseGrantIsCurrent,
  setupPausePersistentGrantIsCurrent,
} from '@core/app/bootstrap/setup-pause-permission-wiring.js';
import { runDurablePermissionInteraction } from '@core/application/interactions/durable-interaction-handler.js';
import { applyRecoveredPersistentPermissionGrant } from '@core/application/interactions/pending-interaction-permission-recovery.js';
import {
  requestPermissionReviewSuggestions,
  requestPermissionSetupDecisionOptions,
} from '@core/jobs/request-permission-review.js';
import { notifyJobSetupRequired } from '@core/jobs/execution-readiness.js';
import { runtimeJobSchedulePlanner } from '@core/jobs/job-schedule-planner.js';
import type { RuntimeJobRepository } from '@core/domain/repositories/ops-repo.js';
import type {
  Job,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '@core/domain/types.js';

afterEach(() => {
  configureSetupPausePermissionPrompt(null);
});

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Lead maintenance',
    prompt: 'Append qualified leads.',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    status: 'paused',
    session_id: null,
    thread_id: null,
    workspace_key: 'main_agent',
    created_by: 'human',
    created_at: '2026-08-05T00:00:00.000Z',
    updated_at: '2026-08-05T00:00:00.000Z',
    next_run: null,
    last_run: null,
    silent: false,
    cleanup_after_ms: 0,
    timeout_ms: 60_000,
    max_retries: 0,
    retry_backoff_ms: 1_000,
    max_consecutive_failures: 3,
    consecutive_failures: 0,
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: 'Setup required',
    execution_context: {
      conversationJid: 'sl:approver',
      threadId: 'approval-thread',
      workspaceKey: 'main_agent',
    },
    notification_routes: [
      {
        conversationJid: 'sl:job-notifications',
        threadId: null,
        label: 'Job notifications',
      },
    ],
    access_requirements: [
      {
        target: {
          kind: 'capability',
          capabilityId: 'salesforce.leads.append',
        },
        reason: 'Append qualified leads.',
      },
    ],
    setup_state: {
      state: 'missing_capability',
      checked_at: '2026-08-05T00:00:00.000Z',
      fingerprint: 'fingerprint-1',
      blockers: [
        {
          state: 'missing_capability',
          requirementType: 'semantic_capability',
          requirementId: 'salesforce.leads.append',
          grantable: true,
          message: 'Capability missing.',
          nextAction: 'Approve the reviewed capability.',
        },
      ],
    },
    ...overrides,
  };
}

function permanentDecision(): PermissionApprovalDecision {
  return {
    approved: true,
    mode: 'allow_persistent_rule',
    decidedBy: 'owner-1',
    decisionClassification: 'user_permanent',
    updatedPermissions: [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'capability:salesforce.leads.append' }],
      },
    ],
  };
}

function cancelledDecision(): PermissionApprovalDecision {
  return { approved: false, mode: 'cancel', decidedBy: 'owner-1' };
}

function configure(input: {
  appId?: string;
  job: () => Job | undefined;
  runPermissionInteraction?: SetupPausePermissionPromptDeps['runPermissionInteraction'];
  requestPermissionApproval?: (
    request: PermissionApprovalRequest,
    onPromptDelivered: (messageId: string) => void,
  ) => Promise<PermissionApprovalDecision>;
  cancelPermissionApproval?: SetupPausePermissionPromptDeps['cancelPermissionApproval'];
  reviewStoredRequirement?: SetupPausePermissionPromptDeps['reviewStoredRequirement'];
  resolveProviderAccountId?: SetupPausePermissionPromptDeps['resolveProviderAccountId'];
}) {
  const requestPermissionApproval =
    input.requestPermissionApproval ??
    (async (
      _request: PermissionApprovalRequest,
      onPromptDelivered: (messageId: string) => void,
    ) => {
      onPromptDelivered('prompt-1');
      return permanentDecision();
    });
  const deps: SetupPausePermissionPromptDeps = {
    appId: input.appId ?? 'default',
    getJobById: async () => input.job(),
    runPermissionInteraction:
      input.runPermissionInteraction ??
      (async (request, onPromptDelivered, onInteractionBegan) => {
        onInteractionBegan();
        return {
          began: true,
          decision: await requestPermissionApproval(request, onPromptDelivered),
          resolved: true,
        };
      }),
    cancelPermissionApproval:
      input.cancelPermissionApproval ?? (async () => 'not_found'),
    reviewStoredRequirement:
      input.reviewStoredRequirement ??
      (async () => ({
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'capability:salesforce.leads.append' }],
          },
        ],
        decisionOptions: ['allow_once', 'allow_persistent_rule', 'cancel'],
      })),
    ...(input.resolveProviderAccountId
      ? { resolveProviderAccountId: input.resolveProviderAccountId }
      : {}),
  };
  configureSetupPausePermissionPrompt(deps);
  return deps;
}

describe('setup pause prompts', () => {
  it('a non-grantable denial is never turned into an approval candidate', async () => {
    const job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-08T00:00:00.000Z',
        fingerprint: 'protected-browser-denial',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'browser',
            requirementId: 'Browser',
            grantable: false,
            message: 'Protected browser access was denied.',
            nextAction: 'Ask an operator to configure this worker manually.',
          },
        ],
      },
    });
    const reviewStoredRequirement = vi.fn();
    const runPermissionInteraction = vi.fn();
    configure({
      job: () => job,
      reviewStoredRequirement,
      runPermissionInteraction,
    });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toEqual({
      status: 'instruction_only',
      notificationEligible: true,
    });
    expect(reviewStoredRequirement).not.toHaveBeenCalled();
    expect(runPermissionInteraction).not.toHaveBeenCalled();
  });

  it('a blocker with undefined grantability is instruction-only', async () => {
    const job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-08T00:00:00.000Z',
        fingerprint: 'legacy-browser-denial',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'browser',
            requirementId: 'Browser',
            message: 'Browser access was denied.',
            nextAction: 'Approve lasting Browser access.',
          },
        ],
      },
    });
    const reviewStoredRequirement = vi.fn();
    const runPermissionInteraction = vi.fn();
    configure({
      job: () => job,
      reviewStoredRequirement,
      runPermissionInteraction,
    });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toEqual({
      status: 'instruction_only',
      notificationEligible: true,
    });
    expect(reviewStoredRequirement).not.toHaveBeenCalled();
    expect(runPermissionInteraction).not.toHaveBeenCalled();
  });

  it('an MCP-server denial is instruction-only', async () => {
    const job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-08T00:00:00.000Z',
        fingerprint: 'mcp-server-denial',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'tool',
            requirementId: 'mcp__customer_records__append',
            grantable: false,
            message: 'The MCP server is not configured.',
            nextAction: 'request_mcp_server {"serverName":"customer-records"}',
          },
        ],
      },
    });
    const reviewStoredRequirement = vi.fn();
    const runPermissionInteraction = vi.fn();
    configure({
      job: () => job,
      reviewStoredRequirement,
      runPermissionInteraction,
    });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toMatchObject({ status: 'instruction_only' });
    expect(reviewStoredRequirement).not.toHaveBeenCalled();
    expect(runPermissionInteraction).not.toHaveBeenCalled();
  });

  it('keeps the instruction-only path available when runtime wiring is absent', async () => {
    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: 'job-1',
        setupFingerprint: 'fingerprint-1',
      }),
    ).resolves.toEqual({ status: 'instruction_only' });

    await expect(
      retireSetupPausePermissionPrompt({
        job: makeJob(),
        reason: 'The job was deleted.',
      }),
    ).resolves.toBeUndefined();
  });

  it("raises one standard permission prompt from the job's stored requirement and settles through the existing grant chain", async () => {
    const job = makeJob();
    let request: PermissionApprovalRequest | undefined;
    const settlementOrder: string[] = [];
    const runPermissionInteraction = vi.fn(async (input, delivered, began) => {
      request = input;
      began();
      delivered('prompt-1');
      settlementOrder.push('persistRequestPermissionRules');
      settlementOrder.push('recheckSetupPausedJobsAfterCapabilityUpdate');
      return { began: true, decision: permanentDecision(), resolved: true };
    });
    configure({ job: () => job, runPermissionInteraction });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toMatchObject({
      status: 'raised',
      approverRoute: {
        conversationJid: 'sl:approver',
        threadId: 'approval-thread',
      },
    });

    expect(runPermissionInteraction).toHaveBeenCalledOnce();
    expect(request).toMatchObject({
      jobId: 'job-1',
      targetJid: 'sl:approver',
      threadId: 'approval-thread',
      toolName: 'request_permission',
      toolInput: {
        capabilityId: 'salesforce.leads.append',
        capabilityRequestSource: 'request_access',
      },
      decisionOptions: ['allow_persistent_rule', 'cancel'],
    });
    expect(request?.runId).toBeUndefined();
    expect(request?.decisionReason).toContain(
      'Failed action: Start the scheduled run',
    );
    expect(request?.decisionReason).toContain(
      'Triggering step: Pre-run setup check',
    );
    expect(request?.decisionReason).toContain(
      'Run outcome: Died — setup was checked before execution; this run did not start.',
    );
    expect(request?.decisionReason).toContain('Blockers (1):');
    expect(request?.description).toContain('Allow once is unavailable');
    expect(settlementOrder).toEqual([
      'persistRequestPermissionRules',
      'recheckSetupPausedJobsAfterCapabilityUpdate',
    ]);
    expect(request?.decisionOptions).not.toContain('allow_once');
    expect(
      requestPermissionSetupDecisionOptions({
        permissionKind: 'tool',
        toolName: 'Browser',
      }),
    ).toContain('allow_once');
  });

  it('an under-declared grantable denial offers one-tap approve that adds the job requirement and grants the agent', async () => {
    let job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'under-declared-browser',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'browser',
            requirementId: 'Browser',
            grantable: true,
            message: 'Browser access was denied.',
            nextAction: 'Approve lasting Browser access.',
          },
        ],
      },
    });
    const appendJobAccessRequirement = vi.fn(async (input) => {
      if (input.expectedUpdatedAt !== job.updated_at) return false;
      job = {
        ...job,
        access_requirements: [
          ...(job.access_requirements ?? []),
          input.requirement,
        ],
        updated_at: '2026-08-05T00:00:01.000Z',
      };
      return true;
    });
    const resumeSetupPausedJob = vi.fn(async () => true);
    const requestSchedulerSync = vi.fn();
    const bindings: Record<string, unknown>[] = [];
    const browserTool = {
      id: 'tool:Browser',
      appId: 'default',
      name: 'Browser',
      kind: 'browser',
      provider: 'gantry',
      displayName: 'Browser',
      category: 'agent',
      risk: 'medium',
      selectable: true,
      status: 'active',
      adapterRef: 'browser',
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    };
    const toolRepository = {
      listTools: vi.fn(async () => [browserTool]),
      getTool: vi.fn(async () => browserTool),
      listAgentToolBindings: vi.fn(async () => bindings),
      saveAgentToolBinding: vi.fn(async (binding) => {
        bindings.push(binding);
      }),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const opsRepository = {
      getJobById: vi.fn(async () => job),
      appendJobAccessRequirement,
      resumeSetupPausedJob,
      refreshSetupPausedJob: vi.fn(async () => false),
    };
    let request: PermissionApprovalRequest | undefined;
    configure({
      job: () => job,
      reviewStoredRequirement: async ({ toolInput }) => {
        const suggestions = requestPermissionReviewSuggestions(toolInput);
        return suggestions
          ? {
              suggestions,
              decisionOptions: requestPermissionSetupDecisionOptions(toolInput),
            }
          : null;
      },
      requestPermissionApproval: async (input, delivered) => {
        request = input;
        delivered('prompt-1');
        return cancelledDecision();
      },
    });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
        source: 'permission_denied',
      }),
    ).resolves.toMatchObject({ status: 'raised' });

    expect(request).toMatchObject({
      decisionOptions: ['allow_persistent_rule', 'cancel'],
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Browser' }],
        },
      ],
    });
    expect(appendJobAccessRequirement).not.toHaveBeenCalled();

    const decision: PermissionApprovalDecision = {
      approved: true,
      mode: 'allow_persistent_rule',
      decidedBy: 'owner-1',
      decisionClassification: 'user_permanent',
      updatedPermissions: request!.suggestions,
    };
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);
    await expect(
      applyRecoveredPersistentPermissionGrant({
        persistence: {
          opsRepository: opsRepository as never,
          beforePersistentGrant: (candidate, effectiveUpdates) =>
            setupPausePersistentGrantIsCurrent(
              opsRepository as never,
              candidate,
              effectiveUpdates,
            ),
          afterPersistentGrant: (candidate, effectiveUpdates) =>
            appendSetupPauseRequirementAfterPersistentGrant(
              opsRepository as never,
              candidate,
              effectiveUpdates,
            ),
          getToolRepository: () => toolRepository as never,
          mirrorAgentToolRulesToSettings,
          onSchedulerChanged: requestSchedulerSync,
        },
        request: request!,
        sourceAgentFolder: 'main_agent',
        decision,
      }),
    ).resolves.toBe(true);

    expect(job.access_requirements).toEqual([
      expect.objectContaining({
        target: { kind: 'tool_rule', rule: 'Browser' },
      }),
    ]);
    expect(appendJobAccessRequirement).toHaveBeenCalledWith({
      jobId: job.id,
      requirement: expect.objectContaining({
        target: { kind: 'tool_rule', rule: 'Browser' },
      }),
      expectedUpdatedAt: '2026-08-05T00:00:00.000Z',
    });
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['Browser'],
      { appId: 'default' },
    );
    expect(resumeSetupPausedJob).toHaveBeenCalledOnce();
    expect(requestSchedulerSync).toHaveBeenCalledWith(job.id);
  });

  it('settles and resumes when the requirement append loses its CAS after the grant committed', async () => {
    const job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'under-declared-browser',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'browser',
            requirementId: 'Browser',
            grantable: true,
            message: 'Browser access was denied.',
            nextAction: 'Approve lasting Browser access.',
          },
        ],
      },
    });
    // The durable grant commits, but every append attempt loses its CAS race.
    const appendJobAccessRequirement = vi.fn(async () => false);
    const resumeSetupPausedJob = vi.fn(async () => true);
    const requestSchedulerSync = vi.fn();
    const bindings: Record<string, unknown>[] = [];
    const browserTool = {
      id: 'tool:Browser',
      appId: 'default',
      name: 'Browser',
      kind: 'browser',
      provider: 'gantry',
      displayName: 'Browser',
      category: 'agent',
      risk: 'medium',
      selectable: true,
      status: 'active',
      adapterRef: 'browser',
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    };
    const toolRepository = {
      listTools: vi.fn(async () => [browserTool]),
      getTool: vi.fn(async () => browserTool),
      listAgentToolBindings: vi.fn(async () => bindings),
      saveAgentToolBinding: vi.fn(async (binding) => {
        bindings.push(binding);
      }),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const opsRepository = {
      getJobById: vi.fn(async () => job),
      appendJobAccessRequirement,
      resumeSetupPausedJob,
      refreshSetupPausedJob: vi.fn(async () => false),
    };
    const request = {
      requestId: 'setup-pause:job-1:under-declared-browser',
      appId: 'default',
      agentId: 'agent:main_agent',
      sourceAgentFolder: 'main_agent',
      jobId: job.id,
      toolName: 'request_permission',
      suggestions: [
        { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Browser' }] },
      ],
    } as unknown as PermissionApprovalRequest;
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

    await expect(
      applyRecoveredPersistentPermissionGrant({
        persistence: {
          opsRepository: opsRepository as never,
          beforePersistentGrant: (candidate, effectiveUpdates) =>
            setupPausePersistentGrantIsCurrent(
              opsRepository as never,
              candidate,
              effectiveUpdates,
            ),
          afterPersistentGrant: (candidate, effectiveUpdates) =>
            appendSetupPauseRequirementAfterPersistentGrant(
              opsRepository as never,
              candidate,
              effectiveUpdates,
            ),
          getToolRepository: () => toolRepository as never,
          mirrorAgentToolRulesToSettings,
          onSchedulerChanged: requestSchedulerSync,
        },
        request,
        sourceAgentFolder: 'main_agent',
        decision: {
          approved: true,
          mode: 'allow_persistent_rule',
          decidedBy: 'owner-1',
          decisionClassification: 'user_permanent',
          updatedPermissions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'Browser' }],
            },
          ],
        },
      }),
    ).resolves.toBe(true);

    // Grant committed, append lost its race — the interaction still settles and
    // the paused job is rechecked/resumed rather than stranded.
    expect(appendJobAccessRequirement).toHaveBeenCalled();
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['Browser'],
      { appId: 'default' },
    );
    expect(resumeSetupPausedJob).toHaveBeenCalledOnce();
  });

  it('settles and resumes when the requirement append throws after the grant committed', async () => {
    const job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'under-declared-browser',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'browser',
            requirementId: 'Browser',
            grantable: true,
            message: 'Browser access was denied.',
            nextAction: 'Approve lasting Browser access.',
          },
        ],
      },
    });
    // The durable grant commits, then the append hits a transient repo error.
    const appendJobAccessRequirement = vi.fn(async () => {
      throw new Error('job store unavailable');
    });
    const resumeSetupPausedJob = vi.fn(async () => true);
    const requestSchedulerSync = vi.fn();
    const bindings: Record<string, unknown>[] = [];
    const browserTool = {
      id: 'tool:Browser',
      appId: 'default',
      name: 'Browser',
      kind: 'browser',
      provider: 'gantry',
      displayName: 'Browser',
      category: 'agent',
      risk: 'medium',
      selectable: true,
      status: 'active',
      adapterRef: 'browser',
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    };
    const toolRepository = {
      listTools: vi.fn(async () => [browserTool]),
      getTool: vi.fn(async () => browserTool),
      listAgentToolBindings: vi.fn(async () => bindings),
      saveAgentToolBinding: vi.fn(async (binding) => {
        bindings.push(binding);
      }),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const opsRepository = {
      getJobById: vi.fn(async () => job),
      appendJobAccessRequirement,
      resumeSetupPausedJob,
      refreshSetupPausedJob: vi.fn(async () => false),
    };
    const request = {
      requestId: 'setup-pause:job-1:under-declared-browser',
      appId: 'default',
      agentId: 'agent:main_agent',
      sourceAgentFolder: 'main_agent',
      jobId: job.id,
      toolName: 'request_permission',
    } as unknown as PermissionApprovalRequest;
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

    await expect(
      applyRecoveredPersistentPermissionGrant({
        persistence: {
          opsRepository: opsRepository as never,
          beforePersistentGrant: (candidate, effectiveUpdates) =>
            setupPausePersistentGrantIsCurrent(
              opsRepository as never,
              candidate,
              effectiveUpdates,
            ),
          afterPersistentGrant: (candidate, effectiveUpdates) =>
            appendSetupPauseRequirementAfterPersistentGrant(
              opsRepository as never,
              candidate,
              effectiveUpdates,
            ),
          getToolRepository: () => toolRepository as never,
          mirrorAgentToolRulesToSettings,
          onSchedulerChanged: requestSchedulerSync,
        },
        request,
        sourceAgentFolder: 'main_agent',
        decision: {
          approved: true,
          mode: 'allow_persistent_rule',
          decidedBy: 'owner-1',
          decisionClassification: 'user_permanent',
          updatedPermissions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'Browser' }],
            },
          ],
        },
      }),
    ).resolves.toBe(true);

    // A throwing append must not escape and strand the already-granted job.
    expect(appendJobAccessRequirement).toHaveBeenCalled();
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['Browser'],
      { appId: 'default' },
    );
    expect(resumeSetupPausedJob).toHaveBeenCalledOnce();
  });

  it('a failing permission grant does not append the job requirement', async () => {
    const job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'under-declared-browser',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'browser',
            requirementId: 'Browser',
            grantable: true,
            message: 'Browser access was denied.',
            nextAction: 'Approve lasting Browser access.',
          },
        ],
      },
    });
    const appendJobAccessRequirement = vi.fn(async () => true);
    const browserTool = {
      id: 'tool:Browser',
      appId: 'default',
      name: 'Browser',
      kind: 'browser',
      provider: 'gantry',
      displayName: 'Browser',
      category: 'agent',
      risk: 'medium',
      selectable: true,
      status: 'active',
      adapterRef: 'browser',
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    };
    const toolRepository = {
      listTools: vi.fn(async () => [browserTool]),
      getTool: vi.fn(async () => browserTool),
      listAgentToolBindings: vi.fn(async () => []),
      saveAgentToolBinding: vi.fn(async () => {
        throw new Error('binding store unavailable');
      }),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const repository = {
      getJobById: vi.fn(async () => job),
      appendJobAccessRequirement,
    };
    const request = {
      requestId: 'setup-pause:job-1:under-declared-browser',
      appId: 'default',
      agentId: 'agent:main_agent',
      sourceAgentFolder: 'main_agent',
      jobId: job.id,
      toolName: 'request_permission',
    } as PermissionApprovalRequest;

    await expect(
      applyRecoveredPersistentPermissionGrant({
        persistence: {
          opsRepository: repository as never,
          beforePersistentGrant: (candidate, effectiveUpdates) =>
            setupPausePersistentGrantIsCurrent(
              repository as never,
              candidate,
              effectiveUpdates,
            ),
          afterPersistentGrant: (candidate, effectiveUpdates) =>
            appendSetupPauseRequirementAfterPersistentGrant(
              repository as never,
              candidate,
              effectiveUpdates,
            ),
          getToolRepository: () => toolRepository as never,
          mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
        },
        request,
        sourceAgentFolder: 'main_agent',
        decision: {
          approved: true,
          mode: 'allow_persistent_rule',
          decidedBy: 'owner-1',
          decisionClassification: 'user_permanent',
          updatedPermissions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'Browser' }],
            },
          ],
        },
      }),
    ).rejects.toThrow('binding store unavailable');

    expect(appendJobAccessRequirement).not.toHaveBeenCalled();
    expect(job.access_requirements).toEqual([]);
  });

  it('an under-declared scoped RunCommand denial offers one-tap approve built from the recovery action', async () => {
    let job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-08T00:00:00.000Z',
        fingerprint: 'under-declared-run-command',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'tool',
            requirementId: 'RunCommand',
            grantable: true,
            message: 'Scoped command access was denied.',
            nextAction:
              'request_access {"target":{"kind":"run_command","argvPattern":"npm test *"},"temporaryOnly":false,"reason":"This autonomous run needs scoped command access."}',
          },
        ],
      },
    });
    const appendJobAccessRequirement = vi.fn(async (input) => {
      if (input.expectedUpdatedAt !== job.updated_at) return false;
      job = {
        ...job,
        access_requirements: [
          ...(job.access_requirements ?? []),
          input.requirement,
        ],
        updated_at: '2026-08-08T00:00:01.000Z',
      };
      return true;
    });
    const resumeSetupPausedJob = vi.fn(async () => true);
    const requestSchedulerSync = vi.fn();
    const tools: Record<string, unknown>[] = [];
    const bindings: Record<string, unknown>[] = [];
    const toolRepository = {
      listTools: vi.fn(async () => tools),
      getTool: vi.fn(
        async (toolId) => tools.find((tool) => tool.id === toolId) ?? null,
      ),
      saveTool: vi.fn(async (tool) => {
        tools.push(tool);
      }),
      listAgentToolBindings: vi.fn(async () => bindings),
      saveAgentToolBinding: vi.fn(async (binding) => {
        bindings.push(binding);
      }),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const opsRepository = {
      getJobById: vi.fn(async () => job),
      appendJobAccessRequirement,
      resumeSetupPausedJob,
      refreshSetupPausedJob: vi.fn(async () => false),
    };
    let request: PermissionApprovalRequest | undefined;
    configure({
      job: () => job,
      reviewStoredRequirement: async ({ toolInput }) => {
        const suggestions = requestPermissionReviewSuggestions(toolInput);
        return suggestions
          ? {
              suggestions,
              decisionOptions: requestPermissionSetupDecisionOptions(toolInput),
            }
          : null;
      },
      requestPermissionApproval: async (input, delivered) => {
        request = input;
        delivered('prompt-1');
        return cancelledDecision();
      },
    });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
        source: 'permission_denied',
      }),
    ).resolves.toMatchObject({ status: 'raised' });

    expect(request).toMatchObject({
      decisionOptions: ['allow_persistent_rule', 'cancel'],
      toolInput: {
        permissionKind: 'tool',
        toolName: 'RunCommand',
        rule: 'npm test *',
      },
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'RunCommand', ruleContent: 'npm test *' }],
        },
      ],
    });
    expect(appendJobAccessRequirement).not.toHaveBeenCalled();

    await expect(
      applyRecoveredPersistentPermissionGrant({
        persistence: {
          opsRepository: opsRepository as never,
          beforePersistentGrant: (candidate, effectiveUpdates) =>
            setupPausePersistentGrantIsCurrent(
              opsRepository as never,
              candidate,
              effectiveUpdates,
            ),
          afterPersistentGrant: (candidate, effectiveUpdates) =>
            appendSetupPauseRequirementAfterPersistentGrant(
              opsRepository as never,
              candidate,
              effectiveUpdates,
            ),
          getToolRepository: () => toolRepository as never,
          mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
          onSchedulerChanged: requestSchedulerSync,
        },
        request: request!,
        sourceAgentFolder: 'main_agent',
        decision: {
          approved: true,
          mode: 'allow_persistent_rule',
          decidedBy: 'owner-1',
          decisionClassification: 'user_permanent',
          updatedPermissions: request!.suggestions,
        },
      }),
    ).resolves.toBe(true);

    expect(job.access_requirements).toEqual([
      expect.objectContaining({
        target: { kind: 'tool_rule', rule: 'RunCommand(npm test *)' },
      }),
    ]);
    expect(appendJobAccessRequirement).toHaveBeenCalledWith({
      jobId: job.id,
      requirement: expect.objectContaining({
        target: { kind: 'tool_rule', rule: 'RunCommand(npm test *)' },
      }),
      expectedUpdatedAt: '2026-08-05T00:00:00.000Z',
    });
    expect(toolRepository.saveTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'RunCommand(npm test *)' }),
    );
    expect(toolRepository.saveAgentToolBinding).toHaveBeenCalledOnce();
    expect(resumeSetupPausedJob).toHaveBeenCalledOnce();
    expect(requestSchedulerSync).toHaveBeenCalledWith(job.id);
  });

  it('matches an under-declared requirement to the effective grant selected by the approver', async () => {
    const job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'under-declared-browser',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'browser',
            requirementId: 'Browser',
            grantable: true,
            message: 'Browser access was denied.',
            nextAction: 'Approve lasting Browser access.',
          },
        ],
      },
    });
    const appendJobAccessRequirement = vi.fn(async () => true);
    const mirrorAgentToolRulesToSettings = vi.fn();
    const request = {
      requestId: 'setup-pause:job-1:under-declared-browser',
      appId: 'default',
      agentId: 'agent:main_agent',
      sourceAgentFolder: 'main_agent',
      jobId: job.id,
      toolName: 'request_permission',
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Browser' }],
        },
      ],
    } as PermissionApprovalRequest;

    await expect(
      applyRecoveredPersistentPermissionGrant({
        persistence: {
          opsRepository: {
            getJobById: vi.fn(async () => job),
            appendJobAccessRequirement,
          } as never,
          beforePersistentGrant: (candidate, effectiveUpdates) =>
            setupPausePersistentGrantIsCurrent(
              { getJobById: vi.fn(async () => job) } as never,
              candidate,
              effectiveUpdates,
            ),
          afterPersistentGrant: (candidate, effectiveUpdates) =>
            appendSetupPauseRequirementAfterPersistentGrant(
              {
                getJobById: vi.fn(async () => job),
                appendJobAccessRequirement,
              } as never,
              candidate,
              effectiveUpdates,
            ),
          getToolRepository: () => ({}) as never,
          mirrorAgentToolRulesToSettings,
        },
        request,
        sourceAgentFolder: 'main_agent',
        decision: {
          approved: true,
          mode: 'allow_persistent_rule',
          decidedBy: 'owner-1',
          decisionClassification: 'user_permanent',
          updatedPermissions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'FileRead' }],
            },
          ],
        },
      }),
    ).resolves.toBe(false);

    expect(appendJobAccessRequirement).not.toHaveBeenCalled();
    expect(mirrorAgentToolRulesToSettings).not.toHaveBeenCalled();
  });

  it('re-reads and retries the requirement append after an updated_at conflict without losing a concurrent requirement', async () => {
    let job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'under-declared-browser',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'browser',
            requirementId: 'Browser',
            grantable: true,
            message: 'Browser access was denied.',
            nextAction: 'Approve lasting Browser access.',
          },
        ],
      },
    });
    const concurrentRequirement = {
      target: { kind: 'tool_rule' as const, rule: 'FileRead' },
      reason: 'Added concurrently by the operator.',
    };
    const appendJobAccessRequirement = vi.fn(async (input) => {
      if (appendJobAccessRequirement.mock.calls.length === 1) {
        job = {
          ...job,
          access_requirements: [concurrentRequirement],
          updated_at: '2026-08-05T00:00:01.000Z',
        };
        return false;
      }
      expect(input.expectedUpdatedAt).toBe('2026-08-05T00:00:01.000Z');
      job = {
        ...job,
        access_requirements: [
          ...(job.access_requirements ?? []),
          input.requirement,
        ],
      };
      return true;
    });
    const request = {
      requestId: 'setup-pause:job-1:under-declared-browser',
      jobId: job.id,
    } as PermissionApprovalRequest;
    const browserGrant = [
      {
        type: 'addRules' as const,
        behavior: 'allow' as const,
        rules: [{ toolName: 'Browser' }],
      },
    ];

    await expect(
      appendSetupPauseRequirementAfterPersistentGrant(
        {
          getJobById: vi.fn(async () => job),
          appendJobAccessRequirement,
        } as never,
        request,
        browserGrant,
      ),
    ).resolves.toBe(true);

    expect(appendJobAccessRequirement).toHaveBeenCalledTimes(2);
    expect(job.access_requirements).toEqual([
      concurrentRequirement,
      expect.objectContaining({
        target: { kind: 'tool_rule', rule: 'Browser' },
      }),
    ]);
  });

  it('keeps an under-declared non-grantable denial instruction-only', async () => {
    const job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'under-declared-unscoped-command',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'tool',
            requirementId: 'RunCommand',
            grantable: false,
            message: 'Unscoped command access was denied.',
            nextAction: 'Declare a reviewed scoped command.',
          },
        ],
      },
    });
    const runPermissionInteraction = vi.fn();
    const reviewStoredRequirement = vi.fn();
    configure({
      job: () => job,
      runPermissionInteraction,
      reviewStoredRequirement,
    });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toEqual({
      status: 'instruction_only',
      notificationEligible: true,
    });
    expect(reviewStoredRequirement).not.toHaveBeenCalled();
    expect(runPermissionInteraction).not.toHaveBeenCalled();
  });

  it('same fingerprint does not re-prompt and a changed blocker set retires the old prompt', async () => {
    let job = makeJob();
    const pending = new Set<string>();
    const providerPrompt = vi.fn();
    const runPermissionInteraction = vi.fn(
      async (
        request: PermissionApprovalRequest,
        delivered: (messageId: string) => void,
        began: () => void,
      ) => {
        if (pending.has(request.requestId)) {
          return {
            began: false,
            decision: cancelledDecision(),
            resolved: false,
          };
        }
        pending.add(request.requestId);
        began();
        providerPrompt(request.requestId);
        delivered(`prompt:${request.requestId}`);
        return new Promise<never>(() => undefined);
      },
    );
    const cancelPermissionApproval = vi.fn(async (cancellation) => {
      pending.delete(cancellation.requestId);
      return 'settled' as const;
    });
    configure({
      job: () => job,
      runPermissionInteraction,
      cancelPermissionApproval,
    });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toMatchObject({ status: 'raised' });
    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toMatchObject({ status: 'already_pending' });
    expect(providerPrompt).toHaveBeenCalledTimes(1);

    job = {
      ...job,
      setup_state: { ...job.setup_state!, fingerprint: 'fingerprint-2' },
    };
    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
        previousFingerprint: 'fingerprint-1',
      }),
    ).resolves.toMatchObject({ status: 'raised' });
    expect(cancelPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: setupPausePermissionRequestId('job-1', 'fingerprint-1'),
      }),
    );
    expect(providerPrompt).toHaveBeenCalledTimes(2);

    await retireSetupPausePermissionPrompt({
      job,
      reason: 'The job was deleted.',
    });
    expect(cancelPermissionApproval).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestId: setupPausePermissionRequestId('job-1', 'fingerprint-2'),
        reason: 'The job was deleted.',
      }),
    );
  });

  it('keeps unmappable blockers on the instruction-only path', async () => {
    const job = makeJob({
      access_requirements: [
        { target: { kind: 'mcp_server', server: 'customer-records' } },
      ],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'mcp-only',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'mcp_server',
            requirementId: 'customer-records',
            message: 'Server missing.',
            nextAction: 'Connect the server.',
          },
        ],
      },
    });
    const runPermissionInteraction = vi.fn();
    configure({ job: () => job, runPermissionInteraction });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toEqual({
      status: 'instruction_only',
      notificationEligible: true,
    });
    expect(runPermissionInteraction).not.toHaveBeenCalled();
  });

  it('keeps config blockers on the instruction-only path', async () => {
    const job = makeJob({
      access_requirements: [
        { target: { kind: 'tool_rule', rule: 'RunCommand(npm test *)' } },
      ],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'config-only',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'config' as never,
            requirementId: 'RunCommand(npm test *)',
            message: 'Configuration is missing.',
            nextAction: 'Configure the runtime.',
          },
        ],
      },
    });
    const runPermissionInteraction = vi.fn();
    configure({ job: () => job, runPermissionInteraction });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toEqual({
      status: 'instruction_only',
      notificationEligible: true,
    });
    expect(runPermissionInteraction).not.toHaveBeenCalled();
  });

  it('marks a delivered instruction card for a genuinely non-grantable blocker', async () => {
    const job = makeJob({
      access_requirements: [
        { target: { kind: 'mcp_server', server: 'customer-records' } },
      ],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'mcp-only',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'mcp_server',
            requirementId: 'customer-records',
            message: 'Server missing.',
            nextAction: 'Connect the server.',
          },
        ],
      },
    });
    configure({ job: () => job });
    const sendMessage = vi.fn(async () => undefined);
    const markJobSetupNotified = vi.fn(async () => true);

    await expect(
      notifyJobSetupRequired({
        currentJob: job,
        runtimeAppId: 'default',
        setupState: job.setup_state!,
        deps: {
          sendMessage,
          opsRepository: { markJobSetupNotified },
        } as never,
        publishRuntimeEvent: async () => undefined,
      }),
    ).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalled();
    expect(markJobSetupNotified).toHaveBeenCalledWith(job.id, 'mcp-only');
  });

  it('retires the previous prompt before an unmappable replacement returns instruction-only', async () => {
    const job = makeJob({
      access_requirements: [
        { target: { kind: 'mcp_server', server: 'customer-records' } },
      ],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'mcp-only',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'mcp_server',
            requirementId: 'customer-records',
            message: 'Server missing.',
            nextAction: 'Connect the server.',
          },
        ],
      },
    });
    const cancelPermissionApproval = vi.fn(async () => 'settled' as const);
    configure({ job: () => job, cancelPermissionApproval });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
        previousFingerprint: 'grantable-before',
      }),
    ).resolves.toEqual({
      status: 'instruction_only',
      notificationEligible: true,
    });
    expect(cancelPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: setupPausePermissionRequestId('job-1', 'grantable-before'),
      }),
    );
  });

  it.each([
    [
      'ready',
      makeJob({
        setup_state: {
          ...makeJob().setup_state!,
          state: 'ready',
          blockers: [],
        },
      }),
    ],
    ['active', makeJob({ status: 'active' })],
    ['silenced', makeJob({ silent: true })],
    ['unpaused', makeJob({ status: 'running', pause_reason: null })],
  ])(
    'retires the current-fingerprint prompt before returning instruction-only when the job is %s',
    async (_state, job) => {
      const cancelPermissionApproval = vi.fn(async () => 'settled' as const);
      configure({ job: () => job, cancelPermissionApproval });

      await expect(
        raiseSetupPausePermissionPrompt({
          jobId: job.id,
          setupFingerprint: job.setup_state!.fingerprint,
        }),
      ).resolves.toEqual({
        status: 'instruction_only',
        notificationEligible: false,
      });
      expect(cancelPermissionApproval).toHaveBeenCalledOnce();
      expect(cancelPermissionApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: setupPausePermissionRequestId(
            job.id,
            job.setup_state!.fingerprint,
          ),
          reason: 'The job no longer requires this setup approval.',
        }),
      );
    },
  );

  it('formats the prompt rationale from the selected grantable blocker', async () => {
    const job = makeJob({
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'mixed-blockers',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'mcp_server',
            requirementId: 'customer-records',
            message: 'Server missing.',
            nextAction: 'Connect the server.',
          },
          {
            state: 'missing_capability',
            requirementType: 'semantic_capability',
            requirementId: 'salesforce.leads.append',
            grantable: true,
            message: 'Capability missing.',
            nextAction: 'Approve the reviewed capability.',
          },
        ],
      },
    });
    let request: PermissionApprovalRequest | undefined;
    configure({
      job: () => job,
      requestPermissionApproval: async (input, delivered) => {
        request = input;
        delivered('prompt-1');
        return cancelledDecision();
      },
    });

    await raiseSetupPausePermissionPrompt({
      jobId: job.id,
      setupFingerprint: job.setup_state!.fingerprint,
      source: 'permission_denied',
    });

    expect(request?.decisionReason).toContain(
      'Failed action: Use Salesforce Leads Append',
    );
    expect(request?.decisionReason).not.toContain(
      'Failed action: Use MCP server: Customer Records',
    );
  });

  it('uses a later mapped blocker when the first has no usable review suggestions', async () => {
    const job = makeJob({
      access_requirements: [
        { target: { kind: 'tool_rule', rule: 'RunCommand(npm run first *)' } },
        { target: { kind: 'tool_rule', rule: 'RunCommand(npm run second *)' } },
      ],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'mixed-reviewability',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'tool',
            requirementId: 'RunCommand(npm run first *)',
            grantable: true,
            message: 'First tool missing.',
            nextAction: 'Review the first tool.',
          },
          {
            state: 'missing_capability',
            requirementType: 'tool',
            requirementId: 'RunCommand(npm run second *)',
            grantable: true,
            message: 'Second tool missing.',
            nextAction: 'Review the second tool.',
          },
        ],
      },
    });
    let request: PermissionApprovalRequest | undefined;
    const reviewStoredRequirement = vi.fn(async ({ toolInput }) =>
      toolInput.rule === 'npm run second *'
        ? {
            suggestions: [
              {
                type: 'addRules' as const,
                behavior: 'allow' as const,
                destination: 'session' as const,
                rules: [{ toolName: 'RunCommand', rule: 'npm run second *' }],
              },
            ],
            decisionOptions: [
              'allow_persistent_rule' as const,
              'cancel' as const,
            ],
          }
        : { suggestions: [], decisionOptions: ['cancel' as const] },
    );
    configure({
      job: () => job,
      reviewStoredRequirement,
      requestPermissionApproval: async (input, delivered) => {
        request = input;
        delivered('prompt-1');
        return cancelledDecision();
      },
    });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toMatchObject({ status: 'raised' });

    expect(reviewStoredRequirement).toHaveBeenCalledTimes(2);
    expect(request).toMatchObject({
      toolInput: { toolName: 'RunCommand', rule: 'npm run second *' },
    });
  });

  it('does not prompt silent jobs or a fingerprint already marked notified', async () => {
    const runPermissionInteraction = vi.fn();
    let job = makeJob({ silent: true });
    configure({ job: () => job, runPermissionInteraction });
    const sendMessage = vi.fn(async () => undefined);
    const markJobSetupNotified = vi.fn(async () => true);

    await notifyJobSetupRequired({
      currentJob: job,
      runtimeAppId: 'default',
      setupState: job.setup_state!,
      deps: { sendMessage, opsRepository: { markJobSetupNotified } } as never,
      publishRuntimeEvent: async () => undefined,
    });

    job = makeJob({
      setup_state: {
        ...makeJob().setup_state!,
        notified_fingerprint: 'fingerprint-1',
      },
    });
    await notifyJobSetupRequired({
      currentJob: job,
      runtimeAppId: 'default',
      setupState: job.setup_state!,
      deps: { sendMessage, opsRepository: { markJobSetupNotified } } as never,
      publishRuntimeEvent: async () => undefined,
    });

    expect(runPermissionInteraction).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(markJobSetupNotified).not.toHaveBeenCalled();
  });

  it('does not dispatch after the job is silenced or leaves the setup-required pause', async () => {
    const runPermissionInteraction = vi.fn();
    let job = makeJob({ silent: true });
    configure({ job: () => job, runPermissionInteraction });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toEqual({
      status: 'instruction_only',
      notificationEligible: false,
    });

    job = makeJob({ status: 'active', pause_reason: null });
    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toEqual({
      status: 'instruction_only',
      notificationEligible: false,
    });

    expect(runPermissionInteraction).not.toHaveBeenCalled();
  });

  it('routes the prompt to the approver and keeps the instruction card on a divergent job route', async () => {
    const job = makeJob();
    const requestPermissionApproval = vi.fn(async (_request, delivered) => {
      delivered('prompt-1');
      return cancelledDecision();
    });
    configure({ job: () => job, requestPermissionApproval });
    const sendMessage = vi.fn(async () => undefined);
    const markJobSetupNotified = vi.fn(async () => true);

    await notifyJobSetupRequired({
      currentJob: job,
      runtimeAppId: 'default',
      setupState: job.setup_state!,
      deps: {
        sendMessage,
        opsRepository: { markJobSetupNotified },
      } as never,
      publishRuntimeEvent: async () => undefined,
    });

    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({ targetJid: 'sl:approver' }),
      expect.any(Function),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:job-notifications',
      expect.stringContaining('Setup needed'),
    );
  });

  it('covers the approver with an instruction card when another durable prompt owner may be undelivered', async () => {
    const approverRoute = {
      conversationJid: 'sl:approver',
      threadId: 'approval-thread',
      label: 'Approver',
    };
    const job = makeJob({ notification_routes: [approverRoute] });
    configure({
      job: () => job,
      runPermissionInteraction: async () => ({
        began: false,
        decision: cancelledDecision(),
        resolved: false,
      }),
    });
    const sendMessage = vi.fn(async () => undefined);
    const markJobSetupNotified = vi.fn(async () => true);

    await expect(
      notifyJobSetupRequired({
        currentJob: job,
        runtimeAppId: 'default',
        setupState: job.setup_state!,
        deps: {
          sendMessage,
          opsRepository: { markJobSetupNotified },
        } as never,
        publishRuntimeEvent: async () => undefined,
      }),
    ).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(
      'sl:approver',
      expect.stringContaining('Setup needed'),
      expect.objectContaining({ threadId: 'approval-thread' }),
    );
    expect(markJobSetupNotified).toHaveBeenCalledWith(
      job.id,
      job.setup_state!.fingerprint,
    );
  });

  it('falls back to an instruction card when the only-route prompt is undelivered', async () => {
    const approverRoute = {
      conversationJid: 'sl:approver',
      threadId: 'approval-thread',
      label: 'Approver',
    };
    const job = makeJob({ notification_routes: [approverRoute] });
    configure({
      job: () => job,
      runPermissionInteraction: async (_request, _delivered, began) => {
        began();
        return {
          began: true,
          decision: cancelledDecision(),
          resolved: true,
        };
      },
    });
    const sendMessage = vi.fn(async () => undefined);
    const markJobSetupNotified = vi.fn(async () => true);

    await expect(
      notifyJobSetupRequired({
        currentJob: job,
        runtimeAppId: 'default',
        setupState: job.setup_state!,
        deps: {
          sendMessage,
          opsRepository: { markJobSetupNotified },
        } as never,
        publishRuntimeEvent: async () => undefined,
      }),
    ).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(
      'sl:approver',
      expect.stringContaining('Setup needed'),
      expect.objectContaining({ threadId: 'approval-thread' }),
    );
    expect(markJobSetupNotified).toHaveBeenCalledWith(
      job.id,
      job.setup_state!.fingerprint,
    );
  });

  it('sends an undelivered raised-prompt fallback to a divergent approver route without double-carding the job route', async () => {
    const job = makeJob();
    configure({
      job: () => job,
      runPermissionInteraction: async (_request, _delivered, began) => {
        began();
        return {
          began: true,
          decision: cancelledDecision(),
          resolved: true,
        };
      },
    });
    const sendMessage = vi.fn(async () => undefined);
    const markJobSetupNotified = vi.fn(async () => true);

    await expect(
      notifyJobSetupRequired({
        currentJob: job,
        runtimeAppId: 'default',
        setupState: job.setup_state!,
        deps: {
          sendMessage,
          opsRepository: { markJobSetupNotified },
        } as never,
        publishRuntimeEvent: async () => undefined,
      }),
    ).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(
      'sl:job-notifications',
      expect.stringContaining('Setup needed'),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:approver',
      expect.stringContaining('Setup needed'),
      expect.objectContaining({ threadId: 'approval-thread' }),
    );
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(markJobSetupNotified).toHaveBeenCalledWith(
      job.id,
      job.setup_state!.fingerprint,
    );
  });

  it('keeps an undelivered raised prompt retryable when its approver fallback also fails', async () => {
    const job = makeJob();
    configure({
      job: () => job,
      runPermissionInteraction: async (_request, _delivered, began) => {
        began();
        return {
          began: true,
          decision: cancelledDecision(),
          resolved: true,
        };
      },
    });
    const sendMessage = vi.fn(async (jid: string) => {
      if (jid === 'sl:approver') throw new Error('provider unavailable');
    });
    const markJobSetupNotified = vi.fn(async () => true);

    await expect(
      notifyJobSetupRequired({
        currentJob: job,
        runtimeAppId: 'default',
        setupState: job.setup_state!,
        deps: {
          sendMessage,
          opsRepository: { markJobSetupNotified },
        } as never,
        publishRuntimeEvent: async () => undefined,
      }),
    ).resolves.toBe(false);

    expect(sendMessage).toHaveBeenCalledWith(
      'sl:job-notifications',
      expect.stringContaining('Setup needed'),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:approver',
      expect.stringContaining('Setup needed'),
      expect.objectContaining({ threadId: 'approval-thread' }),
    );
    expect(markJobSetupNotified).not.toHaveBeenCalled();
  });

  it('keeps a same-conversation notification route on a different provider account', async () => {
    const job = makeJob();
    job.notification_routes = [
      {
        conversationJid: 'sl:approver',
        threadId: 'approval-thread',
        providerAccountId: 'account-job',
        label: 'Job notifications',
      },
    ];
    configure({
      job: () => job,
      runPermissionInteraction: async (_request, delivered, began) => {
        began();
        delivered('prompt-1');
        return new Promise<never>(() => undefined);
      },
      resolveProviderAccountId: () => 'account-approver',
    });
    const sendMessage = vi.fn(async () => undefined);
    const markJobSetupNotified = vi.fn(async () => true);

    await expect(
      notifyJobSetupRequired({
        currentJob: job,
        runtimeAppId: 'default',
        setupState: job.setup_state!,
        deps: {
          sendMessage,
          opsRepository: { markJobSetupNotified },
        } as never,
        publishRuntimeEvent: async () => undefined,
      }),
    ).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(
      'sl:approver',
      expect.stringContaining('Setup needed'),
      expect.objectContaining({
        threadId: 'approval-thread',
        providerAccountId: 'account-job',
      }),
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(markJobSetupNotified).toHaveBeenCalledWith(
      job.id,
      job.setup_state!.fingerprint,
    );
  });

  it('treats an omitted notification account as the resolved default account', async () => {
    const approverRoute = {
      conversationJid: 'sl:approver',
      threadId: 'approval-thread',
      label: 'Approver',
    };
    const job = makeJob({ notification_routes: [approverRoute] });
    configure({
      job: () => job,
      runPermissionInteraction: async (_request, delivered, began) => {
        began();
        delivered('prompt-1');
        return new Promise<never>(() => undefined);
      },
      resolveProviderAccountId: () => 'account-default',
    });
    const sendMessage = vi.fn(async () => undefined);
    const markJobSetupNotified = vi.fn(async () => true);

    await expect(
      notifyJobSetupRequired({
        currentJob: job,
        runtimeAppId: 'default',
        setupState: job.setup_state!,
        deps: {
          sendMessage,
          opsRepository: { markJobSetupNotified },
        } as never,
        publishRuntimeEvent: async () => undefined,
      }),
    ).resolves.toBe(true);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(markJobSetupNotified).toHaveBeenCalledWith(
      job.id,
      job.setup_state!.fingerprint,
    );
  });

  it('deduplicates concurrent readiness checks through the durable interaction owner', async () => {
    const job = makeJob();
    let durableInteractionId: string | undefined;
    const providerPrompt = vi.fn();
    const operations = {
      record: vi.fn(async (input: { interactionId?: string }) => {
        if (!durableInteractionId) {
          durableInteractionId = input.interactionId;
        }
        return {
          id: durableInteractionId,
          status: 'pending',
        } as never;
      }),
      resolve: vi.fn(async () => true),
      cancelPendingQuestionInteractionIfRunLeaseInactive: vi.fn(
        async () => false,
      ),
    };
    configure({
      job: () => job,
      runPermissionInteraction: (request, delivered, began) =>
        runDurablePermissionInteraction({
          request,
          sourceAgentFolder: request.sourceAgentFolder,
          operations: operations as never,
          skipPromptWhenAlreadyPending: true,
          beforePrompt: began,
          prompt: async () => {
            providerPrompt(request.requestId);
            delivered('prompt-1');
            return new Promise<never>(() => undefined);
          },
        }),
    });

    await expect(
      Promise.all([
        raiseSetupPausePermissionPrompt({
          jobId: job.id,
          setupFingerprint: job.setup_state!.fingerprint,
        }),
        raiseSetupPausePermissionPrompt({
          jobId: job.id,
          setupFingerprint: job.setup_state!.fingerprint,
        }),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ status: 'raised' }),
      expect.objectContaining({ status: 'already_pending' }),
    ]);
    expect(providerPrompt).toHaveBeenCalledOnce();
  });

  it('treats an ambiguous durable record result as already pending and keeps the approver carded', async () => {
    const approverRoute = {
      conversationJid: 'sl:approver',
      threadId: 'approval-thread',
      label: 'Approver',
    };
    const job = makeJob({ notification_routes: [approverRoute] });
    const providerPrompt = vi.fn();
    const operations = {
      record: vi.fn(async () => true),
      resolve: vi.fn(async () => true),
      cancelPendingQuestionInteractionIfRunLeaseInactive: vi.fn(
        async () => false,
      ),
    };
    configure({
      job: () => job,
      runPermissionInteraction: (request, delivered, began) =>
        runDurablePermissionInteraction({
          request,
          sourceAgentFolder: request.sourceAgentFolder,
          operations: operations as never,
          skipPromptWhenAlreadyPending: true,
          beforePrompt: began,
          prompt: async () => {
            providerPrompt(request.requestId);
            delivered('prompt-1');
            return new Promise<never>(() => undefined);
          },
        }),
    });
    const sendMessage = vi.fn(async () => undefined);
    const markJobSetupNotified = vi.fn(async () => true);

    await expect(
      notifyJobSetupRequired({
        currentJob: job,
        runtimeAppId: 'default',
        setupState: job.setup_state!,
        deps: {
          sendMessage,
          opsRepository: { markJobSetupNotified },
        } as never,
        publishRuntimeEvent: async () => undefined,
      }),
    ).resolves.toBe(true);

    expect(providerPrompt).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:approver',
      expect.stringContaining('Setup needed'),
      expect.objectContaining({ threadId: 'approval-thread' }),
    );
    expect(markJobSetupNotified).toHaveBeenCalledWith(
      job.id,
      job.setup_state!.fingerprint,
    );
  });

  it.each([
    ['silenced', makeJob({ silent: true })],
    ['deleted', undefined],
  ])(
    'does not send or mark the stale setup card when the job is %s during prompt preparation',
    async (_state, freshJob) => {
      const snapshot = makeJob();
      configure({ job: () => freshJob });
      const sendMessage = vi.fn(async () => undefined);
      const markJobSetupNotified = vi.fn(async () => true);

      await expect(
        notifyJobSetupRequired({
          currentJob: snapshot,
          runtimeAppId: 'default',
          setupState: snapshot.setup_state!,
          deps: {
            sendMessage,
            opsRepository: { markJobSetupNotified },
          } as never,
          publishRuntimeEvent: async () => undefined,
        }),
      ).resolves.toBe(false);

      expect(sendMessage).not.toHaveBeenCalled();
      expect(markJobSetupNotified).not.toHaveBeenCalled();
    },
  );

  it('rejects a live setup approval after the fingerprint changes or the job is deleted', async () => {
    let job: Job | undefined = makeJob();
    const repository = {
      getJobById: vi.fn(async () => job ?? null),
    };
    const request = {
      requestId: 'setup-pause:job-1:fingerprint-1',
      jobId: 'job-1',
    } as PermissionApprovalRequest;

    await expect(
      setupPauseGrantIsCurrent(repository as never, request),
    ).resolves.toBe(true);
    job = {
      ...job!,
      setup_state: { ...job!.setup_state!, fingerprint: 'fingerprint-2' },
    };
    await expect(
      setupPauseGrantIsCurrent(repository as never, request),
    ).resolves.toBe(false);
    job = undefined;
    await expect(
      setupPauseGrantIsCurrent(repository as never, request),
    ).resolves.toBe(false);
  });

  it('re-validates a setup fingerprint on simulated restart recovery before grant persistence', async () => {
    const job = makeJob({
      setup_state: {
        ...makeJob().setup_state!,
        fingerprint: 'fingerprint-2',
      },
    });
    const repository = {
      getJobById: vi.fn(async () => job),
      appendJobAccessRequirement: vi.fn(async () => true),
    };
    const mirrorAgentToolRulesToSettings = vi.fn();
    const request = {
      requestId: 'setup-pause:job-1:fingerprint-1',
      appId: 'default',
      agentId: 'agent:main_agent',
      sourceAgentFolder: 'main_agent',
      jobId: 'job-1',
      toolName: 'request_permission',
    } as PermissionApprovalRequest;

    await expect(
      applyRecoveredPersistentPermissionGrant({
        persistence: {
          opsRepository: repository as never,
          beforePersistentGrant: (candidate, effectiveUpdates) =>
            setupPausePersistentGrantIsCurrent(
              repository as never,
              candidate,
              effectiveUpdates,
            ),
          afterPersistentGrant: (candidate, effectiveUpdates) =>
            appendSetupPauseRequirementAfterPersistentGrant(
              repository as never,
              candidate,
              effectiveUpdates,
            ),
          getToolRepository: () => ({}) as never,
          mirrorAgentToolRulesToSettings,
        },
        request,
        sourceAgentFolder: 'main_agent',
        decision: permanentDecision(),
      }),
    ).resolves.toBe(false);
    expect(repository.appendJobAccessRequirement).not.toHaveBeenCalled();
    expect(mirrorAgentToolRulesToSettings).not.toHaveBeenCalled();
  });

  it('deletes the job when prompt retirement fails', async () => {
    const job = makeJob();
    configure({
      job: () => job,
      cancelPermissionApproval: async () => {
        throw new Error('prompt store unavailable');
      },
    });
    const deleteJob = vi.fn(async () => undefined);
    const scheduler = { requestSchedulerSync: vi.fn() };
    const service = new JobManagementService({
      ops: {
        getJobById: vi.fn(async () => job),
        deleteJob,
      } as unknown as RuntimeJobRepository,
      scheduler,
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(service.deleteJob({ jobId: job.id })).resolves.toEqual({
      deleted: true,
    });
    expect(deleteJob).toHaveBeenCalledWith(job.id);
    expect(scheduler.requestSchedulerSync).toHaveBeenCalledWith(job.id);
  });

  it('retires a deleted job prompt with the configured runtime app id', async () => {
    const job = makeJob();
    const cancelPermissionApproval = vi.fn(async () => 'settled' as const);
    configure({
      appId: 'customer-app',
      job: () => job,
      cancelPermissionApproval,
    });
    const service = new JobManagementService({
      ops: {
        getJobById: vi.fn(async () => job),
        deleteJob: vi.fn(async () => undefined),
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await service.deleteJob({ jobId: job.id });

    expect(cancelPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'customer-app',
        requestId: setupPausePermissionRequestId(
          job.id,
          job.setup_state!.fingerprint,
        ),
      }),
    );
  });

  it('keeps the pending approval intact when job deletion fails', async () => {
    const job = makeJob();
    const cancelPermissionApproval = vi.fn(async () => 'settled' as const);
    configure({ job: () => job, cancelPermissionApproval });
    const service = new JobManagementService({
      ops: {
        getJobById: vi.fn(async () => job),
        deleteJob: vi.fn(async () => {
          throw new Error('job store unavailable');
        }),
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(service.deleteJob({ jobId: job.id })).rejects.toThrow(
      'job store unavailable',
    );
    expect(cancelPermissionApproval).not.toHaveBeenCalled();
  });

  it('keeps an actionable setup prompt retryable when preparation fails', async () => {
    const job = makeJob();
    configure({
      job: () => job,
      reviewStoredRequirement: async () => {
        throw new Error('review unavailable');
      },
    });
    const sendMessage = vi.fn(async () => undefined);
    const markJobSetupNotified = vi.fn(async () => true);

    await expect(
      notifyJobSetupRequired({
        currentJob: job,
        runtimeAppId: 'default',
        setupState: job.setup_state!,
        deps: {
          sendMessage,
          opsRepository: { markJobSetupNotified },
        } as never,
        publishRuntimeEvent: async () => undefined,
      }),
    ).resolves.toBe(false);

    expect(sendMessage).toHaveBeenCalledWith(
      'sl:job-notifications',
      expect.stringContaining('Setup needed'),
    );
    expect(markJobSetupNotified).not.toHaveBeenCalled();
  });
});
