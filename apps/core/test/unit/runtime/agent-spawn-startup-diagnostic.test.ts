import { describe, expect, it, vi } from 'vitest';

import {
  buildRunnerHostStartupDiagnosticEvent,
  countJsonStringArray,
  publishRunnerHostStartupDiagnosticFromSpawn,
} from '@core/runtime/agent-spawn-startup-diagnostic.js';

const baseDiagnostic = {
  appId: 'app-one',
  agentId: 'agent-one',
  runId: 'run-one',
  jobId: 'job-one',
  conversationId: 'whatsapp:group-one',
  threadId: 'reply-one',
  agentEngine: 'deepagents' as const,
  executionProviderId: 'deepagents:langchain',
  hostPhases: {
    mcpProjectionMs: 12,
    selectedSkillEnvMs: 3,
    sandboxSpecMs: 4,
  },
  toolPolicyRuleCount: 7,
  gantryMcpToolCount: 4,
  attachedMcpSourceCount: 2,
  projectedMcpSourceCount: 1,
  selectedMcpServerCount: 2,
  materializedMcpServerCount: 1,
  runnerVisibleMcpServerCount: 2,
  reviewedMcpToolCount: 6,
  mcpConfigProjected: true,
  mcpTransportCounts: {
    stdio: 1,
    http: 0,
    sse: 0,
  },
  selectedSkillSourceCount: 3,
  selectedSkillDisplayCount: 3,
  selectedSkillSecretEnvCount: 2,
  semanticCapabilityCount: 5,
  runtimeAccessCount: 6,
  browserIpcEnabled: true,
  memoryIpcActionCount: 2,
  deepAgentCheckpointerConfigured: true,
  sandbox: {
    provider: 'sandbox_runtime' as const,
    enforcing: true,
    allowedNetworkHostCount: 4,
    protectedReadPathCount: 5,
    protectedWritePathCount: 6,
    localCliCredentialPathCount: 1,
    warmTemplateAvailable: true,
    warmTemplateCacheHit: true,
  },
  egress: {
    proxyConfigured: true,
    upstreamProxyConfigured: false,
  },
  credentials: {
    brokerApplied: true,
    credentialProviderCount: 1,
    modelCredentialEnvKeyCount: 2,
  },
  prompt: {
    compiledSystemPromptChars: 123,
  },
};

describe('agent-spawn startup diagnostics', () => {
  it('counts JSON string arrays defensively', () => {
    expect(countJsonStringArray('["send_message","file",7]')).toBe(2);
    expect(countJsonStringArray('{"tool":"send_message"}')).toBe(0);
    expect(countJsonStringArray('not-json')).toBe(0);
    expect(countJsonStringArray(undefined)).toBe(0);
  });

  it('builds a host startup diagnostic with normalized routing and safe counts', () => {
    const event = buildRunnerHostStartupDiagnosticEvent(baseDiagnostic);

    expect(event).toMatchObject({
      appId: 'app-one',
      agentId: 'agent-one',
      runId: 'run-one',
      jobId: 'job-one',
      conversationId: 'conversation:whatsapp:group-one',
      threadId: 'thread:whatsapp:group-one:reply-one',
      eventType: 'run.startup_diagnostic',
      actor: 'runtime',
      responseMode: 'none',
      payload: {
        provider: 'host',
        diagnostic: 'host_startup_projection',
        agentEngine: 'deepagents',
        executionProviderId: 'deepagents:langchain',
        selectedSkillSourceCount: 3,
        materializedMcpServerCount: 1,
        sandbox: {
          provider: 'sandbox_runtime',
          enforcing: true,
          protectedReadPathCount: 5,
        },
      },
    });
    expect(JSON.stringify(event)).not.toContain('/tmp/');
    expect(JSON.stringify(event)).not.toContain('API_KEY');
    expect(JSON.stringify(event)).not.toContain('http://127.0.0.1');
  });

  it('does not fail the run when diagnostic persistence fails', async () => {
    const publishRuntimeEvent = vi.fn(async () => {
      throw new Error('store unavailable');
    });
    const logger = { warn: vi.fn() };

    await expect(
      publishRunnerHostStartupDiagnosticFromSpawn({
        publishRuntimeEvent,
        logger,
        agentInput: {
          agentId: baseDiagnostic.agentId,
          runId: baseDiagnostic.runId,
          jobId: baseDiagnostic.jobId,
          chatJid: baseDiagnostic.conversationId,
          threadId: baseDiagnostic.threadId,
          attachedSkillSourceIds: [],
          selectedSkillDisplays: [],
        } as never,
        runnerAppId: baseDiagnostic.appId,
        agentEngine: baseDiagnostic.agentEngine,
        executionProviderId: baseDiagnostic.executionProviderId,
        hostPhases: baseDiagnostic.hostPhases,
        snapshot: {
          preparedEnv: {},
          attachedMcpSourceIds: [],
          projectedMcpSourceIds: [],
          selectedMcpServerNames: [],
          allMcpCapabilities: [],
          runnerVisibleMcpServerNames: [],
          reviewedMcpToolNames: [],
          selectedSkillEnv: { env: {} },
          runnerInput: {},
          effectiveRuntimeAccess: [],
          browserIpcEnabled: false,
          memoryIpcAllowedActions: [],
          runnerSandboxProviderId: 'none',
          runnerSandboxEnforcing: false,
          finalAllowedNetworkHosts: [],
          sandboxProtectedReadPaths: [],
          sandboxProtectedWritePaths: [],
          localCliCredentialPaths: [],
          sandboxWarmTemplate: { available: false, cacheHit: false },
          egressProxyConfigured: false,
          upstreamProxyConfigured: false,
          hostCredentials: {
            brokerApplied: false,
            credentialProviders: {},
          },
          compiledSystemPrompt: '',
        } as never,
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        appId: 'app-one',
      }),
      'Runner host startup diagnostic persistence failed',
    );
  });
});
