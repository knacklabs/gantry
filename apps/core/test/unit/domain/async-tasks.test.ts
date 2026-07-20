import { describe, expect, it } from 'vitest';

import {
  toPublicAsyncTaskDto,
  type AsyncTaskRecord,
} from '../../../src/domain/ports/async-tasks.js';

function task(
  receiptJson: AsyncTaskRecord['receiptJson'],
  overrides: Partial<AsyncTaskRecord> = {},
): AsyncTaskRecord {
  return {
    id: 'task-1',
    appId: 'app-1',
    agentId: 'agent-1',
    conversationId: 'conversation-1',
    kind: 'async_command',
    status: 'completed',
    admissionClass: 'task',
    authoritySnapshotJson: {},
    privateCorrelationJson: {},
    leaseToken: 'lease-1',
    fencingVersion: 1,
    createdAt: '2026-06-22T00:00:00.000Z',
    updatedAt: '2026-06-22T00:00:00.000Z',
    terminalAt: '2026-06-22T00:00:00.000Z',
    receiptJson,
    ...overrides,
  };
}

describe('toPublicAsyncTaskDto', () => {
  it('collapses pure answer receipts to one line', () => {
    expect(
      toPublicAsyncTaskDto(
        task({
          completed: 'answered',
          used: 'none',
          changed: 'none',
          delegated: 'no',
          needsAttention: 'none',
        }),
      ).receiptLines,
    ).toEqual(['answered']);
  });

  it('keeps full receipts when work used tools', () => {
    expect(
      toPublicAsyncTaskDto(
        task({
          completed: 'cancelled',
          used: 'RunCommand',
          changed: 'none',
          delegated: 'no',
          needsAttention: 'none',
        }),
      ).receiptLines,
    ).toEqual(['cancelled', 'I used RunCommand.']);
  });

  it('exposes only bounded public progress for running async commands', () => {
    const dto = toPublicAsyncTaskDto(
      task(null, {
        status: 'running',
        heartbeatAt: '2026-06-22T00:00:03.000Z',
        terminalAt: null,
        privateCorrelationJson: {
          process: {
            pid: 12345,
            processGroupId: 12345,
            detached: true,
            platform: process.platform,
            ownerPid: process.pid,
            startedAt: '2026-06-22T00:00:00.000Z',
          },
          progress: {
            phase: 'running',
            stdoutTail: 'safe stdout tail',
            stderrTail: 'safe stderr tail',
            stdout: 'unbounded stdout must stay private',
            stderr: 'unbounded stderr must stay private',
            privateCorrelationJson: { nested: true },
            leaseToken: 'nested-lease',
            fencingVersion: 7,
          },
        },
      }),
    );

    expect(dto).toMatchObject({
      id: 'task-1',
      kind: 'async_command',
      status: 'running',
      currentPhase: 'running',
      heartbeatAt: '2026-06-22T00:00:03.000Z',
      elapsedMs: expect.any(Number),
      stdoutTail: 'safe stdout tail',
      stderrTail: 'safe stderr tail',
      allowedActions: ['get', 'list', 'cancel'],
    });
    expect(dto.elapsedMs).toBeGreaterThanOrEqual(0);
    const publicJson = JSON.stringify(dto);
    expect(publicJson).not.toContain('privateCorrelationJson');
    expect(publicJson).not.toContain('process');
    expect(publicJson).not.toContain('leaseToken');
    expect(publicJson).not.toContain('fencingVersion');
    expect(publicJson).not.toContain('unbounded stdout');
    expect(publicJson).not.toContain('unbounded stderr');
  });

  it('exposes running async MCP heartbeat without process output', () => {
    const dto = toPublicAsyncTaskDto(
      task(null, {
        kind: 'mcp_tool_call',
        status: 'running',
        heartbeatAt: '2026-06-22T00:00:03.000Z',
        terminalAt: null,
        privateCorrelationJson: {
          progress: {
            phase: 'running',
            lastProgress: 'MCP tool running.',
            lastToolSummary: 'crm.create_deal',
            stdoutTail: 'must stay hidden',
            stderrTail: 'must stay hidden',
          },
        },
      }),
    );

    expect(dto).toMatchObject({
      kind: 'mcp_tool_call',
      status: 'running',
      currentPhase: 'running',
      lastProgress: 'MCP tool running.',
      lastToolSummary: 'crm.create_deal',
      heartbeatAt: '2026-06-22T00:00:03.000Z',
      elapsedMs: expect.any(Number),
      stdoutTail: null,
      stderrTail: null,
      allowedActions: ['get', 'list', 'cancel'],
    });
  });

  it('hides cancel for terminal tasks', () => {
    expect(toPublicAsyncTaskDto(task(null)).allowedActions).toEqual([
      'get',
      'list',
    ]);
  });
});
