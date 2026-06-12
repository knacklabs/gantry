import { describe, expect, it } from 'vitest';

import {
  buildAgentToolExecutionRequest,
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '@core/shared/tool-execution-policy-service.js';

const classifier = new ToolExecutionClassifier();
const policy = new ToolExecutionPolicyService();

describe('buildAgentToolExecutionRequest', () => {
  it('normalizes interactive runs without a job scope', () => {
    const request = buildAgentToolExecutionRequest(
      classifier,
      'Bash',
      { command: 'npm test' },
      { conversationId: 'tg:test', threadId: 'topic-7', jobId: 'job-1' },
    );

    expect(request).toMatchObject({
      origin: 'sdk',
      toolName: 'Bash',
      executionMode: 'interactive',
      runContext: {
        conversationId: 'tg:test',
        threadId: 'topic-7',
        jobId: undefined,
      },
    });
  });

  it('normalizes scheduled runs as autonomous and threads the job id', () => {
    const request = buildAgentToolExecutionRequest(
      classifier,
      'Bash',
      { command: 'npm test' },
      { isScheduledJob: true, conversationId: 'tg:test', jobId: 'job-1' },
    );

    expect(request).toMatchObject({
      executionMode: 'autonomous',
      runContext: { jobId: 'job-1', conversationId: 'tg:test' },
    });
  });

  it('feeds the policy service for the gate decision outcomes', () => {
    const interactive = (toolInput: unknown) =>
      buildAgentToolExecutionRequest(classifier, 'Bash', toolInput, {
        conversationId: 'tg:test',
      });
    const autonomous = (toolInput: unknown) =>
      buildAgentToolExecutionRequest(classifier, 'Bash', toolInput, {
        isScheduledJob: true,
        conversationId: 'tg:test',
        jobId: 'job-1',
      });

    // allow: interactive request matched by a selected capability rule
    expect(
      policy.evaluate({
        request: interactive({ command: 'npm test' }),
        allowedToolRules: ['RunCommand(npm test *)'],
      }).status,
    ).toBe('allow');

    // not_applicable: interactive request with no matching rule (gate then prompts)
    expect(
      policy.evaluate({
        request: interactive({ command: 'npm test' }),
        allowedToolRules: [],
      }).status,
    ).toBe('not_applicable');

    // deny: autonomous request with no allowlist match
    expect(
      policy.evaluate({
        request: autonomous({ command: 'npm test' }),
        autonomousAllowedToolRules: [],
      }).status,
    ).toBe('deny');

    // allow: autonomous request matched by an autonomous rule
    expect(
      policy.evaluate({
        request: autonomous({ command: 'npm test' }),
        autonomousAllowedToolRules: ['RunCommand(npm test *)'],
      }).status,
    ).toBe('allow');
  });

  it('keeps protected-capability targets denied regardless of execution mode', () => {
    const request = buildAgentToolExecutionRequest(
      classifier,
      'Write',
      { file_path: '/repo/.mcp.json', content: '{}' },
      { conversationId: 'tg:test' },
    );

    expect(policy.evaluate({ request })).toMatchObject({
      status: 'deny',
      reason: expect.stringContaining('MCP capability'),
    });
  });
});
