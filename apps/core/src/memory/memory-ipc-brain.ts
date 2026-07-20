import type { MemoryIpcResponse } from '@gantry/contracts';

import { createRuntimeBrainService } from '../brain/brain-runtime.js';
import { nowMs } from '../shared/time/datetime.js';
import {
  assertMemoryRequestNotExpired,
  deadlineUnavailableResponse,
  hasEnoughMemoryBudget,
  runWithinMemoryDeadline,
} from './memory-ipc-deadline.js';

const BRAIN_IPC_PROVIDER = 'postgres';

interface BrainIpcRequest {
  requestId: string;
  payload: Record<string, unknown>;
  appId: string;
  agentId: string;
  deadlineAtMs?: number;
}

export async function processBrainSearchRequest(
  request: BrainIpcRequest,
): Promise<MemoryIpcResponse> {
  const query = String(request.payload.query || '').trim();
  if (!query) throw new Error('query is required');
  const appId = request.appId;
  const brain = createRuntimeBrainService(appId);
  if (!hasEnoughMemoryBudget(request, nowMs)) {
    return deadlineUnavailableResponse(request, BRAIN_IPC_PROVIDER);
  }
  const searchResult = await runWithinMemoryDeadline(
    request,
    () =>
      brain.search({
        appId,
        query,
        ...(request.payload.limit
          ? { limit: Number(request.payload.limit) }
          : {}),
      }),
    nowMs,
  );
  if (searchResult.status === 'deadline_exceeded') {
    return deadlineUnavailableResponse(request, BRAIN_IPC_PROVIDER);
  }
  return {
    ok: true,
    requestId: request.requestId,
    provider: BRAIN_IPC_PROVIDER,
    data: { results: searchResult.value },
  };
}

export async function processBrainQueryRequest(
  request: BrainIpcRequest,
): Promise<MemoryIpcResponse> {
  const question = String(request.payload.question || '').trim();
  if (!question) throw new Error('question is required');
  const appId = request.appId;
  const brain = createRuntimeBrainService(appId);
  if (!hasEnoughMemoryBudget(request, nowMs)) {
    return deadlineUnavailableResponse(request, BRAIN_IPC_PROVIDER);
  }
  const queryResult = await runWithinMemoryDeadline(
    request,
    (signal, timeoutMs) =>
      brain.query({
        appId,
        question,
        signal,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(request.payload.limit
          ? { limit: Number(request.payload.limit) }
          : {}),
      }),
    nowMs,
  );
  if (queryResult.status === 'deadline_exceeded') {
    return deadlineUnavailableResponse(request, BRAIN_IPC_PROVIDER);
  }
  return {
    ok: true,
    requestId: request.requestId,
    provider: BRAIN_IPC_PROVIDER,
    data: { query: queryResult.value },
  };
}

export async function processBrainWriteRequest(
  request: BrainIpcRequest,
): Promise<MemoryIpcResponse> {
  const slug = String(request.payload.slug || '').trim();
  const markdown = String(request.payload.markdown || '').trim();
  if (!slug || !markdown) {
    throw new Error('slug and markdown are required');
  }
  const appId = request.appId;
  const brain = createRuntimeBrainService(appId);
  assertMemoryRequestNotExpired(request, nowMs);
  const result = await brain.write({
    appId,
    slug,
    markdown,
    title:
      typeof request.payload.title === 'string'
        ? request.payload.title
        : undefined,
    sourceKind: 'agent',
    sourceRef:
      typeof request.payload.source_ref === 'string'
        ? request.payload.source_ref
        : 'mcp-tool',
    authorId: request.agentId,
  });
  return {
    ok: true,
    requestId: request.requestId,
    provider: BRAIN_IPC_PROVIDER,
    data: result,
  };
}
