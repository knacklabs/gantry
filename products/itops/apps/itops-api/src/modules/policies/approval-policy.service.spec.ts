import { ACCESS_REQUEST_ACTION, ACCESS_REQUEST_STATUS } from "@itops/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccessRequest } from "../approvals/approvals.repository.js";
import { ApprovalPolicyService, normalizeExternalUserId } from "./approval-policy.service.js";

describe("ApprovalPolicyService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows decisions when approval policy is disabled", () => {
    vi.stubEnv("ITOPS_DATABASE_URL", "postgresql://user:password@localhost:5432/itops");
    vi.stubEnv("ITOPS_APPROVAL_POLICY_ENABLED", "false");

    const service = new ApprovalPolicyService();

    expect(
      service.canDecideAccessRequest({
        accessRequest: makeAccessRequest(),
        approverExternalUserId: "slack:U999"
      })
    ).toEqual({
      allowed: true,
      reason: "approval policy disabled"
    });
  });

  it("allows an authorized approver", () => {
    vi.stubEnv("ITOPS_DATABASE_URL", "postgresql://user:password@localhost:5432/itops");
    vi.stubEnv("ITOPS_APPROVAL_POLICY_ENABLED", "true");
    vi.stubEnv("ITOPS_APPROVER_EXTERNAL_USER_IDS", "slack:U999");
    vi.stubEnv("ITOPS_ALLOW_SELF_APPROVAL", "false");

    const service = new ApprovalPolicyService();

    expect(
      service.canDecideAccessRequest({
        accessRequest: makeAccessRequest(),
        approverExternalUserId: "slack:U999"
      })
    ).toEqual({
      allowed: true,
      reason: "approver is authorized"
    });
  });

  it("allows any approver in the configured comma-separated allowlist", () => {
    vi.stubEnv("ITOPS_DATABASE_URL", "postgresql://user:password@localhost:5432/itops");
    vi.stubEnv("ITOPS_APPROVAL_POLICY_ENABLED", "true");
    vi.stubEnv("ITOPS_APPROVER_EXTERNAL_USER_IDS", "slack:U999,U888");
    vi.stubEnv("ITOPS_ALLOW_SELF_APPROVAL", "false");

    const service = new ApprovalPolicyService();

    expect(
      service.canDecideAccessRequest({
        accessRequest: makeAccessRequest(),
        approverExternalUserId: "slack:U999"
      })
    ).toEqual({
      allowed: true,
      reason: "approver is authorized"
    });

    expect(
      service.canDecideAccessRequest({
        accessRequest: makeAccessRequest(),
        approverExternalUserId: "slack:U888"
      })
    ).toEqual({
      allowed: true,
      reason: "approver is authorized"
    });

    expect(
      service.canDecideAccessRequest({
        accessRequest: makeAccessRequest(),
        approverExternalUserId: "slack:U777"
      })
    ).toEqual({
      allowed: false,
      reason: "approver is not authorized"
    });
  });

  it("denies an approver who is not in the allowlist", () => {
    vi.stubEnv("ITOPS_DATABASE_URL", "postgresql://user:password@localhost:5432/itops");
    vi.stubEnv("ITOPS_APPROVAL_POLICY_ENABLED", "true");
    vi.stubEnv("ITOPS_APPROVER_EXTERNAL_USER_IDS", "slack:U999");

    const service = new ApprovalPolicyService();

    expect(
      service.canDecideAccessRequest({
        accessRequest: makeAccessRequest(),
        approverExternalUserId: "slack:U777"
      })
    ).toEqual({
      allowed: false,
      reason: "approver is not authorized"
    });
  });

  it("denies self approval when self approval is disabled", () => {
    vi.stubEnv("ITOPS_DATABASE_URL", "postgresql://user:password@localhost:5432/itops");
    vi.stubEnv("ITOPS_APPROVAL_POLICY_ENABLED", "true");
    vi.stubEnv("ITOPS_APPROVER_EXTERNAL_USER_IDS", "slack:U123");
    vi.stubEnv("ITOPS_ALLOW_SELF_APPROVAL", "false");

    const service = new ApprovalPolicyService();

    expect(
      service.canDecideAccessRequest({
        accessRequest: makeAccessRequest(),
        approverExternalUserId: "slack:U123"
      })
    ).toEqual({
      allowed: false,
      reason: "self approval is not allowed"
    });
  });

  it("normalizes raw Slack user ids for comparison", () => {
    vi.stubEnv("ITOPS_DATABASE_URL", "postgresql://user:password@localhost:5432/itops");
    vi.stubEnv("ITOPS_APPROVAL_POLICY_ENABLED", "true");
    vi.stubEnv("ITOPS_APPROVER_EXTERNAL_USER_IDS", "U999");

    const service = new ApprovalPolicyService();

    expect(
      service.canDecideAccessRequest({
        accessRequest: makeAccessRequest(),
        approverExternalUserId: "slack:U999"
      }).allowed
    ).toBe(true);

    expect(normalizeExternalUserId(" U123 ")).toBe("slack:U123");
    expect(normalizeExternalUserId(" slack:U123 ")).toBe("slack:U123");
    expect(normalizeExternalUserId("gantry:user-1")).toBe("gantry:user-1");
  });

  it("allows diagnostics through Gantry when approval policy is disabled", () => {
    vi.stubEnv("ITOPS_DATABASE_URL", "postgresql://user:password@localhost:5432/itops");
    vi.stubEnv("ITOPS_APPROVAL_POLICY_ENABLED", "false");

    const service = new ApprovalPolicyService();

    expect(service.canAccessDiagnostics({ actorExternalUserId: "slack:U999" })).toEqual({
      allowed: true,
      reason: "approval policy disabled; trusting Gantry"
    });
  });

  it("allows diagnostics for configured approvers when approval policy is enabled", () => {
    vi.stubEnv("ITOPS_DATABASE_URL", "postgresql://user:password@localhost:5432/itops");
    vi.stubEnv("ITOPS_APPROVAL_POLICY_ENABLED", "true");
    vi.stubEnv("ITOPS_APPROVER_EXTERNAL_USER_IDS", "U999");

    const service = new ApprovalPolicyService();

    expect(service.canAccessDiagnostics({ actorExternalUserId: "slack:U999" })).toEqual({
      allowed: true,
      reason: "actor is authorized for diagnostics"
    });
  });

  it("denies diagnostics for unconfigured actors when approval policy is enabled", () => {
    vi.stubEnv("ITOPS_DATABASE_URL", "postgresql://user:password@localhost:5432/itops");
    vi.stubEnv("ITOPS_APPROVAL_POLICY_ENABLED", "true");
    vi.stubEnv("ITOPS_APPROVER_EXTERNAL_USER_IDS", "slack:U999");

    const service = new ApprovalPolicyService();

    expect(service.canAccessDiagnostics({ actorExternalUserId: "slack:U777" })).toEqual({
      allowed: false,
      reason: "actor is not authorized for diagnostics"
    });
  });
});

function makeAccessRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    id: "0a6f04d5-b890-42c7-99e8-e10be81b6ffe",
    employeeId: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
    systemId: "2fef76f2-507f-4c88-babe-07a089fdc003",
    resourceId: "f6ab56d2-2d62-470c-9ed9-5be602b77305",
    roleId: "09c06715-3b73-4fd4-9ab2-960a6a57f8ad",
    action: ACCESS_REQUEST_ACTION.grant,
    status: ACCESS_REQUEST_STATUS.waitingForApproval,
    reason: "Create company email during onboarding",
    requestedByExternalUserId: "slack:U123",
    requestedFrom: "api",
    sourceConversationId: null,
    sourceMessageId: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}
