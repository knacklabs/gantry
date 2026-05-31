import fs from 'fs';
import path from 'path';
import {
  MemoryIpcAction,
  MEMORY_IPC_ACTIONS,
  MemoryIpcRequest,
  MemoryIpcResponse,
} from '@gantry/contracts';

import { signIpcResponsePayload } from '../infrastructure/ipc/response-signing.js';
import { nowMs } from '../shared/time/datetime.js';
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from '../shared/private-fs.js';
import { resolveWorkspaceIpcPath } from '../platform/workspace-folder.js';
import {
  DEFAULT_MEMORY_APP_ID,
  memoryAgentIdForWorkspaceFolder,
} from './app-memory-boundaries.js';
import {
  resolveScopedMemorySubject,
  canonicalConversationIdForMemory,
  searchInputForResolvedMemorySubject,
} from './app-memory-subject-resolver.js';
import { describeAppMemorySearchOutcome } from './app-memory-recall.js';
import { AppMemoryService } from './app-memory-service.js';
import {
  parseDemoteMemoryInput,
  parsePatchMemoryInput,
  parsePatchProcedureInput,
  parseSaveMemoryInput,
  parseSaveProcedureInput,
} from './memory-ipc-parsing.js';
export {
  parseOptionalNumber,
  parseOptionalString,
} from './memory-ipc-parsing.js';
import {
  assertMemoryRequestNotExpired,
  deadlineUnavailableResponse,
  hasEnoughMemoryBudget,
  runWithinMemoryDeadline,
} from './memory-ipc-deadline.js';
import {
  AppMemorySearchInput,
  AppMemorySearchResult,
  SaveMemoryInput,
  SaveProcedureInput,
} from './memory-types.js';
import {
  processMemoryReviewDecisionRequest,
  processPendingMemoryReviewRequest,
} from './memory-review-ipc.js';

const MEMORY_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

interface TrustedMemoryContext {
  threadId?: string;
  chatJid?: string;
  userId?: string;
  defaultScope?: 'user' | 'group';
  reviewerIsControlApprover?: boolean;
}

type TrustedMemoryRequest = Omit<MemoryIpcRequest, 'context'> & {
  context?: TrustedMemoryContext;
  allowedActions?: readonly MemoryIpcAction[];
  deadlineAtMs?: number;
};

const DEFAULT_ALLOWED_MEMORY_IPC_ACTIONS = new Set<MemoryIpcAction>([
  'memory_search',
  'memory_save',
  'continuity_summary',
  'procedure_save',
]);

type SubjectForMemoryIpc = ReturnType<typeof resolveTrustedMemorySubject>;
type MemoryDemoteService = {
  demote(input: Record<string, unknown>): Promise<unknown>;
};
type MemorySearchReadOnlyService = {
  searchReadOnly(
    input: AppMemorySearchInput,
    options?: { signal?: AbortSignal; statementTimeoutMs?: number },
  ): Promise<AppMemorySearchResult[]>;
  recordRecallEvents?(
    input: AppMemorySearchInput,
    results: AppMemorySearchResult[],
  ): Promise<void>;
};

function asMemoryDemoteService(memory: AppMemoryService): MemoryDemoteService {
  const candidate = memory as unknown as Partial<MemoryDemoteService>;
  if (typeof candidate.demote === 'function') {
    return candidate as MemoryDemoteService;
  }
  throw new Error(
    'memory demote service is unavailable; AppMemoryService.demote(input) is required',
  );
}

function asMemorySearchReadOnlyService(
  memory: AppMemoryService,
): MemorySearchReadOnlyService {
  const candidate = memory as unknown as Partial<MemorySearchReadOnlyService>;
  if (typeof candidate.searchReadOnly === 'function') {
    return candidate as MemorySearchReadOnlyService;
  }
  throw new Error(
    'memory read-only search service is unavailable; AppMemoryService.searchReadOnly(input) is required',
  );
}

function assertValidRequestId(requestId: string): void {
  if (!MEMORY_IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid memory IPC requestId');
  }
}

function assertMemoryActionAllowed(request: TrustedMemoryRequest): void {
  if (!MEMORY_IPC_ACTIONS.includes(request.action)) {
    throw new Error(`Unsupported memory action: ${request.action}`);
  }
  const allowedActions =
    request.allowedActions && request.allowedActions.length > 0
      ? new Set(request.allowedActions)
      : DEFAULT_ALLOWED_MEMORY_IPC_ACTIONS;
  if (!allowedActions.has(request.action)) {
    throw new Error(`Memory IPC action is not allowed: ${request.action}`);
  }
}

async function runMemoryMutation<T>(
  request: TrustedMemoryRequest,
  work: () => Promise<T>,
): Promise<T> {
  assertMemoryRequestNotExpired(request, nowMs);
  return work();
}

function continuityDeadlineUnavailableResponse(
  request: TrustedMemoryRequest,
  provider: string,
  subject: SubjectForMemoryIpc,
): MemoryIpcResponse {
  return {
    ok: true,
    requestId: request.requestId,
    provider,
    data: {
      continuity: {
        subject,
        overall_status: 'unavailable',
        sections: {
          memory_service: {
            status: 'unavailable',
            count: 0,
            items: [],
            reason: 'deadline_exceeded',
          },
        },
      },
    },
  };
}

export function resolveTrustedMemorySubject(
  sourceAgentFolder: string,
  context: TrustedMemoryContext | undefined,
  scope?: SaveMemoryInput['scope'] | SaveProcedureInput['scope'],
) {
  return resolveScopedMemorySubject({
    appId: DEFAULT_MEMORY_APP_ID,
    agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder),
    groupId: sourceAgentFolder,
    conversationId: canonicalConversationIdForMemory(context?.chatJid),
    userId: context?.userId,
    defaultScope: context?.defaultScope,
    ...(scope ? { scope } : {}),
  }).subject;
}

export async function processMemoryRequest(
  request: TrustedMemoryRequest,
  sourceAgentFolder: string,
): Promise<MemoryIpcResponse> {
  let provider = 'uninitialized';

  try {
    assertValidRequestId(request.requestId);
    assertMemoryActionAllowed(request);
    assertMemoryRequestNotExpired(request, nowMs);
    const getMemory = (): AppMemoryService => {
      const memory = AppMemoryService.getInstance();
      provider = 'postgres';
      return memory;
    };
    switch (request.action) {
      case 'memory_search': {
        const query = String(request.payload.query || '').trim();
        if (!query) {
          throw new Error('query is required');
        }
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        // IPC memory reads are always scoped to the source group to prevent
        // cross-group data access from agent processes.
        const searchInput = {
          query,
          ...searchInputForResolvedMemorySubject(subject),
          ...(request.payload.limit
            ? { limit: Number(request.payload.limit) }
            : {}),
        };
        if (!hasEnoughMemoryBudget(request, nowMs)) {
          provider = 'postgres';
          const outcome = describeAppMemorySearchOutcome(searchInput, 0);
          return {
            ok: true,
            requestId: request.requestId,
            provider,
            data: {
              status: 'unavailable',
              unavailable_reason: 'deadline_exceeded',
              results: [],
              resolved_subject: outcome.resolvedSubject,
              ...(outcome.empty_reason
                ? { empty_reason: outcome.empty_reason }
                : {}),
            },
          };
        }
        const readOnlySearch = asMemorySearchReadOnlyService(getMemory());
        const searchResult = await runWithinMemoryDeadline(
          request,
          (signal, statementTimeoutMs) =>
            readOnlySearch.searchReadOnly(searchInput, {
              signal,
              statementTimeoutMs,
            }),
          nowMs,
        );
        if (searchResult.status === 'deadline_exceeded') {
          const outcome = describeAppMemorySearchOutcome(searchInput, 0);
          return {
            ok: true,
            requestId: request.requestId,
            provider,
            data: {
              status: 'unavailable',
              unavailable_reason: 'deadline_exceeded',
              results: [],
              resolved_subject: outcome.resolvedSubject,
              ...(outcome.empty_reason
                ? { empty_reason: outcome.empty_reason }
                : {}),
            },
          };
        }
        const results = searchResult.value;
        if (
          results.length > 0 &&
          typeof readOnlySearch.recordRecallEvents === 'function' &&
          request.deadlineAtMs === undefined
        ) {
          await runMemoryMutation(request, () =>
            readOnlySearch.recordRecallEvents!(searchInput, results),
          );
        }
        const outcome = describeAppMemorySearchOutcome(
          searchInput,
          results.length,
        );
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: {
            results,
            resolved_subject: outcome.resolvedSubject,
            ...(outcome.empty_reason
              ? { empty_reason: outcome.empty_reason }
              : {}),
          },
        };
      }
      case 'memory_save': {
        const input = parseSaveMemoryInput(request.payload);
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
          input.scope,
        );
        if (!hasEnoughMemoryBudget(request, nowMs)) {
          provider = 'postgres';
          return deadlineUnavailableResponse(request, provider);
        }
        const saved = await runMemoryMutation(request, () =>
          getMemory().save({
            ...subject,
            appId: subject.appId,
            agentId: subject.agentId,
            subjectType: subject.subjectType,
            kind: input.kind,
            key: input.key,
            value: input.value,
            why: input.why,
            confidence: input.confidence,
            source: input.source || 'mcp-tool',
            actorId: 'mcp-tool',
            isAdminWrite: false,
            evidenceText: input.why || input.value,
          }),
        );
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { memory: saved },
        };
      }
      case 'memory_patch': {
        const input = parsePatchMemoryInput(request.payload);
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        if (!hasEnoughMemoryBudget(request, nowMs)) {
          provider = 'postgres';
          return deadlineUnavailableResponse(request, provider);
        }
        const patched = await runMemoryMutation(request, () =>
          getMemory().patch({
            ...subject,
            id: input.id,
            appId: DEFAULT_MEMORY_APP_ID,
            agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder),
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            key: input.key,
            value: input.value,
            why: input.why,
            confidence: input.confidence,
            isPinned: input.load_bearing,
            expectedVersion: input.expected_version,
            isAdminWrite: false,
          }),
        );
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { memory: patched },
        };
      }
      case 'memory_demote': {
        const input = parseDemoteMemoryInput(request.payload);
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        if (!hasEnoughMemoryBudget(request, nowMs)) {
          provider = 'postgres';
          return deadlineUnavailableResponse(request, provider);
        }
        const demoted = await runMemoryMutation(request, () =>
          asMemoryDemoteService(getMemory()).demote({
            ...subject,
            appId: subject.appId,
            agentId: subject.agentId,
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            id: input.id,
            ...(input.expectedVersion !== undefined
              ? { expectedVersion: input.expectedVersion }
              : {}),
            ...(input.reason ? { reason: input.reason } : {}),
            actorId: 'mcp-tool',
            isAdminWrite: false,
          }),
        );
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { memory: demoted },
        };
      }
      case 'continuity_summary': {
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        if (!hasEnoughMemoryBudget(request, nowMs)) {
          provider = 'postgres';
          return continuityDeadlineUnavailableResponse(
            request,
            provider,
            subject,
          );
        }
        const continuityResult = await runWithinMemoryDeadline(
          request,
          (signal, statementTimeoutMs) =>
            getMemory().continuitySummary({
              ...subject,
              signal,
              statementTimeoutMs,
              ...(request.deadlineAtMs
                ? { deadlineAtMs: request.deadlineAtMs, nowMs: nowMs() }
                : {}),
            }),
          nowMs,
        );
        if (continuityResult.status === 'deadline_exceeded') {
          return continuityDeadlineUnavailableResponse(
            request,
            provider,
            subject,
          );
        }
        const continuity = continuityResult.value;
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { continuity },
        };
      }
      case 'memory_consolidate': {
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        if (!hasEnoughMemoryBudget(request, nowMs)) {
          provider = 'postgres';
          return deadlineUnavailableResponse(request, provider);
        }
        const result = await runMemoryMutation(request, () =>
          getMemory().triggerDreaming({
            ...subject,
            appId: subject.appId,
            agentId: subject.agentId,
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            phase: 'deep',
            dryRun: false,
          }),
        );
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { consolidation: result },
        };
      }
      case 'memory_dream': {
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        if (!hasEnoughMemoryBudget(request, nowMs)) {
          provider = 'postgres';
          return deadlineUnavailableResponse(request, provider);
        }
        const result = await runMemoryMutation(request, () =>
          getMemory().triggerDreaming({
            ...subject,
            appId: subject.appId,
            agentId: subject.agentId,
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            phase: 'all',
            dryRun: false,
          }),
        );
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { dreaming: result },
        };
      }
      case 'memory_review_pending': {
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        return await processPendingMemoryReviewRequest({ request, subject });
      }
      case 'memory_review_decision': {
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        return await processMemoryReviewDecisionRequest({ request, subject });
      }
      case 'procedure_save': {
        const input = parseSaveProcedureInput(request.payload);
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
          input.scope,
        );
        if (!hasEnoughMemoryBudget(request, nowMs)) {
          provider = 'postgres';
          return deadlineUnavailableResponse(request, provider);
        }
        const saved = await runMemoryMutation(request, () =>
          getMemory().save({
            ...subject,
            appId: subject.appId,
            agentId: subject.agentId,
            subjectType: subject.subjectType,
            kind: 'reference',
            key: `procedure:${input.title}`,
            value: input.body,
            why: input.trigger || undefined,
            confidence: input.confidence,
            source: input.source || 'mcp-tool',
            actorId: 'mcp-tool',
            isAdminWrite: false,
            evidenceText: input.body,
          }),
        );
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { procedure: saved },
        };
      }
      case 'procedure_patch': {
        const input = parsePatchProcedureInput(request.payload);
        const subject = resolveTrustedMemorySubject(
          sourceAgentFolder,
          request.context,
        );
        if (!hasEnoughMemoryBudget(request, nowMs)) {
          provider = 'postgres';
          return deadlineUnavailableResponse(request, provider);
        }
        const patched = await runMemoryMutation(request, () =>
          getMemory().patch({
            ...subject,
            id: input.id,
            appId: DEFAULT_MEMORY_APP_ID,
            agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder),
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            key: input.title ? `procedure:${input.title}` : undefined,
            value: input.body,
            confidence: input.confidence,
            why: input.trigger === null ? null : input.trigger,
            expectedVersion: input.expected_version,
            isAdminWrite: false,
          }),
        );
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { procedure: patched },
        };
      }
      default:
        throw new Error(`Unsupported memory action: ${request.action}`);
    }
  } catch (error) {
    return {
      ok: false,
      requestId: request.requestId,
      provider,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function writeMemoryResponse(
  workspaceFolder: string,
  requestId: string,
  response: MemoryIpcResponse,
  privateKeyPem?: string,
): void {
  assertValidRequestId(requestId);
  const ipcDir = resolveWorkspaceIpcPath(workspaceFolder);
  const responsesDir = path.join(ipcDir, 'memory-responses');
  ensurePrivateDirSync(responsesDir);

  const filePath = path.join(responsesDir, `${requestId}.json`);
  const tmpPath = `${filePath}.tmp`;
  const payload: Record<string, unknown> = {
    ok: response.ok,
    requestId: response.requestId,
    ...(response.provider ? { provider: response.provider } : {}),
    ...(response.data !== undefined ? { data: response.data } : {}),
    ...(response.error ? { error: response.error } : {}),
  };
  const signature = signIpcResponsePayload(privateKeyPem, payload);
  if (!signature) return;
  payload.signature = signature;
  writePrivateFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, filePath);
}
