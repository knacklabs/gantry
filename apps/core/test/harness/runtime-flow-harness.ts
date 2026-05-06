import type { ChildProcess } from 'node:child_process';

import type { AgentOutput } from '@core/runtime/agent-spawn.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ConversationRoute,
  StreamingChunkOptions,
} from '@core/domain/types.js';

export interface RuntimeFlowHarness {
  readonly clock: { now(): string };
  readonly ids: { generate(): string };
  readonly channel: {
    sent: Array<{ jid: string; text: string; threadId?: string }>;
    streams: Array<{
      jid: string;
      text: string;
      options?: StreamingChunkOptions;
    }>;
    resets: string[];
    sendMessage(
      jid: string,
      text: string,
      options?: { threadId?: string },
    ): Promise<void>;
    sendStreamingChunk(
      jid: string,
      text: string,
      options?: StreamingChunkOptions,
    ): Promise<boolean>;
    resetStreaming(jid: string): void;
  };
  readonly runner: {
    calls: Array<{
      group: ConversationRoute;
      input: Record<string, unknown>;
    }>;
    result: AgentOutput;
    runAgent: (
      group: ConversationRoute,
      input: Record<string, unknown>,
      onProcess: (
        proc: ChildProcess,
        runHandle: string,
      ) => void | Promise<void>,
      onOutput?: (output: AgentOutput) => void | Promise<void>,
    ) => Promise<AgentOutput>;
  };
  readonly approvals: {
    requests: PermissionApprovalRequest[];
    nextDecision: PermissionApprovalDecision;
    requestPermissionApproval(
      jid: string,
      request: PermissionApprovalRequest,
    ): Promise<PermissionApprovalDecision>;
  };
  readonly broker: {
    injectedEnv: Record<string, string>;
    getRunnerEnv(): Promise<Record<string, string>>;
  };
}

export function createRuntimeFlowHarness(options?: {
  now?: string;
  runnerResult?: AgentOutput;
  approvalDecision?: PermissionApprovalDecision;
  brokerEnv?: Record<string, string>;
}): RuntimeFlowHarness {
  let idCounter = 0;
  const sent: RuntimeFlowHarness['channel']['sent'] = [];
  const streams: RuntimeFlowHarness['channel']['streams'] = [];
  const resets: string[] = [];
  const calls: RuntimeFlowHarness['runner']['calls'] = [];
  const requests: PermissionApprovalRequest[] = [];
  const runnerResult = options?.runnerResult ?? {
    status: 'success',
    result: 'runtime flow completed',
  };
  const approvalDecision = options?.approvalDecision ?? {
    approved: true,
    decidedBy: 'test-approver',
    reason: 'approved in runtime flow harness',
  };
  const injectedEnv = options?.brokerEnv ?? {};

  return {
    clock: { now: () => options?.now ?? '2026-04-28T00:00:00.000Z' },
    ids: { generate: () => `runtime-flow-id:${++idCounter}` },
    channel: {
      sent,
      streams,
      resets,
      async sendMessage(jid, text, sendOptions) {
        sent.push({ jid, text, threadId: sendOptions?.threadId });
      },
      async sendStreamingChunk(jid, text, streamOptions) {
        streams.push({ jid, text, options: streamOptions });
        return true;
      },
      resetStreaming(jid) {
        resets.push(jid);
      },
    },
    runner: {
      calls,
      result: runnerResult,
      async runAgent(group, input, _onProcess, onOutput) {
        calls.push({ group, input });
        await onOutput?.(runnerResult);
        return runnerResult;
      },
    },
    approvals: {
      requests,
      nextDecision: approvalDecision,
      async requestPermissionApproval(_jid, request) {
        requests.push(request);
        return approvalDecision;
      },
    },
    broker: {
      injectedEnv,
      async getRunnerEnv() {
        return { ...injectedEnv };
      },
    },
  };
}
