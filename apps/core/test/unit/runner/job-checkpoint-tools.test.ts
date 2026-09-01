import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const waitForTaskResponse = vi.hoisted(() => vi.fn());
const writeIpcFile = vi.hoisted(() => vi.fn());
const submitTaskLifecycleDataRequest = vi.hoisted(() => vi.fn());
const settleCaptchaChallenge = vi.hoisted(() => vi.fn());
const captchaEvidenceForChallenge = vi.hoisted(() => vi.fn());
const handleFileToolAction = vi.hoisted(() => vi.fn());

vi.mock('@core/runner/mcp/context.js', () => ({
  chatJid: 'app:test:conversation',
  jobId: 'job-1',
  jobRunId: 'run-1',
  jobRunLeaseFencingVersion: 1,
  jobRunLeaseToken: 'lease-token',
  TASKS_DIR: '/tmp/tasks',
  threadId: undefined,
}));
vi.mock('@core/runner/mcp/ipc.js', () => ({
  waitForTaskResponse,
  writeIpcFile,
}));
vi.mock('@core/runner/mcp/tools/task-lifecycle.js', () => ({
  submitTaskLifecycleDataRequest,
}));
vi.mock('@core/runner/mcp/tools/browser.js', () => ({
  settleCaptchaChallenge,
  captchaEvidenceForChallenge,
}));
vi.mock('@core/runner/mcp/tools/file.js', () => ({
  handleFileToolAction,
}));

import { registerJobCheckpointTools } from '@core/runner/mcp/tools/job-checkpoint.js';

class TestMcpServer {
  readonly tools = new Map<string, (args: any) => Promise<any>>();
  readonly schemas = new Map<string, unknown>();
  tool(
    name: string,
    _description: string,
    schema: unknown,
    handler: (args: any) => Promise<any>,
  ) {
    this.schemas.set(name, schema);
    this.tools.set(name, handler);
  }
}

const checkpoint = {
  idempotencyKey: 'human-wait-1',
  expectedPreviousSequence: 1,
  milestone: 'human_wait',
  safePhase: 'human_wait',
  artifactRefs: [],
  pendingInteractionRef: 'captcha-1',
  nextAction: 'Wait for an administrator CAPTCHA answer.',
  cumulativeRuntimeMs: 1_000,
};

const captchaInteraction = () => ({
  toolName: 'website_recipe_request_human',
  toolInput: {
    version: 2,
    requestId: 'request-1',
    attemptId: 'attempt-1',
    type: 'captcha',
    reason: 'Automatic attempts exhausted.',
    checkpointRef: null,
    automaticAttemptEvidenceRef: null,
    permissionScope: { origin: null, methods: [] },
    evidenceRefs: [],
  },
  browserChallenge: {
    challengeId: 'captcha-1',
    answerResultField: 'humanAnswer',
  },
});

describe('job checkpoint MCP tools', () => {
  beforeEach(() => {
    waitForTaskResponse.mockReset();
    writeIpcFile.mockReset();
    submitTaskLifecycleDataRequest.mockReset();
    settleCaptchaChallenge.mockReset();
    captchaEvidenceForChallenge.mockReset();
    captchaEvidenceForChallenge.mockReturnValue({
      challengeId: 'captcha-1',
      challengeFingerprint: `sha256:${'a'.repeat(64)}`,
      screenshotEvidenceRef: 'file-artifact:image',
      automaticAttemptEvidenceRef: 'file-artifact:attempt',
    });
    handleFileToolAction.mockReset();
  });

  it('accepts an opaque caller-tool payload with an optional browser binding', () => {
    const server = new TestMcpServer();
    registerJobCheckpointTools(server as never);
    const schema = z.object(
      server.schemas.get('job_checkpoint_save') as z.ZodRawShape,
    );

    const parsed = schema.parse({
      ...checkpoint,
      humanInteraction: captchaInteraction(),
    });

    expect(parsed.humanInteraction).toEqual(captchaInteraction());
  });

  it('accepts explicit nulls for absent generic checkpoint references', () => {
    const server = new TestMcpServer();
    registerJobCheckpointTools(server as never);
    const schema = z.object(
      server.schemas.get('job_checkpoint_save') as z.ZodRawShape,
    );

    const parsed = schema.parse({
      ...checkpoint,
      evaluatorInvocationRef: null,
      pendingInteractionRef: null,
    });

    expect(parsed.evaluatorInvocationRef).toBeNull();
    expect(parsed.pendingInteractionRef).toBeNull();
  });

  it('saves an ordinary checkpoint without opening an interaction', async () => {
    waitForTaskResponse.mockResolvedValueOnce({
      ok: true,
      data: { id: 'checkpoint-2', sequence: 2, milestone: 'human_wait' },
    });
    const server = new TestMcpServer();
    registerJobCheckpointTools(server as never);

    const result = await server.tools.get('job_checkpoint_save')?.(checkpoint);

    expect(result.isError).not.toBe(true);
    expect(writeIpcFile).toHaveBeenCalledOnce();
    expect(submitTaskLifecycleDataRequest).not.toHaveBeenCalled();
  });

  it('creates the typed interaction and settles CAPTCHA without exposing the answer', async () => {
    waitForTaskResponse.mockResolvedValueOnce({
      ok: true,
      data: { id: 'checkpoint-2', sequence: 2, milestone: 'human_wait' },
    });
    submitTaskLifecycleDataRequest.mockResolvedValueOnce({
      ok: true,
      data: { humanAnswer: 'ephemeral-secret' },
    });
    settleCaptchaChallenge.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'CAPTCHA accepted.' }],
    });
    const server = new TestMcpServer();
    registerJobCheckpointTools(server as never);

    const result = await server.tools.get('job_checkpoint_save')?.({
      ...checkpoint,
      humanInteraction: captchaInteraction(),
    });

    expect(submitTaskLifecycleDataRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'caller_resolved_tool',
        payload: expect.objectContaining({
          toolName: 'website_recipe_request_human',
          interactionId: expect.stringMatching(/^interaction_[0-9a-f-]{36}$/u),
          captchaChallengeId: 'captcha-1',
          toolInput: expect.not.objectContaining({
            captchaChallengeId: expect.anything(),
          }),
        }),
      }),
    );
    expect(writeIpcFile).toHaveBeenCalledWith(
      '/tmp/tasks',
      expect.objectContaining({
        payload: expect.objectContaining({
          idempotencyKey: expect.stringMatching(
            /^browser-challenge:[a-f0-9]{64}$/u,
          ),
          pendingInteractionRef: expect.stringMatching(
            /^interaction_[0-9a-f-]{36}$/u,
          ),
        }),
      }),
    );
    expect(settleCaptchaChallenge).toHaveBeenCalledWith(
      'captcha-1',
      'ephemeral-secret',
      30_000,
      'human',
      'file-artifact:attempt',
    );
    expect(JSON.stringify(result)).not.toContain('ephemeral-secret');
    expect(result.isError).not.toBe(true);
  });

  it('reopens a missing human interaction when the checkpoint save is replayed', async () => {
    const persistedInteractionId = `interaction_${'1'.repeat(8)}-${'2'.repeat(4)}-4${'3'.repeat(3)}-a${'4'.repeat(3)}-${'5'.repeat(12)}`;
    waitForTaskResponse.mockResolvedValueOnce({
      ok: true,
      data: {
        outcome: 'replayed',
        checkpoint: {
          id: 'checkpoint-2',
          sequence: 2,
          milestone: 'human_wait',
          payload: { pendingInteractionRef: persistedInteractionId },
        },
      },
    });
    submitTaskLifecycleDataRequest.mockResolvedValueOnce({
      ok: true,
      data: { humanAnswer: 'ephemeral-secret' },
    });
    settleCaptchaChallenge.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'CAPTCHA accepted.' }],
    });
    const server = new TestMcpServer();
    registerJobCheckpointTools(server as never);

    await server.tools.get('job_checkpoint_save')?.({
      ...checkpoint,
      humanInteraction: captchaInteraction(),
    });

    expect(submitTaskLifecycleDataRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          interactionId: persistedInteractionId,
        }),
      }),
    );
  });

  it('keeps repairable caller-resolution feedback inside the agent loop', async () => {
    waitForTaskResponse.mockResolvedValueOnce({
      ok: true,
      data: {
        outcome: 'persisted',
        checkpoint: {
          id: 'checkpoint-2',
          sequence: 2,
          milestone: 'human_wait',
        },
      },
    });
    waitForTaskResponse.mockResolvedValueOnce({
      ok: true,
      data: {
        outcome: 'persisted',
        checkpoint: {
          id: 'checkpoint-3',
          sequence: 3,
          milestone: 'needs_review',
        },
      },
    });
    submitTaskLifecycleDataRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 'fresh_captcha_required',
        retryable: true,
        nextAction: 'Capture four fresh automatic attempts.',
      },
    });
    const server = new TestMcpServer();
    registerJobCheckpointTools(server as never);

    const result = await server.tools.get('job_checkpoint_save')?.({
      ...checkpoint,
      humanInteraction: captchaInteraction(),
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('fresh_captcha_required');
    expect(JSON.stringify(result)).toContain(
      'Capture four fresh automatic attempts.',
    );
    expect(settleCaptchaChallenge).not.toHaveBeenCalled();
    expect(writeIpcFile).toHaveBeenLastCalledWith(
      '/tmp/tasks',
      expect.objectContaining({
        payload: expect.objectContaining({
          milestone: 'interaction_resolution_failed',
          expectedPreviousSequence: 2,
        }),
      }),
    );
  });

  it('returns invalid checkpoint validation as repairable agent feedback', async () => {
    waitForTaskResponse.mockResolvedValueOnce({
      ok: false,
      code: 'invalid_checkpoint',
      error: 'Artifact is outside the immutable job scope.',
      details: ['authoritativeArtifactRefs=[]'],
    });
    const server = new TestMcpServer();
    registerJobCheckpointTools(server as never);

    const result = await server.tools.get('job_checkpoint_save')?.({
      ...checkpoint,
      milestone: 'inventory_completed',
      humanInteraction: undefined,
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('invalid_checkpoint');
    expect(JSON.stringify(result)).toContain('retryable');
  });

  it('leaves product artifact semantics to the caller-owned checkpoint schema', async () => {
    handleFileToolAction.mockResolvedValueOnce(
      JSON.stringify({
        claims: [{ capability: 'captcha', status: 'blocked' }],
      }),
    );
    waitForTaskResponse.mockResolvedValueOnce({
      ok: true,
      data: { outcome: 'persisted', checkpoint: { sequence: 2 } },
    });
    const server = new TestMcpServer();
    registerJobCheckpointTools(server as never);

    const result = await server.tools.get('job_checkpoint_save')?.({
      ...checkpoint,
      milestone: 'candidate_created',
      humanInteraction: undefined,
      artifactRefs: [
        {
          artifactId: 'file-artifact:inventory',
          contentHash: `sha256:${'a'.repeat(64)}`,
          kind: 'observation_inventory',
        },
      ],
    });

    expect(result.isError).not.toBe(true);
    expect(writeIpcFile).toHaveBeenCalledOnce();
  });

  it('allows an unresolved CAPTCHA review after four validated automatic attempts', async () => {
    handleFileToolAction
      .mockResolvedValueOnce(
        JSON.stringify({
          claims: [{ capability: 'captcha', status: 'blocked' }],
        }),
      )
      .mockResolvedValueOnce(JSON.stringify({ attemptNumber: 4 }));
    waitForTaskResponse.mockResolvedValueOnce({
      ok: true,
      data: {
        outcome: 'persisted',
        checkpoint: { id: 'checkpoint-2', sequence: 2 },
      },
    });
    const server = new TestMcpServer();
    registerJobCheckpointTools(server as never);

    const result = await server.tools.get('job_checkpoint_save')?.({
      ...checkpoint,
      milestone: 'needs_review',
      humanInteraction: undefined,
      artifactRefs: [
        {
          artifactId: 'file-artifact:inventory',
          contentHash: `sha256:${'a'.repeat(64)}`,
          kind: 'observation_inventory',
        },
        {
          artifactId: 'file-artifact:attempt',
          contentHash: `sha256:${'b'.repeat(64)}`,
          kind: 'captcha_attempt_evidence',
        },
      ],
    });

    expect(result.isError).not.toBe(true);
    expect(writeIpcFile).toHaveBeenCalledOnce();
  });

  it('allows needs_review when CAPTCHA presence is unproven because the website is unavailable', async () => {
    handleFileToolAction.mockResolvedValueOnce(
      JSON.stringify({
        claims: [{ capability: 'captcha', status: 'unproven' }],
      }),
    );
    waitForTaskResponse.mockResolvedValueOnce({
      ok: true,
      data: {
        outcome: 'persisted',
        checkpoint: { id: 'checkpoint-2', sequence: 2 },
      },
    });
    const server = new TestMcpServer();
    registerJobCheckpointTools(server as never);

    const result = await server.tools.get('job_checkpoint_save')?.({
      ...checkpoint,
      milestone: 'needs_review',
      humanInteraction: undefined,
      artifactRefs: [
        {
          artifactId: 'file-artifact:inventory',
          contentHash: `sha256:${'a'.repeat(64)}`,
          kind: 'observation_inventory',
        },
      ],
    });

    expect(result.isError).not.toBe(true);
    expect(writeIpcFile).toHaveBeenCalledOnce();
  });

  it('does not interpret product-specific success evidence in the generic runtime', async () => {
    handleFileToolAction
      .mockResolvedValueOnce(
        JSON.stringify({
          claims: [{ capability: 'captcha', status: 'observed' }],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ outcome: 'submitted', attemptNumber: 1 }),
      );
    waitForTaskResponse.mockResolvedValueOnce({
      ok: true,
      data: { outcome: 'persisted', checkpoint: { sequence: 2 } },
    });
    const server = new TestMcpServer();
    registerJobCheckpointTools(server as never);

    const result = await server.tools.get('job_checkpoint_save')?.({
      ...checkpoint,
      milestone: 'candidate_created',
      humanInteraction: undefined,
      artifactRefs: [
        {
          artifactId: 'file-artifact:inventory',
          contentHash: `sha256:${'a'.repeat(64)}`,
          kind: 'observation_inventory',
        },
        {
          artifactId: 'file-artifact:attempt',
          contentHash: `sha256:${'b'.repeat(64)}`,
          kind: 'captcha_attempt_evidence',
        },
      ],
    });

    expect(result.isError).not.toBe(true);
    expect(writeIpcFile).toHaveBeenCalledOnce();
  });

  it('allows a CAPTCHA-observed candidate with typed solved evidence', async () => {
    handleFileToolAction
      .mockResolvedValueOnce(
        JSON.stringify({
          claims: [{ capability: 'captcha', status: 'observed' }],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ outcome: 'solved_automatic', attemptNumber: 1 }),
      );
    waitForTaskResponse.mockResolvedValueOnce({
      ok: true,
      data: {
        outcome: 'persisted',
        checkpoint: { id: 'checkpoint-2', sequence: 2 },
      },
    });
    const server = new TestMcpServer();
    registerJobCheckpointTools(server as never);

    const result = await server.tools.get('job_checkpoint_save')?.({
      ...checkpoint,
      milestone: 'candidate_created',
      humanInteraction: undefined,
      artifactRefs: [
        {
          artifactId: 'file-artifact:inventory',
          contentHash: `sha256:${'a'.repeat(64)}`,
          kind: 'observation_inventory',
        },
        {
          artifactId: 'file-artifact:attempt',
          contentHash: `sha256:${'b'.repeat(64)}`,
          kind: 'captcha_attempt',
        },
      ],
    });

    expect(result.isError).not.toBe(true);
    expect(writeIpcFile).toHaveBeenCalledOnce();
  });

  it('recognizes the browser success artifact separately from its submitted attempt', async () => {
    handleFileToolAction
      .mockResolvedValueOnce(
        JSON.stringify({
          claims: [{ capability: 'captcha', status: 'observed' }],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ outcome: 'submitted', attemptNumber: 1 }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ outcome: 'solved_automatic', attemptNumber: 1 }),
      );
    waitForTaskResponse.mockResolvedValueOnce({
      ok: true,
      data: {
        outcome: 'persisted',
        checkpoint: { id: 'checkpoint-2', sequence: 2 },
      },
    });
    const server = new TestMcpServer();
    registerJobCheckpointTools(server as never);

    const result = await server.tools.get('job_checkpoint_save')?.({
      ...checkpoint,
      milestone: 'candidate_created',
      humanInteraction: undefined,
      artifactRefs: [
        {
          artifactId: 'file-artifact:inventory',
          contentHash: `sha256:${'a'.repeat(64)}`,
          kind: 'observation_inventory',
        },
        {
          artifactId: 'file-artifact:submitted-attempt',
          contentHash: `sha256:${'b'.repeat(64)}`,
          kind: 'solved_automatic',
        },
        {
          artifactId: 'file-artifact:success',
          contentHash: `sha256:${'c'.repeat(64)}`,
          kind: 'captcha_success',
        },
      ],
    });

    expect(result.isError).not.toBe(true);
    expect(writeIpcFile).toHaveBeenCalledOnce();
  });
});
