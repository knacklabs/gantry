import { ACCESS_REQUEST_ACTION, ACCESS_REQUEST_STATUS, ACCESS_RESOURCE_KEY, auditEvents, ROLE_KEY, SYSTEM_KEY } from "@itops/db";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseProvider } from "../../database/database.provider.js";
import { ApprovalsRepository, buildAccessTaskIdempotencyKey, type AccessRequest } from "./approvals.repository.js";

describe("buildAccessTaskIdempotencyKey", () => {
  it("builds a stable access task idempotency key", () => {
    expect(
      buildAccessTaskIdempotencyKey({
        action: ACCESS_REQUEST_ACTION.grant,
        employeeId: "8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe",
        systemKey: SYSTEM_KEY.googleWorkspace,
        resourceKey: ACCESS_RESOURCE_KEY.companyEmail,
        roleKey: ROLE_KEY.user
      })
    ).toBe("grant:8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe:google_workspace:company_email:user");
  });
});

describe("ApprovalsRepository", () => {
  it("records approval policy denials without storing an approval row", async () => {
    const insertValues = vi.fn(async () => undefined);
    const databaseProvider = {
      db: {
        insert: vi.fn((table) => {
          expect(table).toBe(auditEvents);
          return {
            values: insertValues
          };
        })
      }
    };
    const repository = new ApprovalsRepository(databaseProvider as unknown as DatabaseProvider);
    const accessRequest = makeAccessRequest();

    await repository.recordApprovalDeniedByPolicy({
      accessRequest,
      approverExternalUserId: "slack:U777",
      reason: "approver is not authorized"
    });

    expect(insertValues).toHaveBeenCalledWith({
      actorExternalUserId: "slack:U777",
      eventType: "approval.denied_by_policy",
      entityType: "access_request",
      entityId: accessRequest.id,
      metadataJson: {
        reason: "approver is not authorized",
        requested_by_external_user_id: "slack:U123"
      }
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
