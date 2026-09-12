import { describe, expect, it, vi } from 'vitest';

import { runActiveJobAgent } from '@core/jobs/execution-phases-run.js';
import { semanticCapabilityInputSchema } from '@core/shared/semantic-capabilities.js';

const executionSpies = vi.hoisted(() => ({
  baseInput: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@core/jobs/execution-readiness.js', () => ({
  pauseJobForSetupIfNeeded: vi.fn(async () => false),
}));

vi.mock('@core/jobs/execution-failover.js', () => ({
  runJobAgentWithFailover: vi.fn(
    async (input: { baseInput: Record<string, unknown> }) => {
      executionSpies.baseInput = input.baseInput;
      throw new Error('stop after spawn input capture');
    },
  ),
}));

function capabilityTool(id: string) {
  const capability = {
    capabilityId: id,
    version: '1',
    displayName: id === 'granted.read' ? 'Granted read' : 'App-only read',
    category: 'Records',
    risk: 'read' as const,
    can: 'Read reviewed records.',
    cannot: 'Write records.',
    credentialSource: 'none' as const,
    implementationBindings: [
      { kind: 'adapter' as const, adapterRef: 'builtin:RecordRead' },
    ],
  };
  return {
    id: `tool:${id}`,
    appId: 'app-one',
    name: `capability:${id}`,
    displayName: capability.displayName,
    category: 'records',
    risk: 'low',
    selectable: true,
    status: 'active',
    inputSchema: semanticCapabilityInputSchema(capability),
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
  };
}

async function captureScheduledSpawnInput() {
  executionSpies.baseInput = undefined;
  const granted = capabilityTool('granted.read');
  const appOnly = capabilityTool('app.only.read');
  const toolRepository = {
    listAgentToolAccessSnapshot: vi.fn(async () => ({
      activeBindings: [
        {
          binding: {
            id: 'binding:granted',
            appId: 'app-one',
            agentId: 'agent:scheduler',
            toolId: granted.id,
            personId: 'person-one',
            status: 'active',
            createdAt: '2026-09-11T00:00:00.000Z',
            updatedAt: '2026-09-11T00:00:00.000Z',
          },
          definition: granted,
        },
        {
          binding: {
            id: 'binding:app-only',
            appId: 'app-one',
            agentId: 'agent:scheduler',
            toolId: appOnly.id,
            personId: 'person-two',
            status: 'active',
            createdAt: '2026-09-11T00:00:00.000Z',
            updatedAt: '2026-09-11T00:00:00.000Z',
          },
          definition: appOnly,
        },
      ],
      appActiveDefinitions: [granted, appOnly],
    })),
  };
  const context = {
    currentJob: {
      id: 'job-one',
      name: 'Catalog job',
      prompt: 'Read records',
      access_requirements: [],
      execution_context: { personId: 'person-one' },
    },
    deps: {
      opsRepository: {
        getAgentTurnContext: vi.fn(async () => undefined),
      },
      getToolRepository: () => toolRepository,
      runAgent: vi.fn(),
      runnerSandboxProvider: { id: 'direct', enforcing: false },
    },
    execution: {
      group: {
        name: 'Scheduler',
        folder: 'scheduler',
        trigger: '',
        added_at: '2026-09-11T00:00:00.000Z',
        conversationKind: 'channel',
        conversationId: 'conversation-one',
      },
      executionJid: 'tg:catalog-job',
      stopAliasJids: [],
    },
    runtimeAppId: 'app-one',
    eventState: { eventAppSession: { appId: 'app-one' } },
    runId: 'run-one',
    timeoutMs: 30_000,
    publishRuntimeEvent: vi.fn(),
    groups: {},
    executionProviderId: 'provider-one',
    resolvedModel: { selectedModel: 'model-one' },
    jobFailoverCandidates: ['model-one'],
    agentHarness: 'auto',
    jobModelUseKind: 'recurringJob',
    assistantName: 'Gantry',
    leaseContext: {
      lease: {
        leaseToken: 'lease-one',
        workerInstanceId: 'worker-one',
        fencingVersion: 1,
      },
    },
    runLeaseAbort: {
      signal: new AbortController().signal,
      errorFor: (error: unknown) =>
        error instanceof Error ? error.message : String(error),
      isAborted: () => true,
    },
    error: null,
    hasStreamedResult: false,
    streamedRuntimeEventKeys: new Set<string>(),
  };

  await runActiveJobAgent(context as never);
  return executionSpies.baseInput;
}

describe('scheduled capability catalog', () => {
  it('the scheduled spawn input carries a capability catalog', async () => {
    const input = await captureScheduledSpawnInput();

    expect(input?.capabilityCatalog).toEqual(
      expect.objectContaining({
        readyActions: [expect.objectContaining({ stableRef: 'granted.read' })],
      }),
    );
  });

  it('an ungranted but app-active capability never renders as ready', async () => {
    const input = await captureScheduledSpawnInput();
    const catalog = input?.capabilityCatalog as {
      readyActions: Array<{ stableRef: string }>;
      requestableActions: Array<{ stableRef: string }>;
    };

    expect(catalog.readyActions.map((entry) => entry.stableRef)).toEqual([
      'granted.read',
    ]);
    expect(
      catalog.requestableActions.map((entry) => entry.stableRef),
    ).toContain('app.only.read');
  });
});
