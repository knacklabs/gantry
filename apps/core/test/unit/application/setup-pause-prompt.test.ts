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

function instructionBlocker(
  type: 'tool' | 'semantic_capability' | 'browser' | 'mcp_server',
  id: string,
  summary: string,
  text: string,
) {
  return {
    state: 'missing_capability' as const,
    type,
    id,
    summary,
    action: { kind: 'instruction' as const, text },
  };
}

function approveBlocker(
  type: 'tool' | 'semantic_capability' | 'browser',
  id: string,
  summary: string,
  toolName: string,
  ruleContent?: string,
) {
  return {
    state: 'missing_capability' as const,
    type,
    id,
    summary,
    action: {
      kind: 'approve_grant' as const,
      grant: {
        type: 'addRules' as const,
        behavior: 'allow' as const,
        rules: [{ toolName, ...(ruleContent ? { ruleContent } : {}) }],
      },
    },
  };
}

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
        approveBlocker(
          'semantic_capability',
          'salesforce.leads.append',
          'Capability missing.',
          'capability:salesforce.leads.append',
        ),
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

function configure(input: {
  appId?: string;
  job: () => Job | undefined;
  preparePermissionInteraction?: SetupPausePermissionPromptDeps['preparePermissionInteraction'];
  cancelPermissionApproval?: SetupPausePermissionPromptDeps['cancelPermissionApproval'];
  reviewStoredRequirement?: SetupPausePermissionPromptDeps['reviewStoredRequirement'];
  resolveProviderAccountId?: SetupPausePermissionPromptDeps['resolveProviderAccountId'];
}) {
  const deps: SetupPausePermissionPromptDeps = {
    appId: input.appId ?? 'default',
    getJobById: async () => input.job(),
    preparePermissionInteraction:
      input.preparePermissionInteraction ?? (async () => ({ created: true })),
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
          instructionBlocker(
            'browser',
            'Browser',
            'Protected browser access was denied.',
            'Ask an operator to configure this worker manually.',
          ),
        ],
      },
    });
    const reviewStoredRequirement = vi.fn();
    const preparePermissionInteraction = vi.fn();
    configure({
      job: () => job,
      reviewStoredRequirement,
      preparePermissionInteraction,
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
    expect(preparePermissionInteraction).not.toHaveBeenCalled();
  });

  it('an instruction action is instruction-only', async () => {
    const job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-08T00:00:00.000Z',
        fingerprint: 'legacy-browser-denial',
        blockers: [
          instructionBlocker(
            'browser',
            'Browser',
            'Browser access was denied.',
            'Ask an operator to configure Browser access.',
          ),
        ],
      },
    });
    const reviewStoredRequirement = vi.fn();
    const preparePermissionInteraction = vi.fn();
    configure({
      job: () => job,
      reviewStoredRequirement,
      preparePermissionInteraction,
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
    expect(preparePermissionInteraction).not.toHaveBeenCalled();
  });

  it('an MCP-server denial is instruction-only', async () => {
    const job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-08T00:00:00.000Z',
        fingerprint: 'mcp-server-denial',
        blockers: [
          instructionBlocker(
            'tool',
            'mcp__customer_records__append',
            'The MCP server is not configured.',
            'Connect the customer-records MCP server.',
          ),
        ],
      },
    });
    const reviewStoredRequirement = vi.fn();
    const preparePermissionInteraction = vi.fn();
    configure({
      job: () => job,
      reviewStoredRequirement,
      preparePermissionInteraction,
    });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toMatchObject({ status: 'instruction_only' });
    expect(reviewStoredRequirement).not.toHaveBeenCalled();
    expect(preparePermissionInteraction).not.toHaveBeenCalled();
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

  it("prepares one durable permission prompt from the job's stored requirement", async () => {
    const job = makeJob();
    let request: PermissionApprovalRequest | undefined;
    const preparePermissionInteraction = vi.fn(async (input) => {
      request = input;
      return { created: true };
    });
    configure({ job: () => job, preparePermissionInteraction });

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

    expect(preparePermissionInteraction).toHaveBeenCalledOnce();
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
      "This job hasn't started because setup is incomplete.",
    );
    expect(request?.decisionReason).toContain('Needed:');
    expect(request?.description).toContain('Allow once is unavailable');
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
          approveBlocker(
            'browser',
            'Browser',
            'Browser access was denied.',
            'Browser',
          ),
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
      preparePermissionInteraction: async (input) => {
        request = input;
        return { created: true };
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

  it('fails closed (writes no grant) when a scheduled job cannot be resolved', async () => {
    const saveAgentToolBinding = vi.fn(async () => undefined);
    const toolRepository = {
      getTool: vi.fn(),
      listTools: vi.fn(async () => []),
      saveTool: vi.fn(),
      saveAgentToolBinding,
      disableAgentToolBinding: vi.fn(),
      listAgentToolBindings: vi.fn(async () => []),
      listAgentToolBindingsForAgents: vi.fn(),
    };
    // A transient repository failure / stale job id must NOT widen the person's
    // approval to a shared grant.
    const opsRepository = { getJobById: vi.fn(async () => undefined) };

    const granted = await applyRecoveredPersistentPermissionGrant({
      persistence: {
        opsRepository: opsRepository as never,
        getToolRepository: () => toolRepository as never,
        mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
      },
      request: {
        requestId: 'perm-missing-job',
        appId: 'default',
        jobId: 'job:gone',
        toolName: 'Browser',
        sourceAgentFolder: 'main_agent',
      } as never,
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
    });

    expect(granted).toBe(false);
    expect(saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('settles and resumes when the requirement append loses its CAS after the grant committed', async () => {
    const job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'under-declared-browser',
        blockers: [
          approveBlocker(
            'browser',
            'Browser',
            'Browser access was denied.',
            'Browser',
          ),
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
      setupFingerprint: job.setup_state!.fingerprint,
      toolName: 'request_permission',
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Browser' }],
        },
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
          approveBlocker(
            'browser',
            'Browser',
            'Browser access was denied.',
            'Browser',
          ),
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
      setupFingerprint: job.setup_state!.fingerprint,
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
          approveBlocker(
            'browser',
            'Browser',
            'Browser access was denied.',
            'Browser',
          ),
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
      setupFingerprint: job.setup_state!.fingerprint,
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
          approveBlocker(
            'tool',
            'RunCommand',
            'Scoped command access was denied.',
            'RunCommand',
            'npm test *',
          ),
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
      preparePermissionInteraction: async (input) => {
        request = input;
        return { created: true };
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

  it('an under-declared canonical facade denial persists the tool and appends its job requirement', async () => {
    let job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-09T00:00:00.000Z',
        fingerprint: 'under-declared-web-search',
        blockers: [
          approveBlocker(
            'tool',
            'WebSearch',
            'Web search access was denied.',
            'WebSearch',
          ),
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
        updated_at: '2026-08-09T00:00:01.000Z',
      };
      return true;
    });
    const resumeSetupPausedJob = vi.fn(async () => true);
    const requestSchedulerSync = vi.fn();
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);
    const tools: Record<string, unknown>[] = [
      {
        id: 'tool:WebSearch',
        appId: 'default',
        name: 'WebSearch',
        kind: 'host',
        provider: 'gantry',
        displayName: 'Web search',
        description: 'Search the web through Gantry.',
        category: 'web',
        risk: 'low',
        selectable: true,
        status: 'active',
        adapterRef: 'gantry:WebSearch',
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      },
    ];
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
      preparePermissionInteraction: async (input) => {
        request = input;
        return { created: true };
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
        toolName: 'WebSearch',
      },
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'WebSearch' }],
        },
      ],
    });

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
        target: { kind: 'tool_rule', rule: 'WebSearch' },
      }),
    ]);
    expect(toolRepository.saveTool).not.toHaveBeenCalled();
    expect(toolRepository.saveAgentToolBinding).toHaveBeenCalledOnce();
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['WebSearch'],
      { appId: 'default' },
    );
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
          approveBlocker(
            'browser',
            'Browser',
            'Browser access was denied.',
            'Browser',
          ),
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
      setupFingerprint: job.setup_state!.fingerprint,
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
          approveBlocker(
            'browser',
            'Browser',
            'Browser access was denied.',
            'Browser',
          ),
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
      setupFingerprint: job.setup_state!.fingerprint,
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

  it('keeps an under-declared instruction denial instruction-only', async () => {
    const job = makeJob({
      access_requirements: [],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'under-declared-unscoped-command',
        blockers: [
          instructionBlocker(
            'tool',
            'RunCommand',
            'Unscoped command access was denied.',
            'Declare a reviewed scoped command.',
          ),
        ],
      },
    });
    const preparePermissionInteraction = vi.fn();
    const reviewStoredRequirement = vi.fn();
    configure({
      job: () => job,
      preparePermissionInteraction,
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
    expect(preparePermissionInteraction).not.toHaveBeenCalled();
  });

  it('same fingerprint does not re-prompt and a changed blocker set retires the old prompt', async () => {
    let job = makeJob();
    const pending = new Set<string>();
    const providerPrompt = vi.fn();
    const preparePermissionInteraction = vi.fn(
      async (request: PermissionApprovalRequest) => {
        if (pending.has(request.requestId)) {
          return { created: false };
        }
        pending.add(request.requestId);
        providerPrompt(request.requestId);
        return { created: true };
      },
    );
    const cancelPermissionApproval = vi.fn(async (cancellation) => {
      pending.delete(cancellation.requestId);
      return 'settled' as const;
    });
    configure({
      job: () => job,
      preparePermissionInteraction,
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
          instructionBlocker(
            'mcp_server',
            'customer-records',
            'Server missing.',
            'Connect the server.',
          ),
        ],
      },
    });
    const preparePermissionInteraction = vi.fn();
    configure({ job: () => job, preparePermissionInteraction });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toEqual({
      status: 'instruction_only',
      notificationEligible: true,
    });
    expect(preparePermissionInteraction).not.toHaveBeenCalled();
  });

  it('keeps operator instruction blockers on the instruction-only path', async () => {
    const job = makeJob({
      access_requirements: [
        { target: { kind: 'tool_rule', rule: 'RunCommand(npm test *)' } },
      ],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-05T00:00:00.000Z',
        fingerprint: 'config-only',
        blockers: [
          instructionBlocker(
            'tool',
            'RunCommand(npm test *)',
            'Configuration is missing.',
            'Configure the runtime.',
          ),
        ],
      },
    });
    const preparePermissionInteraction = vi.fn();
    configure({ job: () => job, preparePermissionInteraction });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toEqual({
      status: 'instruction_only',
      notificationEligible: true,
    });
    expect(preparePermissionInteraction).not.toHaveBeenCalled();
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
          instructionBlocker(
            'mcp_server',
            'customer-records',
            'Server missing.',
            'Connect the server.',
          ),
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
          instructionBlocker(
            'mcp_server',
            'customer-records',
            'Server missing.',
            'Connect the server.',
          ),
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
          instructionBlocker(
            'mcp_server',
            'customer-records',
            'Server missing.',
            'Connect the server.',
          ),
          approveBlocker(
            'semantic_capability',
            'salesforce.leads.append',
            'Capability missing.',
            'capability:salesforce.leads.append',
          ),
        ],
      },
    });
    let request: PermissionApprovalRequest | undefined;
    configure({
      job: () => job,
      preparePermissionInteraction: async (input) => {
        request = input;
        return { created: true };
      },
    });

    await raiseSetupPausePermissionPrompt({
      jobId: job.id,
      setupFingerprint: job.setup_state!.fingerprint,
      source: 'permission_denied',
    });

    expect(request?.decisionReason).toContain(
      "This job paused because it couldn't use Salesforce Leads Append.",
    );
    expect(request?.decisionReason).not.toContain(
      "This job paused because it couldn't use MCP server: Customer Records.",
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
          approveBlocker(
            'tool',
            'RunCommand(npm run first *)',
            'First tool missing.',
            'RunCommand',
            'npm run first *',
          ),
          approveBlocker(
            'tool',
            'RunCommand(npm run second *)',
            'Second tool missing.',
            'RunCommand',
            'npm run second *',
          ),
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
      preparePermissionInteraction: async (input) => {
        request = input;
        return { created: true };
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
    const preparePermissionInteraction = vi.fn();
    let job = makeJob({ silent: true });
    configure({ job: () => job, preparePermissionInteraction });
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

    expect(preparePermissionInteraction).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(markJobSetupNotified).not.toHaveBeenCalled();
  });

  it('does not dispatch after the job is silenced or leaves the setup-required pause', async () => {
    const preparePermissionInteraction = vi.fn();
    let job = makeJob({ silent: true });
    configure({ job: () => job, preparePermissionInteraction });

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

    expect(preparePermissionInteraction).not.toHaveBeenCalled();
  });

  it('prepares the approver card and keeps only the divergent job notification path', async () => {
    const job = makeJob();
    const preparePermissionInteraction = vi.fn(async () => ({ created: true }));
    configure({ job: () => job, preparePermissionInteraction });
    const sendMessage = vi.fn(async () => undefined);
    const markJobSetupNotified = vi.fn(async () => true);

    await expect(
      notifyJobSetupRequired({
        currentJob: job,
        runtimeAppId: 'default',
        setupState: job.setup_state!,
        deps: { sendMessage, opsRepository: { markJobSetupNotified } } as never,
        publishRuntimeEvent: async () => undefined,
      }),
    ).resolves.toBe(false);

    expect(preparePermissionInteraction).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:job-notifications',
      expect.stringContaining('Setup needed'),
      expect.objectContaining({
        actionAffordances: expect.arrayContaining([
          expect.objectContaining({ kind: 'scheduler_pause_job' }),
        ]),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      'sl:approver',
      expect.anything(),
      expect.anything(),
    );
    expect(markJobSetupNotified).not.toHaveBeenCalled();
  });

  it('does not send a prose fallback on the approver route while durable delivery is pending', async () => {
    const approverRoute = {
      conversationJid: 'sl:approver',
      threadId: 'approval-thread',
      label: 'Approver',
    };
    const job = makeJob({ notification_routes: [approverRoute] });
    const preparePermissionInteraction = vi.fn(async () => ({ created: true }));
    configure({
      job: () => job,
      preparePermissionInteraction,
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

    expect(preparePermissionInteraction).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(markJobSetupNotified).not.toHaveBeenCalled();
  });

  it('reports an existing composite prompt as already pending without another send', async () => {
    const job = makeJob();
    const preparePermissionInteraction = vi.fn(async () => ({
      created: false,
    }));
    configure({ job: () => job, preparePermissionInteraction });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: job.id,
        setupFingerprint: job.setup_state!.fingerprint,
      }),
    ).resolves.toMatchObject({ status: 'already_pending' });
    expect(preparePermissionInteraction).toHaveBeenCalledOnce();
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
      requestId: 'persisted-prompt-member-1',
      jobId: 'job-1',
      setupFingerprint: 'fingerprint-1',
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
      requestId: 'persisted-prompt-member-1',
      appId: 'default',
      agentId: 'agent:main_agent',
      sourceAgentFolder: 'main_agent',
      jobId: 'job-1',
      setupFingerprint: 'fingerprint-1',
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

  it('delegates setup-prompt cancellation to the job repository transaction', async () => {
    const job = makeJob();
    const cancelPermissionApproval = vi.fn(async () => {
      throw new Error('channel cancellation must not run');
    });
    configure({
      job: () => job,
      cancelPermissionApproval,
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
    expect(cancelPermissionApproval).not.toHaveBeenCalled();
    expect(scheduler.requestSchedulerSync).toHaveBeenCalledWith(job.id);
  });

  it('surfaces transactional job deletion failure without requesting scheduler sync', async () => {
    const job = makeJob();
    const scheduler = { requestSchedulerSync: vi.fn() };
    const service = new JobManagementService({
      ops: {
        getJobById: vi.fn(async () => job),
        deleteJob: vi.fn(async () => {
          throw new Error('job cancellation transaction failed');
        }),
      } as unknown as RuntimeJobRepository,
      scheduler,
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(service.deleteJob({ jobId: job.id })).rejects.toThrow(
      'job cancellation transaction failed',
    );
    expect(scheduler.requestSchedulerSync).not.toHaveBeenCalled();
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
      expect.objectContaining({
        actionAffordances: expect.arrayContaining([
          expect.objectContaining({ kind: 'scheduler_pause_job' }),
        ]),
      }),
    );
    expect(markJobSetupNotified).not.toHaveBeenCalled();
  });
});
