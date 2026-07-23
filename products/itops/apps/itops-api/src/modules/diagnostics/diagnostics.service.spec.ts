import { ForbiddenException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiagnosticsService, sanitizeDiagnosticRecord, sanitizeDiagnosticText } from "./diagnostics.service.js";
import type { DiagnosticsRepository } from "./diagnostics.repository.js";
import type { ApprovalPolicyService } from "../policies/approval-policy.service.js";

type DiagnosticsRepositoryMock = {
  listRecentFailedAccessTasks: ReturnType<typeof vi.fn>;
  listAccessTasksForEmployeeQuery: ReturnType<typeof vi.fn>;
};

type ApprovalPolicyServiceMock = {
  canAccessDiagnostics: ReturnType<typeof vi.fn>;
};

describe("DiagnosticsService", () => {
  let repository: DiagnosticsRepositoryMock;
  let approvalPolicyService: ApprovalPolicyServiceMock;
  let service: DiagnosticsService;

  beforeEach(() => {
    vi.stubEnv("ITOPS_DATABASE_URL", "postgresql://user:password@localhost:5432/itops");
    vi.stubEnv("ITOPS_APPROVER_EXTERNAL_USER_IDS", "slack:U_ADMIN");
    vi.stubEnv("GOOGLE_WORKSPACE_ENABLED", "true");
    vi.stubEnv("GOOGLE_WORKSPACE_DOMAIN", "caw.tech");
    vi.stubEnv("GOOGLE_WORKSPACE_ADMIN_EMAIL", "admin@caw.tech");
    vi.stubEnv("GOOGLE_WORKSPACE_CLIENT_EMAIL", "service-account@project.iam.gserviceaccount.com");
    vi.stubEnv("GOOGLE_WORKSPACE_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----");
    vi.stubEnv("SLACK_CHANNEL_CONNECTOR_MODE", "real");
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-secret-token");

    repository = {
      listRecentFailedAccessTasks: vi.fn(),
      listAccessTasksForEmployeeQuery: vi.fn()
    };
    approvalPolicyService = {
      canAccessDiagnostics: vi.fn(() => ({ allowed: true, reason: "actor is authorized for diagnostics" }))
    };
    service = new DiagnosticsService(
      repository as unknown as DiagnosticsRepository,
      approvalPolicyService as unknown as ApprovalPolicyService
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns redacted config health without secret values", async () => {
    const result = await service.getConfigHealth({ actorExternalUserId: "slack:U_ADMIN" });
    const serialized = JSON.stringify(result);

    expect(result.GOOGLE_WORKSPACE_ENABLED).toBe(true);
    expect(result.SLACK_CONNECTOR_ENABLED).toBe(true);
    expect(serialized).toContain("GOOGLE_WORKSPACE_PRIVATE_KEY");
    expect(serialized).toContain("SLACK_BOT_TOKEN");
    expect(serialized).not.toContain("xoxb-secret-token");
    expect(serialized).not.toContain("-----BEGIN PRIVATE KEY-----");
    expect(serialized).not.toContain("postgresql://user:password");
  });

  it("denies diagnostics to unauthorized actors", async () => {
    approvalPolicyService.canAccessDiagnostics.mockReturnValue({
      allowed: false,
      reason: "actor is not authorized for diagnostics"
    });

    await expect(service.getConnectorHealth({ actorExternalUserId: "slack:U_OTHER" })).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it("returns failed task summaries with sanitized errors and connector results", async () => {
    repository.listRecentFailedAccessTasks.mockResolvedValue([
      {
        accessTaskId: "e149bb10-5628-45e7-b59c-07199a76b10a",
        accessRequestId: "0ab14c88-6f22-484b-ad51-65d89d6adbbf",
        status: "failed",
        operation: "grant",
        connector: "slack",
        attemptCount: 1,
        errorMessage: "Slack call failed with Bearer xoxb-secret-token and postgres://user:pass@db/itops",
        externalResultJson: {
          provider: "slack",
          token: "xoxb-secret-token",
          nested: {
            authorization: "Bearer xoxb-secret-token"
          }
        },
        updatedAt: new Date("2026-06-25T00:00:00.000Z"),
        employeeName: "Akhay Khan",
        employeeWorkEmail: "akhay.khan@caw.tech",
        system: "Slack",
        resource: "Workspace Membership",
        role: "Member"
      }
    ]);

    const result = await service.getRecentFailedAccessTasks({ actorExternalUserId: "slack:U_ADMIN" });
    const serialized = JSON.stringify(result);

    expect(result.failedAccessTasks[0]?.errorSummary).toContain("[redacted]");
    expect(serialized).not.toContain("xoxb-secret-token");
    expect(serialized).not.toContain("postgres://user:pass");
    expect(serialized).not.toContain("Bearer xoxb");
  });
});

describe("diagnostics sanitizers", () => {
  it("redacts common secret values from strings", () => {
    expect(sanitizeDiagnosticText("token xoxb-secret-token and postgresql://user:pass@host/db")).toBe(
      "token [redacted] and [redacted]"
    );
  });

  it("redacts sensitive keys in objects", () => {
    expect(sanitizeDiagnosticRecord({
      provider: "slack",
      password: "secret",
      nested: {
        cookie: "session-cookie"
      }
    })).toEqual({
      provider: "slack",
      password: "[redacted]",
      nested: {
        cookie: "[redacted]"
      }
    });
  });
});
