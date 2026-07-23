import { loadConfig, type AppConfig } from "@itops/config";
import { Injectable } from "@nestjs/common";

import type { AccessRequest } from "../approvals/approvals.repository.js";

export type ApprovalPolicyDecision = {
  allowed: boolean;
  reason: string;
};

@Injectable()
export class ApprovalPolicyService {
  private readonly approvalPolicy: AppConfig["approvalPolicy"];

  constructor() {
    this.approvalPolicy = loadConfig().approvalPolicy;
  }

  canDecideAccessRequest(input: {
    accessRequest: AccessRequest;
    approverExternalUserId: string;
  }): ApprovalPolicyDecision {
    return this.canApproveExternalActor({
      requesterExternalUserId: input.accessRequest.requestedByExternalUserId,
      approverExternalUserId: input.approverExternalUserId
    });
  }

  canApproveExternalActor(input: {
    requesterExternalUserId: string;
    approverExternalUserId: string;
  }): ApprovalPolicyDecision {
    if (!this.approvalPolicy.enabled) {
      return {
        allowed: true,
        reason: "approval policy disabled"
      };
    }

    const normalizedApproverExternalUserId = normalizeExternalUserId(input.approverExternalUserId);
    const normalizedApproverAllowlist = new Set(
      this.approvalPolicy.approverExternalUserIds.map((externalUserId) => normalizeExternalUserId(externalUserId))
    );

    if (!normalizedApproverAllowlist.has(normalizedApproverExternalUserId)) {
      return {
        allowed: false,
        reason: "approver is not authorized"
      };
    }

    if (!this.approvalPolicy.allowSelfApproval) {
      const normalizedRequesterExternalUserId = normalizeExternalUserId(input.requesterExternalUserId);

      if (normalizedRequesterExternalUserId === normalizedApproverExternalUserId) {
        return {
          allowed: false,
          reason: "self approval is not allowed"
        };
      }
    }

    return {
      allowed: true,
      reason: "approver is authorized"
    };
  }

  canAccessDiagnostics(input: { actorExternalUserId: string }): ApprovalPolicyDecision {
    if (!this.approvalPolicy.enabled) {
      return {
        allowed: true,
        reason: "approval policy disabled; trusting Gantry"
      };
    }

    if (this.approvalPolicy.approverExternalUserIds.length === 0) {
      return {
        allowed: false,
        reason: "diagnostics admin allowlist is not configured"
      };
    }

    const normalizedActorExternalUserId = normalizeExternalUserId(input.actorExternalUserId);
    const normalizedApproverAllowlist = new Set(
      this.approvalPolicy.approverExternalUserIds.map((externalUserId) => normalizeExternalUserId(externalUserId))
    );

    if (!normalizedApproverAllowlist.has(normalizedActorExternalUserId)) {
      return {
        allowed: false,
        reason: "actor is not authorized for diagnostics"
      };
    }

    return {
      allowed: true,
      reason: "actor is authorized for diagnostics"
    };
  }
}

export function normalizeExternalUserId(externalUserId: string): string {
  const trimmedExternalUserId = externalUserId.trim();

  if (trimmedExternalUserId.startsWith("slack:")) {
    return trimmedExternalUserId;
  }

  if (/^U[A-Z0-9]+$/u.test(trimmedExternalUserId)) {
    return `slack:${trimmedExternalUserId}`;
  }

  return trimmedExternalUserId;
}
