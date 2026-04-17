import fs from 'fs';
import path from 'path';

import {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../core/types.js';
import { IpcDeps } from './ipc-domain-types.js';

export async function processPermissionIpcRequest(
  request: PermissionApprovalRequest,
  deps: Pick<IpcDeps, 'requestPermissionApproval'>,
): Promise<PermissionApprovalDecision> {
  return deps.requestPermissionApproval(request);
}

export async function processUserQuestionIpcRequest(
  request: UserQuestionRequest,
  deps: Pick<IpcDeps, 'requestUserAnswer'>,
): Promise<UserQuestionResponse> {
  return deps.requestUserAnswer(request);
}

function toTrimmedString(
  value: unknown,
  opts: { maxLen?: number } = {},
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (opts.maxLen && trimmed.length > opts.maxLen) return undefined;
  return trimmed;
}

export function writePermissionIpcResponse(
  ipcBaseDir: string,
  sourceGroup: string,
  decision: PermissionApprovalDecision & { requestId: string },
): void {
  const responseDir = path.join(
    ipcBaseDir,
    sourceGroup,
    'permission-responses',
  );
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `${decision.requestId}.json`);
  const tmpPath = `${responsePath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    JSON.stringify(
      {
        requestId: decision.requestId,
        approved: decision.approved,
        ...(decision.decidedBy ? { decidedBy: decision.decidedBy } : {}),
        ...(decision.reason ? { reason: decision.reason } : {}),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tmpPath, responsePath);
}

export function writeUserQuestionIpcResponse(
  ipcBaseDir: string,
  sourceGroup: string,
  response: UserQuestionResponse,
): void {
  const responseDir = path.join(ipcBaseDir, sourceGroup, 'user-answers');
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `${response.requestId}.json`);
  const tmpPath = `${responsePath}.tmp`;
  const safeAnswers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(response.answers || {})) {
    const safeKey = toTrimmedString(key, { maxLen: 500 });
    if (!safeKey) continue;
    if (typeof value === 'string') {
      safeAnswers[safeKey] = value.slice(0, 500);
      continue;
    }
    if (Array.isArray(value)) {
      const filtered = value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.slice(0, 200))
        .slice(0, 20);
      safeAnswers[safeKey] = filtered;
    }
  }
  fs.writeFileSync(
    tmpPath,
    JSON.stringify(
      {
        requestId: response.requestId,
        answers: safeAnswers,
        ...(response.answeredBy ? { answeredBy: response.answeredBy } : {}),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tmpPath, responsePath);
}
