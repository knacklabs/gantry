import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { loadConfig, type AppConfig } from "@itops/config";

import { formatZodIssues } from "../../common/validation.js";
import {
  actorExternalUserIdSchema,
  taskStatusDiagnosticsQuerySchema
} from "./dto/diagnostics.dto.js";
import { DiagnosticsRepository, type DiagnosticsAccessTaskRow } from "./diagnostics.repository.js";
import { ApprovalPolicyService } from "../policies/approval-policy.service.js";

export type ConfigHealth = {
  GOOGLE_WORKSPACE_ENABLED: boolean;
  SLACK_CONNECTOR_ENABLED: boolean;
  EMAIL_ENABLED: boolean;
  APPROVAL_POLICY_ENABLED: boolean;
  sections: Array<{
    name: string;
    enabled: boolean;
    requiredConfig: Array<{
      key: string;
      status: "present" | "missing" | "not_required";
    }>;
  }>;
};

export type ConnectorHealth = {
  connectors: Array<{
    name: string;
    enabled: boolean;
    mode?: string;
    status: "ready" | "not_configured" | "disabled";
    missingConfig: string[];
  }>;
};

export type DiagnosticsTaskSummary = {
  accessTaskId: string;
  accessRequestId: string;
  status: string;
  operation: string;
  connector: string;
  attemptCount: number;
  employeeName: string;
  employeeWorkEmail: string | null;
  system: string;
  resource: string;
  role: string;
  errorSummary: string | null;
  connectorResultSummary: Record<string, unknown> | null;
  updatedAt: Date;
};

const SENSITIVE_KEY_PATTERN =
  /(token|password|private.?key|database.?url|db.?url|cookie|session|authorization|auth|secret|credential|localstorage|profile.?dir|profile.?path|browser.?profile)/iu;

const SECRET_VALUE_PATTERNS = [
  /xox[baprs]-[A-Za-z0-9-]+/gu,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /postgres(?:ql)?:\/\/\S+/giu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu
];

@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly diagnosticsRepository: DiagnosticsRepository,
    private readonly approvalPolicyService: ApprovalPolicyService
  ) {}

  async getConfigHealth(input: unknown): Promise<ConfigHealth> {
    this.assertAuthorized(input);
    const config = loadConfig();

    return {
      GOOGLE_WORKSPACE_ENABLED: config.googleWorkspace.enabled,
      SLACK_CONNECTOR_ENABLED: isSlackConnectorEnabled(config),
      EMAIL_ENABLED: isEmailEnabled(config),
      APPROVAL_POLICY_ENABLED: config.approvalPolicy.enabled,
      sections: [
        {
          name: "Google Workspace",
          enabled: config.googleWorkspace.enabled,
          requiredConfig: requiredConfigStatuses(config.googleWorkspace.enabled, [
            ["GOOGLE_WORKSPACE_DOMAIN", config.googleWorkspace.domain],
            ["GOOGLE_WORKSPACE_ADMIN_EMAIL", config.googleWorkspace.adminEmail],
            ["GOOGLE_WORKSPACE_CLIENT_EMAIL", config.googleWorkspace.clientEmail],
            ["GOOGLE_WORKSPACE_PRIVATE_KEY", config.googleWorkspace.privateKey]
          ])
        },
        {
          name: "Slack channel connector",
          enabled: config.slackChannelConnector.mode === "real",
          requiredConfig: requiredConfigStatuses(config.slackChannelConnector.mode === "real", [
            ["SLACK_BOT_TOKEN", config.slackChannelConnector.botToken]
          ])
        },
        {
          name: "Slack workspace invite",
          enabled: config.slackWorkspaceInvite.mode !== "manual",
          requiredConfig: slackWorkspaceRequiredConfigStatuses(config)
        },
        {
          name: "Email",
          enabled: isEmailEnabled(config),
          requiredConfig: requiredConfigStatuses(isEmailEnabled(config), [
            ["EMAIL_ITOPS_FROM", config.email.itopsFrom],
            ["GMAIL_CLIENT_EMAIL", config.email.gmailClientEmail],
            ["GMAIL_PRIVATE_KEY", config.email.gmailPrivateKey],
            ["GMAIL_IMPERSONATED_ITOPS_EMAIL", config.email.gmailImpersonatedItopsEmail]
          ])
        },
        {
          name: "Approval policy",
          enabled: config.approvalPolicy.enabled,
          requiredConfig: requiredConfigStatuses(config.approvalPolicy.enabled, [
            ["ITOPS_APPROVER_EXTERNAL_USER_IDS", config.approvalPolicy.approverExternalUserIds.length > 0 ? "present" : undefined]
          ])
        }
      ]
    };
  }

  async getConnectorHealth(input: unknown): Promise<ConnectorHealth> {
    this.assertAuthorized(input);
    const config = loadConfig();

    return {
      connectors: [
        connectorHealthItem({
          name: "Google Workspace",
          enabled: config.googleWorkspace.enabled,
          missingConfig: missingRequiredConfig(config.googleWorkspace.enabled, [
            ["GOOGLE_WORKSPACE_DOMAIN", config.googleWorkspace.domain],
            ["GOOGLE_WORKSPACE_ADMIN_EMAIL", config.googleWorkspace.adminEmail],
            ["GOOGLE_WORKSPACE_CLIENT_EMAIL", config.googleWorkspace.clientEmail],
            ["GOOGLE_WORKSPACE_PRIVATE_KEY", config.googleWorkspace.privateKey]
          ])
        }),
        connectorHealthItem({
          name: "Slack channel connector",
          enabled: config.slackChannelConnector.mode === "real",
          mode: config.slackChannelConnector.mode,
          missingConfig: missingRequiredConfig(config.slackChannelConnector.mode === "real", [
            ["SLACK_BOT_TOKEN", config.slackChannelConnector.botToken]
          ])
        }),
        connectorHealthItem({
          name: "Slack workspace invite",
          enabled: config.slackWorkspaceInvite.mode !== "manual",
          mode: config.slackWorkspaceInvite.mode,
          missingConfig: slackWorkspaceMissingConfig(config)
        }),
        connectorHealthItem({
          name: "Email",
          enabled: isEmailEnabled(config),
          missingConfig: missingRequiredConfig(isEmailEnabled(config), [
            ["EMAIL_ITOPS_FROM", config.email.itopsFrom],
            ["GMAIL_CLIENT_EMAIL", config.email.gmailClientEmail],
            ["GMAIL_PRIVATE_KEY", config.email.gmailPrivateKey],
            ["GMAIL_IMPERSONATED_ITOPS_EMAIL", config.email.gmailImpersonatedItopsEmail]
          ])
        }),
        connectorHealthItem({
          name: "Approval policy",
          enabled: config.approvalPolicy.enabled,
          missingConfig: missingRequiredConfig(config.approvalPolicy.enabled, [
            ["ITOPS_APPROVER_EXTERNAL_USER_IDS", config.approvalPolicy.approverExternalUserIds.length > 0 ? "present" : undefined]
          ])
        })
      ]
    };
  }

  async getRecentFailedAccessTasks(input: unknown): Promise<{ failedAccessTasks: DiagnosticsTaskSummary[] }> {
    this.assertAuthorized(input);
    const rows = await this.diagnosticsRepository.listRecentFailedAccessTasks();

    return {
      failedAccessTasks: rows.map(toTaskSummary)
    };
  }

  async getTaskStatusByEmployee(input: unknown): Promise<{ tasks: DiagnosticsTaskSummary[] }> {
    const parsed = taskStatusDiagnosticsQuerySchema.safeParse(input);

    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid diagnostics task-status query.",
        details: formatZodIssues(parsed.error.issues)
      });
    }

    this.assertAuthorized({ actorExternalUserId: parsed.data.actorExternalUserId });
    const rows = await this.diagnosticsRepository.listAccessTasksForEmployeeQuery(parsed.data.employeeQuery);

    return {
      tasks: rows.map(toTaskSummary)
    };
  }

  private assertAuthorized(input: unknown): void {
    const parsed = actorExternalUserIdSchema.safeParse(input);

    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid diagnostics auth query.",
        details: formatZodIssues(parsed.error.issues)
      });
    }

    const decision = this.approvalPolicyService.canAccessDiagnostics({
      actorExternalUserId: parsed.data.actorExternalUserId
    });

    if (!decision.allowed) {
      throw new ForbiddenException({
        statusCode: 403,
        error: "Forbidden",
        message: "Diagnostics are restricted to authorized IT Ops admins.",
        reason: decision.reason
      });
    }
  }
}

function toTaskSummary(row: DiagnosticsAccessTaskRow): DiagnosticsTaskSummary {
  return {
    accessTaskId: row.accessTaskId,
    accessRequestId: row.accessRequestId,
    status: row.status,
    operation: row.operation,
    connector: row.connector,
    attemptCount: row.attemptCount,
    employeeName: row.employeeName,
    employeeWorkEmail: row.employeeWorkEmail,
    system: row.system,
    resource: row.resource,
    role: row.role,
    errorSummary: sanitizeDiagnosticText(row.errorMessage),
    connectorResultSummary: sanitizeDiagnosticRecord(row.externalResultJson),
    updatedAt: row.updatedAt
  };
}

export function sanitizeDiagnosticText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  let sanitized = trimmed;

  for (const pattern of SECRET_VALUE_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }

  return sanitized.length > 500 ? `${sanitized.slice(0, 497)}...` : sanitized;
}

export function sanitizeDiagnosticRecord(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  const sanitized = sanitizeDiagnosticValue(value);

  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : null;
}

function sanitizeDiagnosticValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return "[redacted]";
  }

  if (typeof value === "string") {
    return sanitizeDiagnosticText(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeDiagnosticValue(entry));
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};

    for (const [entryKey, entryValue] of Object.entries(value)) {
      result[entryKey] = sanitizeDiagnosticValue(entryValue, entryKey);
    }

    return result;
  }

  return undefined;
}

function isSlackConnectorEnabled(config: AppConfig): boolean {
  return config.slackChannelConnector.mode === "real" || config.slackWorkspaceInvite.mode !== "manual";
}

function isEmailEnabled(config: AppConfig): boolean {
  return Boolean(
    config.email.itopsFrom ||
    config.email.gmailClientEmail ||
    config.email.gmailPrivateKey ||
    config.email.gmailImpersonatedItopsEmail
  );
}

function requiredConfigStatuses(
  enabled: boolean,
  entries: Array<[string, string | undefined]>
): ConfigHealth["sections"][number]["requiredConfig"] {
  return entries.map(([key, value]) => ({
    key,
    status: enabled ? (value ? "present" : "missing") : "not_required"
  }));
}

function missingRequiredConfig(enabled: boolean, entries: Array<[string, string | undefined]>): string[] {
  if (!enabled) {
    return [];
  }

  return entries.flatMap(([key, value]) => value ? [] : [key]);
}

function slackWorkspaceRequiredConfigStatuses(config: AppConfig): ConfigHealth["sections"][number]["requiredConfig"] {
  if (config.slackWorkspaceInvite.mode === "manual") {
    return requiredConfigStatuses(false, [
      ["SLACK_ADMIN_TOKEN", config.slackWorkspaceInvite.adminToken],
      ["SLACK_BROWSER_WORKSPACE_URL", config.slackWorkspaceInvite.browserWorkspaceUrl],
      ["SLACK_BROWSER_PROFILE_DIR", config.slackWorkspaceInvite.browserProfileDir],
      ["SLACK_BROWSER_LOGIN_EMAIL", config.slackWorkspaceInvite.browserLoginEmail],
      ["SLACK_BROWSER_LOGIN_PASSWORD", config.slackWorkspaceInvite.browserLoginPassword]
    ]);
  }

  if (config.slackWorkspaceInvite.mode === "automated") {
    return requiredConfigStatuses(true, [["SLACK_ADMIN_TOKEN", config.slackWorkspaceInvite.adminToken]]);
  }

  const statuses = requiredConfigStatuses(true, [
    ["SLACK_BROWSER_WORKSPACE_URL", config.slackWorkspaceInvite.browserWorkspaceUrl],
    ["SLACK_BROWSER_PROFILE_DIR", config.slackWorkspaceInvite.browserProfileDir]
  ]);

  if (config.slackWorkspaceInvite.browserLoginMode !== "google_sso") {
    return [
      ...statuses,
      { key: "SLACK_BROWSER_LOGIN_EMAIL", status: "not_required" },
      { key: "SLACK_BROWSER_LOGIN_PASSWORD", status: "not_required" }
    ];
  }

  return [
    ...statuses,
    ...requiredConfigStatuses(true, [
      ["SLACK_BROWSER_LOGIN_EMAIL", config.slackWorkspaceInvite.browserLoginEmail],
      ["SLACK_BROWSER_LOGIN_PASSWORD", config.slackWorkspaceInvite.browserLoginPassword]
    ])
  ];
}

function slackWorkspaceMissingConfig(config: AppConfig): string[] {
  if (config.slackWorkspaceInvite.mode === "manual") {
    return [];
  }

  if (config.slackWorkspaceInvite.mode === "automated") {
    return missingRequiredConfig(true, [["SLACK_ADMIN_TOKEN", config.slackWorkspaceInvite.adminToken]]);
  }

  const required: Array<[string, string | undefined]> = [
    ["SLACK_BROWSER_WORKSPACE_URL", config.slackWorkspaceInvite.browserWorkspaceUrl],
    ["SLACK_BROWSER_PROFILE_DIR", config.slackWorkspaceInvite.browserProfileDir]
  ];

  if (config.slackWorkspaceInvite.browserLoginMode === "google_sso") {
    required.push(
      ["SLACK_BROWSER_LOGIN_EMAIL", config.slackWorkspaceInvite.browserLoginEmail],
      ["SLACK_BROWSER_LOGIN_PASSWORD", config.slackWorkspaceInvite.browserLoginPassword]
    );
  }

  return missingRequiredConfig(true, required);
}

function connectorHealthItem(input: {
  name: string;
  enabled: boolean;
  mode?: string;
  missingConfig: string[];
}): ConnectorHealth["connectors"][number] {
  return {
    name: input.name,
    enabled: input.enabled,
    ...(input.mode ? { mode: input.mode } : {}),
    missingConfig: input.missingConfig,
    status: input.enabled ? (input.missingConfig.length > 0 ? "not_configured" : "ready") : "disabled"
  };
}
