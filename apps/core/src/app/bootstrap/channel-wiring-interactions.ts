import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../domain/types.js';
import { formatDuration } from '../../shared/human-format.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../../shared/permission-timeout.js';

type ChannelLike = object;

interface ChannelWiringInteractionsLogger {
  debug: (dataOrMsg: string | Record<string, unknown>, msg?: string) => void;
  error: (dataOrMsg: string | Record<string, unknown>, msg?: string) => void;
}

interface PermissionApprovalSurfaceLike {
  requestPermissionApproval: (
    targetJid: string,
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision>;
}

interface UserQuestionSurfaceLike {
  requestUserAnswer: (
    targetJid: string,
    request: UserQuestionRequest,
  ) => Promise<UserQuestionResponse>;
}

interface PermissionApprovalTargetResolution {
  targetJid: string;
  request: PermissionApprovalRequest;
}

interface PermissionApprovalTargetBlocked {
  blockedReason: string;
}

const permissionTimeoutDecision = (
  _request: PermissionApprovalRequest,
): PermissionApprovalDecision => ({
  approved: false,
  decidedBy: 'system',
  reason: `No approval received within ${formatDuration(PERMISSION_APPROVAL_TIMEOUT_MS)}. Retry when an approver is available.`,
  decisionClassification: 'user_reject',
});

function resolvePermissionApprovalTarget(
  request: PermissionApprovalRequest,
): PermissionApprovalTargetResolution | PermissionApprovalTargetBlocked {
  const targetJid = request.targetJid;
  if (!targetJid) {
    return { blockedReason: 'Permission approval target is missing' };
  }
  return { targetJid, request };
}

export function createPermissionApprovalRequester(input: {
  findBoundChannel: (jid: string) => ChannelLike | undefined;
  asPermissionApprovalSurface: (
    channel: ChannelLike,
  ) => PermissionApprovalSurfaceLike | undefined;
  logger: Pick<ChannelWiringInteractionsLogger, 'error'>;
}): (
  request: PermissionApprovalRequest,
) => Promise<PermissionApprovalDecision> {
  return async (
    request: PermissionApprovalRequest,
  ): Promise<PermissionApprovalDecision> => {
    if (!request.targetJid) {
      return {
        approved: false,
        reason: 'Permission approval target is missing',
      };
    }

    const routed = resolvePermissionApprovalTarget(request);
    if ('blockedReason' in routed) {
      return { approved: false, reason: routed.blockedReason };
    }
    const channel = input.findBoundChannel(routed.targetJid);
    const approvalSurface = channel
      ? input.asPermissionApprovalSurface(channel)
      : undefined;
    if (!approvalSurface) {
      return {
        approved: false,
        reason: 'Target channel does not support permission approvals',
      };
    }
    try {
      return await new Promise<PermissionApprovalDecision>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(permissionTimeoutDecision(request));
        }, PERMISSION_APPROVAL_TIMEOUT_MS);
        approvalSurface
          .requestPermissionApproval(routed.targetJid, routed.request)
          .then((decision) => {
            if (settled) {
              input.logger.error({
                targetJid: routed.targetJid,
                requestId: request.requestId,
                message: 'Late permission approval ignored after timeout',
              });
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(decision);
          })
          .catch((err: unknown) => {
            if (settled) {
              input.logger.error({
                err,
                targetJid: routed.targetJid,
                requestId: request.requestId,
                message:
                  'Late permission approval failure ignored after timeout',
              });
              return;
            }
            settled = true;
            clearTimeout(timer);
            input.logger.error({
              err,
              targetJid: routed.targetJid,
              requestId: request.requestId,
              message: 'Target channel permission approval flow failed',
            });
            resolve({
              approved: false,
              reason: 'Permission approval flow failed',
            });
          });
      });
    } catch (err) {
      input.logger.error({
        err,
        targetJid: routed.targetJid,
        requestId: request.requestId,
        message: 'Target channel permission approval flow failed',
      });
      return { approved: false, reason: 'Permission approval flow failed' };
    }
  };
}

export function createUserQuestionResponder(input: {
  findBoundChannel: (jid: string) => ChannelLike | undefined;
  asUserQuestionSurface: (
    channel: ChannelLike,
  ) => UserQuestionSurfaceLike | undefined;
  logger: ChannelWiringInteractionsLogger;
}): {
  requestUserAnswer: (
    request: UserQuestionRequest,
  ) => Promise<UserQuestionResponse>;
  clear: () => void;
} {
  const userQuestionResponseCache = new Map<string, UserQuestionResponse>();

  async function requestUserAnswer(
    request: UserQuestionRequest,
  ): Promise<UserQuestionResponse> {
    if (!request.targetJid) {
      return { requestId: request.requestId, answers: {} };
    }

    const requestKey = `${request.targetJid}:${request.requestId}`;
    const cached = userQuestionResponseCache.get(requestKey);
    if (cached) return cached;
    const channel = input.findBoundChannel(request.targetJid);
    const questionSurface = channel
      ? input.asUserQuestionSurface(channel)
      : undefined;
    if (!channel || !questionSurface) {
      return { requestId: request.requestId, answers: {} };
    }
    try {
      const response = await questionSurface.requestUserAnswer(
        request.targetJid,
        request,
      );
      userQuestionResponseCache.set(requestKey, response);
      return response;
    } catch (err) {
      input.logger.error({
        err,
        targetJid: request.targetJid,
        requestId: request.requestId,
        message: 'Target channel user question flow failed',
      });
      return { requestId: request.requestId, answers: {} };
    }
  }

  return {
    requestUserAnswer,
    clear: () => {
      userQuestionResponseCache.clear();
    },
  };
}
