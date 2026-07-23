import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { AuditService } from './itops-audit.js';
import { ItOpsClient } from './itops-client.js';
import type {
  AutoProcessOffboardingResult,
  OnboardingIntake,
  ResolveEmployeeResult,
} from './itops-types.js';

type ToolResult = {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  structuredContent?: {
    result: unknown;
  };
  isError?: true;
};

type AuditIds = {
  employeeId?: string;
  emailMessageId?: string;
  accessRequestId?: string;
  accessTaskId?: string;
  onboardingIntakeId?: string;
  offboardingIntakeId?: string;
};

type OffboardingSlackInput = {
  workspaceId?: string | null;
  channelId?: string | null;
  messageTs?: string | null;
  threadTs?: string | null;
  senderSlackUserId?: string | null;
  senderExternalUserId?: string | null;
  rawText: string;
};

type ParsedOffboardingAlert = {
  detectedType: 'offboarding_alert' | 'unknown';
  fields: {
    name: string | null;
    workEmail: string | null;
    lastWorkingDay: string | null;
  };
  missingFields: string[];
  parseErrors: string[];
};

type OffboardingAlertProcessorClient = Pick<
  ItOpsClient,
  'resolveEmployee' | 'autoProcessOffboarding'
>;
type OnboardingStatusLookupInput = {
  onboardingIntakeId?: string;
  employeeId?: string;
  query?: string;
  name?: string;
  workEmail?: string;
  personalEmail?: string;
  designation?: string;
  doj?: string;
};

type OffboardingAlertProcessResult =
  | {
      kind: 'offboarding_alert_validation_error';
      parsed: ParsedOffboardingAlert;
    }
  | {
      kind: 'offboarding_alert_resolution_error';
      parsed: ParsedOffboardingAlert;
      resolution: ResolveEmployeeResult;
    }
  | {
      kind: 'offboarding_alert_name_mismatch';
      parsed: ParsedOffboardingAlert;
      resolution: ResolveEmployeeResult;
    }
  | {
      kind: 'offboarding_alert_processed';
      parsed: ParsedOffboardingAlert;
      resolution: ResolveEmployeeResult;
      result: AutoProcessOffboardingResult;
    };

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const UNKNOWN_GANTRY_ACTOR_ID = 'gantry:unknown-actor';
const UNKNOWN_GANTRY_APPROVER_ID = 'gantry:unknown-approver';
const UNKNOWN_GANTRY_REQUESTER_ID = 'gantry:unknown-requester';

export class ItOpsToolRegistry {
  constructor(
    private readonly itopsClient: ItOpsClient,
    private readonly auditService: AuditService,
  ) {}

  registerTools(server: McpServer): void {
    server.registerTool(
      'itops_list_employees',
      {
        title: 'List Employees',
        description:
          'List current/open IT Ops employee records by default with pagination. Use status=offboarded only when the user explicitly asks for former/offboarded employees. Use itops_search_employees when the user provides a name or email query. For pending onboarding, onboarding work queue, or context-loss recovery questions, use itops_list_onboarding_work_queue instead.',
        inputSchema: {
          includeOpenOnboardingIntakes: z.boolean().optional(),
          page: z.number().int().min(1).max(10000).optional(),
          pageSize: z.number().int().min(1).max(50).optional(),
          status: z
            .enum([
              'open',
              'active',
              'preboarding',
              'offboarding',
              'offboarded',
              'all',
            ])
            .optional(),
        },
      },
      async ({ includeOpenOnboardingIntakes, page, pageSize, status }) =>
        this.runTool(
          'itops_list_employees',
          {},
          async () => {
            const employeePage = {
              ...(await this.itopsClient.listEmployees({
                page,
                pageSize,
                status,
              })),
              status: status ?? 'open',
            };

            if (!includeOpenOnboardingIntakes) {
              return employeePage;
            }

            const openOnboardingIntakes =
              await this.itopsClient.listOnboardingIntakes({
                status: 'open',
                limit: 50,
              });

            return {
              ...employeePage,
              openOnboardingIntakes: openOnboardingIntakes.onboardingIntakes,
              openOnboardingCount: openOnboardingIntakes.count,
            };
          },
          undefined,
          includeOpenOnboardingIntakes
            ? buildListEmployeesWithOnboardingIntakesResponse
            : buildListEmployeesResponse,
        ),
    );

    server.registerTool(
      'itops_search_employees',
      {
        title: 'Search Employees',
        description:
          'Search IT Ops employee records by name or email before creating a new employee. Do not use for onboarding status questions; use itops_get_onboarding_status_by_employee.',
        inputSchema: {
          query: z.string().trim().min(1).max(200),
        },
      },
      async ({ query }) =>
        this.runTool('itops_search_employees', {}, () =>
          this.itopsClient.searchEmployees({ query }),
        ),
    );

    server.registerTool(
      'itops_resolve_employee',
      {
        title: 'Resolve Employee',
        description:
          'Resolve a user-provided name or company email into a safe employee identity before non-onboarding employee-specific reads, access changes, company-email requests, or offboarding. Do not use for simple onboarding status questions; use itops_get_onboarding_status_by_employee.',
        inputSchema: {
          query: z.string().trim().min(1).max(200),
          purpose: z.enum(['read', 'mutate', 'offboarding']).optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_resolve_employee',
          {},
          () => this.itopsClient.resolveEmployee(input),
          (result) => ({
            employeeId: getNestedStringProperty(
              result,
              'employee',
              'employeeId',
            ),
          }),
          buildResolveEmployeeResponse,
        ),
    );

    server.registerTool(
      'itops_create_employee',
      {
        title: 'Create Employee',
        description: 'Create a validated employee record in the IT Ops API.',
        inputSchema: {
          fullName: z.string().trim().min(1).max(255),
          personalEmail: z.string().trim().email().optional(),
          workEmail: z.string().trim().email().nullable().optional(),
          employmentType: z.enum(['fte', 'contractor']),
          designation: z.string().trim().min(1).max(180),
          department: z.string().trim().max(120).optional(),
          startDate: z.string().regex(datePattern).optional(),
          createdByExternalUserId: z.string().trim().min(1).optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_create_employee',
          {},
          () => this.itopsClient.createEmployee(input),
          (result) => ({
            employeeId: getStringProperty(result, 'id'),
          }),
        ),
    );

    server.registerTool(
      'itops_get_employee',
      {
        title: 'Get Employee',
        description: 'Get one IT Ops employee record by id.',
        inputSchema: {
          employeeId: z.string().uuid(),
        },
      },
      async ({ employeeId }) =>
        this.runTool('itops_get_employee', { employeeId }, () =>
          this.itopsClient.getEmployee({ employeeId }),
        ),
    );

    server.registerTool(
      'itops_request_google_workspace_email',
      {
        title: 'Request Google Workspace Email',
        description:
          'Create a narrow Google Workspace company email grant request. The bridge does not accept system, resource, role, or action overrides.',
        inputSchema: {
          employeeId: z.string().uuid(),
          reason: z.string().trim().min(1).max(1000),
          requestedByExternalUserId: z.string().trim().min(1).optional(),
          requestedFrom: z.string().trim().min(1).optional(),
        },
      },
      async ({ employeeId, reason, requestedByExternalUserId }) =>
        this.runTool(
          'itops_request_google_workspace_email',
          { employeeId },
          () =>
            this.itopsClient.requestGoogleWorkspaceEmail({
              employeeId,
              reason,
              requestedByExternalUserId: withFallbackExternalUserId(
                requestedByExternalUserId,
                UNKNOWN_GANTRY_REQUESTER_ID,
              ),
            }),
          (result) => ({
            accessRequestId: getStringProperty(result, 'id'),
          }),
        ),
    );

    server.registerTool(
      'itops_create_access_request',
      {
        title: 'Create Access Request',
        description:
          'Create a generic access grant or revoke request. This only creates a waiting-for-approval request; it does not approve, execute tasks, or call connectors. Google Workspace company_email revoke is blocked by the backend and must use offboarding.',
        inputSchema: {
          employeeId: z.string().uuid(),
          systemKey: z.string().trim().min(1),
          resourceKey: z.string().trim().min(1),
          roleKey: z.string().trim().min(1),
          action: z.enum(['grant', 'revoke']),
          reason: z.string().trim().min(1).max(1000).nullable().optional(),
          requestedByExternalUserId: z.string().trim().min(1).optional(),
          requestedFrom: z.string().trim().min(1).nullable().optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_create_access_request',
          { employeeId: input.employeeId },
          async () => ({
            ...(await this.itopsClient.createAccessRequest({
              ...input,
              requestedByExternalUserId: withFallbackExternalUserId(
                input.requestedByExternalUserId,
                UNKNOWN_GANTRY_REQUESTER_ID,
              ),
            })),
            systemKey: input.systemKey,
            resourceKey: input.resourceKey,
            roleKey: input.roleKey,
          }),
          (result) => ({
            accessRequestId: getStringProperty(result, 'id'),
            employeeId: getStringProperty(result, 'employeeId'),
          }),
          buildCreateAccessRequestResponse,
        ),
    );

    server.registerTool(
      'itops_decide_access_request',
      {
        title: 'Decide Access Request',
        description:
          'Record a business approval decision for an access request. This is for controlled testing and later approval wiring.',
        inputSchema: {
          accessRequestId: z.string().uuid(),
          decision: z.enum(['approved', 'rejected']),
          approverExternalUserId: z.string().trim().min(1).optional(),
          comment: z.string().trim().min(1).nullable().optional(),
          source: z.string().trim().min(1).optional(),
          gantryConversationId: z.string().trim().min(1).nullable().optional(),
          gantryRuntimeEventId: z.string().trim().min(1).nullable().optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_decide_access_request',
          { accessRequestId: input.accessRequestId },
          () =>
            this.itopsClient.decideAccessRequest({
              ...input,
              approverExternalUserId: withFallbackExternalUserId(
                input.approverExternalUserId,
                UNKNOWN_GANTRY_APPROVER_ID,
              ),
            }),
          (result) => ({
            accessRequestId: getNestedStringProperty(
              result,
              'accessRequest',
              'id',
            ),
          }),
        ),
    );

    server.registerTool(
      'itops_list_access_request_tasks',
      {
        title: 'List Access Request Tasks',
        description: 'List backend access tasks created for an access request.',
        inputSchema: {
          accessRequestId: z.string().uuid(),
        },
      },
      async ({ accessRequestId }) =>
        this.runTool(
          'itops_list_access_request_tasks',
          { accessRequestId },
          () => this.itopsClient.listAccessRequestTasks({ accessRequestId }),
        ),
    );

    server.registerTool(
      'itops_execute_access_task',
      {
        title: 'Execute Access Task',
        description:
          'Execute an existing backend access task. The backend may provision real access if its connector is enabled.',
        inputSchema: {
          accessTaskId: z.string().uuid(),
        },
      },
      async ({ accessTaskId }) =>
        this.runTool(
          'itops_execute_access_task',
          { accessTaskId },
          () => this.itopsClient.executeAccessTask({ accessTaskId }),
          (result) => ({
            accessTaskId: getNestedStringProperty(result, 'task', 'id'),
          }),
        ),
    );

    server.registerTool(
      'itops_get_employee_access',
      {
        title: 'Get Employee Access',
        description:
          'Get active/current access grants for one employee only when the user asks what access the employee has. This is not an onboarding status tool; for status of a new joiner or onboarding employee use itops_get_onboarding_status_by_employee.',
        inputSchema: {
          employeeId: z.string().uuid(),
        },
      },
      async ({ employeeId }) =>
        this.runTool('itops_get_employee_access', { employeeId }, () =>
          this.itopsClient.getEmployeeAccess({ employeeId }),
        ),
    );

    server.registerTool(
      'itops_search_access_grants',
      {
        title: 'Search Access Grants',
        description:
          'Read-only search over current and historical access grants. Use this for revoked access, inactive Slack access, or access history. For current access only, prefer itops_get_employee_access.',
        inputSchema: {
          employeeQuery: z.string().trim().min(1).max(200).optional(),
          systemKey: z.string().trim().min(1).max(120).optional(),
          resourceKey: z.string().trim().min(1).max(160).optional(),
          status: z
            .enum([
              'pending',
              'active',
              'revocation_pending',
              'revoked',
              'failed',
              'unknown',
            ])
            .optional(),
          mode: z.enum(['active', 'inactive', 'history']).optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_search_access_grants',
          {},
          () => this.itopsClient.searchAccessGrants(input),
          undefined,
          (result) => buildSearchAccessGrantsResponse(result, input),
        ),
    );

    server.registerTool(
      'itops_get_access_detail_report',
      {
        title: 'Get Access Detail Report',
        description:
          'Read-only sanitized admin detail report for explicit audit/history/detail requests. Use only when the user asks for offboarding audit, access history detail, revoke task status, or access request status. Do not use for simple onboarding status questions.',
        inputSchema: {
          employeeQuery: z.string().trim().min(1).max(200),
          reportType: z.enum([
            'offboarding_audit',
            'access_history',
            'revoke_task_status',
            'access_request_status',
          ]),
        },
      },
      async (input) =>
        this.runTool(
          'itops_get_access_detail_report',
          {},
          () => this.itopsClient.getAccessDetailReport(input),
          undefined,
          buildAccessDetailReportResponse,
        ),
    );

    server.registerTool(
      'itops_get_config_health',
      {
        title: 'Get Config Health',
        description:
          'Admin-only read-only diagnostics. Returns redacted config health with present/missing/not-required flags only. Never returns env values, DB URLs, tokens, private keys, cookies, passwords, browser profile paths, or raw connector payloads.',
        inputSchema: {
          actorExternalUserId: z.string().trim().min(1).optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_get_config_health',
          {},
          () =>
            this.itopsClient.getConfigHealth({
              actorExternalUserId: withFallbackExternalUserId(
                input.actorExternalUserId,
                UNKNOWN_GANTRY_ACTOR_ID,
              ),
            }),
          undefined,
          buildConfigHealthResponse,
        ),
    );

    server.registerTool(
      'itops_get_connector_health',
      {
        title: 'Get Connector Health',
        description:
          'Admin-only read-only diagnostics. Returns safe connector readiness and missing config names only. Never returns tokens, secret values, DB URLs, browser profile paths, or raw connector auth data.',
        inputSchema: {
          actorExternalUserId: z.string().trim().min(1).optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_get_connector_health',
          {},
          () =>
            this.itopsClient.getConnectorHealth({
              actorExternalUserId: withFallbackExternalUserId(
                input.actorExternalUserId,
                UNKNOWN_GANTRY_ACTOR_ID,
              ),
            }),
          undefined,
          buildConnectorHealthResponse,
        ),
    );

    server.registerTool(
      'itops_get_recent_failed_access_tasks',
      {
        title: 'Get Recent Failed Access Tasks',
        description:
          'Admin-only read-only diagnostics. Returns recent failed access task summaries with sanitized error text and no raw connector payloads or secrets.',
        inputSchema: {
          actorExternalUserId: z.string().trim().min(1).optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_get_recent_failed_access_tasks',
          {},
          () =>
            this.itopsClient.getRecentFailedAccessTasks({
              actorExternalUserId: withFallbackExternalUserId(
                input.actorExternalUserId,
                UNKNOWN_GANTRY_ACTOR_ID,
              ),
            }),
          undefined,
          buildRecentFailedAccessTasksResponse,
        ),
    );

    server.registerTool(
      'itops_get_task_status_by_employee',
      {
        title: 'Get Task Status By Employee',
        description:
          'Admin-only read-only diagnostics. Returns sanitized access task status for an employee name or work email. Use for explicit task debugging requests.',
        inputSchema: {
          actorExternalUserId: z.string().trim().min(1).optional(),
          employeeQuery: z.string().trim().min(1).max(200),
        },
      },
      async (input) =>
        this.runTool(
          'itops_get_task_status_by_employee',
          {},
          () =>
            this.itopsClient.getTaskStatusByEmployee({
              ...input,
              actorExternalUserId: withFallbackExternalUserId(
                input.actorExternalUserId,
                UNKNOWN_GANTRY_ACTOR_ID,
              ),
            }),
          undefined,
          buildTaskStatusDiagnosticsResponse,
        ),
    );

    server.registerTool(
      'itops_list_employee_emails',
      {
        title: 'List Employee Emails',
        description:
          'List safe email delivery status records for one employee. This is read-only and never returns temporary passwords, rendered email bodies, Gmail private keys, tokens, cookies, or raw provider responses.',
        inputSchema: {
          employeeId: z.string().uuid(),
        },
      },
      async ({ employeeId }) =>
        this.runTool('itops_list_employee_emails', { employeeId }, () =>
          this.itopsClient.listEmployeeEmails({ employeeId }),
        ),
    );

    server.registerTool(
      'itops_get_email_message',
      {
        title: 'Get Email Message',
        description:
          'Get one safe email delivery status record by id. This is read-only and never returns temporary passwords, rendered email bodies, Gmail private keys, tokens, cookies, or raw provider responses.',
        inputSchema: {
          emailMessageId: z.string().uuid(),
        },
      },
      async ({ emailMessageId }) =>
        this.runTool('itops_get_email_message', { emailMessageId }, () =>
          this.itopsClient.getEmailMessage({ emailMessageId }),
        ),
    );

    server.registerTool(
      'itops_create_onboarding_intake_from_slack_message',
      {
        title: 'Create Onboarding Intake From Slack Message',
        description:
          'Manual/recovery path only. For any live Slack message containing New Joiner Alert, do not use this tool; use itops_auto_process_onboarding_from_slack_message. If this tool receives a New Joiner Alert without manualRecovery=true, the bridge will auto-process it through the lifecycle path.',
        inputSchema: {
          workspaceId: z.string().trim().min(1).max(100).nullable().optional(),
          channelId: z.string().trim().min(1).max(100).nullable().optional(),
          messageTs: z.string().trim().min(1).max(100).nullable().optional(),
          threadTs: z.string().trim().min(1).max(100).nullable().optional(),
          senderSlackUserId: z
            .string()
            .trim()
            .min(1)
            .max(120)
            .nullable()
            .optional(),
          senderExternalUserId: z
            .string()
            .trim()
            .min(1)
            .max(150)
            .nullable()
            .optional(),
          manualRecovery: z.boolean().optional(),
          rawText: z.string().refine((value) => value.trim().length > 0, {
            message: 'rawText is required.',
          }),
        },
      },
      async (input) => {
        const normalizedInput = normalizeOnboardingSlackInput(input);

        if (shouldAutoProcessOnboardingSlackMessage(input)) {
          return this.runTool(
            'itops_auto_process_onboarding_from_slack_message',
            {},
            () =>
              this.itopsClient.autoProcessOnboardingFromSlackMessage(
                normalizedInput,
              ),
            (result) => ({
              employeeId: getNestedStringProperty(
                getRecordProperty(result, 'setup'),
                'employee',
                'id',
              ),
              onboardingIntakeId: getNestedStringProperty(
                result,
                'onboardingIntake',
                'id',
              ),
            }),
            buildAutoProcessOnboardingResponse,
          );
        }

        return this.runTool(
          'itops_create_onboarding_intake_from_slack_message',
          {},
          () =>
            this.itopsClient.createOnboardingIntakeFromSlackMessage(
              normalizedInput,
            ),
          (result) => ({
            onboardingIntakeId: getNestedStringProperty(
              result,
              'onboardingIntake',
              'id',
            ),
          }),
          buildCreateOnboardingIntakeResponse,
        );
      },
    );

    server.registerTool(
      'itops_auto_process_onboarding_from_slack_message',
      {
        title: 'Auto Process Onboarding From Slack Message',
        description:
          'Required lifecycle channel path for a Slack New Joiner Alert. Call this tool first with rawText set to the full Slack message text. Creates or reuses the intake, records the initial Slack message as lifecycle authority, creates approved onboarding setup work, executes available critical setup tasks, and finalizes onboarding when backend state allows. Validation failures are returned without provisioning.',
        inputSchema: {
          workspaceId: z.string().trim().min(1).max(100).nullable().optional(),
          channelId: z.string().trim().min(1).max(100).nullable().optional(),
          messageTs: z.string().trim().min(1).max(100).nullable().optional(),
          threadTs: z.string().trim().min(1).max(100).nullable().optional(),
          senderSlackUserId: z
            .string()
            .trim()
            .min(1)
            .max(120)
            .nullable()
            .optional(),
          senderExternalUserId: z
            .string()
            .trim()
            .min(1)
            .max(150)
            .nullable()
            .optional(),
          rawText: z.string().refine((value) => value.trim().length > 0, {
            message: 'rawText is required.',
          }),
        },
      },
      async (input) =>
        this.runTool(
          'itops_auto_process_onboarding_from_slack_message',
          {},
          () =>
            this.itopsClient.autoProcessOnboardingFromSlackMessage(
              normalizeOnboardingSlackInput(input),
            ),
          (result) => ({
            employeeId: getNestedStringProperty(
              getRecordProperty(result, 'setup'),
              'employee',
              'id',
            ),
            onboardingIntakeId: getNestedStringProperty(
              result,
              'onboardingIntake',
              'id',
            ),
          }),
          buildAutoProcessOnboardingResponse,
        ),
    );

    server.registerTool(
      'itops_decide_onboarding_intake',
      {
        title: 'Decide Onboarding Intake',
        description:
          'Approve or reject a validated onboarding intake. Prefer onboardingIntakeId when already available from a tool result. If it is not available, provide name plus designation, doj, or personalEmail and the bridge will resolve the exact open intake internally. Never ask the Slack user for backend ids. Approval creates the preboarding employee, approves the standard Google Workspace company email and Slack workspace membership access requests as part of onboarding, and creates access tasks. It does not execute tasks, provision Google, or call Slack Admin.',
        inputSchema: {
          onboardingIntakeId: z.string().uuid().optional(),
          name: z.string().trim().min(1).max(200).optional(),
          designation: z.string().trim().min(1).max(200).optional(),
          doj: z.string().regex(datePattern).optional(),
          personalEmail: z.string().email().optional(),
          decision: z.enum(['approved', 'rejected']),
          approverExternalUserId: z.string().trim().min(1).optional(),
          comment: z.string().trim().min(1).nullable().optional(),
          source: z.string().trim().min(1).optional(),
          gantryConversationId: z.string().trim().min(1).nullable().optional(),
          gantryRuntimeEventId: z.string().trim().min(1).nullable().optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_decide_onboarding_intake',
          { onboardingIntakeId: input.onboardingIntakeId },
          async () => {
            const onboardingIntakeId =
              input.onboardingIntakeId ??
              (await this.resolveOpenOnboardingIntakeByNaturalFields(input)).id;

            return this.itopsClient.decideOnboardingIntake({
              ...input,
              onboardingIntakeId,
              approverExternalUserId: withFallbackExternalUserId(
                input.approverExternalUserId,
                UNKNOWN_GANTRY_APPROVER_ID,
              ),
            });
          },
          (result) => ({
            employeeId: getNestedStringProperty(result, 'employee', 'id'),
            onboardingIntakeId: getNestedStringProperty(
              result,
              'onboardingIntake',
              'id',
            ),
            accessRequestId: getNestedStringProperty(
              result,
              'googleWorkspaceAccessRequest',
              'id',
            ),
            accessTaskId: getNestedStringProperty(result, 'accessTask', 'id'),
            slackAccessRequestId: getFirstNestedArrayStringProperty(
              result,
              'slackChannelAccessRequests',
              'id',
            ),
            slackAccessTaskId: getFirstNestedArrayStringProperty(
              result,
              'slackChannelAccessTasks',
              'id',
            ),
          }),
          buildDecideOnboardingIntakeResponse,
        ),
    );

    server.registerTool(
      'itops_get_onboarding_intake',
      {
        title: 'Get Onboarding Intake',
        description:
          'Get one onboarding intake by onboardingIntakeId, or resolve one open onboarding intake by natural fields such as name plus designation, doj, or personalEmail. Use this for read-only disambiguation before approval. Never ask Slack users for backend ids.',
        inputSchema: {
          onboardingIntakeId: z.string().uuid().optional(),
          name: z.string().trim().min(1).max(200).optional(),
          designation: z.string().trim().min(1).max(200).optional(),
          doj: z.string().regex(datePattern).optional(),
          personalEmail: z.string().email().optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_get_onboarding_intake',
          { onboardingIntakeId: input.onboardingIntakeId },
          async () => {
            if (input.onboardingIntakeId) {
              const status = await this.itopsClient.getOnboardingStatus({
                onboardingIntakeId: input.onboardingIntakeId,
              });

              return { onboardingIntake: status.onboardingIntake };
            }

            return {
              onboardingIntake:
                await this.resolveOpenOnboardingIntakeByNaturalFields(input),
            };
          },
          (result) => ({
            onboardingIntakeId: getNestedStringProperty(
              result,
              'onboardingIntake',
              'id',
            ),
          }),
          buildGetOnboardingIntakeResponse,
        ),
    );

    server.registerTool(
      'itops_get_onboarding_status',
      {
        title: 'Get Onboarding Status',
        description:
          'Get onboarding setup progress by onboardingIntakeId or natural employee fields. Use this for simple onboarding status questions. This is read-only.',
        inputSchema: {
          onboardingIntakeId: z.string().uuid().optional(),
          employeeId: z.string().uuid().optional(),
          query: z.string().trim().min(1).max(255).optional(),
          name: z.string().trim().min(1).max(255).optional(),
          workEmail: z.string().email().optional(),
          personalEmail: z.string().email().optional(),
          designation: z.string().trim().min(1).max(180).optional(),
          doj: z.string().regex(datePattern).optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_get_onboarding_status',
          {
            onboardingIntakeId: input.onboardingIntakeId,
            employeeId: input.employeeId,
          },
          async () => {
            const onboardingIntakeId =
              input.onboardingIntakeId ??
              (await this.resolveOnboardingIntakeForStatus(input)).id;

            return this.itopsClient.getOnboardingStatus({ onboardingIntakeId });
          },
          undefined,
          buildOnboardingStatusResponse,
        ),
    );

    server.registerTool(
      'itops_get_onboarding_status_by_employee',
      {
        title: 'Get Onboarding Status By Employee',
        description:
          "Best tool for simple Slack questions like 'status of <name>' or 'what is the status of <name>' when the person may be an onboarding/new joiner. Resolves by natural employee or intake fields and returns a compact onboarding-only status. Do not combine with employee access, offboarding, audit, or detail report tools unless the user explicitly asks for those details.",
        inputSchema: {
          query: z.string().trim().min(1).max(255),
          workEmail: z.string().email().optional(),
          name: z.string().trim().min(1).max(255).optional(),
          personalEmail: z.string().email().optional(),
          designation: z.string().trim().min(1).max(180).optional(),
          doj: z.string().regex(datePattern).optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_get_onboarding_status_by_employee',
          {},
          async () => {
            const onboardingIntakeId = (
              await this.resolveOnboardingIntakeForStatus(input)
            ).id;

            return this.itopsClient.getOnboardingStatus({ onboardingIntakeId });
          },
          undefined,
          buildOnboardingStatusResponse,
        ),
    );

    server.registerTool(
      'itops_list_pending_onboarding_setups',
      {
        title: 'List Pending Onboarding Setups',
        description:
          'Read-only recovery tool for lost onboarding context. Lists approved/open onboarding setups where critical Google Workspace or Slack workspace membership setup is incomplete. Use before asking which employee when the user asks to continue onboarding setup without naming an employee.',
        inputSchema: {
          limit: z.number().int().min(1).max(50).optional(),
        },
      },
      async ({ limit }) =>
        this.runTool(
          'itops_list_pending_onboarding_setups',
          {},
          () => this.itopsClient.listPendingOnboardingSetups({ limit }),
          undefined,
          buildListPendingOnboardingSetupsResponse,
        ),
    );

    server.registerTool(
      'itops_list_onboarding_work_queue',
      {
        title: 'List Onboarding Work Queue',
        description:
          'Read-only onboarding recovery queue. Lists onboarding work that needs attention: validation errors, waiting approval, pending setup, setup complete but not finalized, and blocked items. Use for queue/list questions only, such as pending onboardings. Do not use for simple status of one employee; use itops_get_onboarding_status_by_employee. Do not use this tool to process a current Slack message containing New Joiner Alert; use itops_auto_process_onboarding_from_slack_message for that.',
        inputSchema: {
          limit: z.number().int().min(1).max(50).optional(),
        },
      },
      async ({ limit }) =>
        this.runTool(
          'itops_list_onboarding_work_queue',
          {},
          () => this.itopsClient.listOnboardingWorkQueue({ limit }),
          undefined,
          buildListOnboardingWorkQueueResponse,
        ),
    );

    server.registerTool(
      'itops_continue_onboarding_setup',
      {
        title: 'Continue Onboarding Setup',
        description:
          'Continue approved onboarding critical setup by onboardingIntakeId or natural fields. Runs pending Google Workspace company email and Slack workspace membership tasks in order, finalizes onboarding when complete, and never executes Slack channel access.',
        inputSchema: {
          onboardingIntakeId: z.string().uuid().optional(),
          name: z.string().trim().min(1).max(200).optional(),
          designation: z.string().trim().min(1).max(200).optional(),
          doj: z.string().regex(datePattern).optional(),
          personalEmail: z.string().email().optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_continue_onboarding_setup',
          { onboardingIntakeId: input.onboardingIntakeId },
          async () => {
            const onboardingIntakeId =
              input.onboardingIntakeId ??
              (await this.resolveOpenOnboardingIntakeByNaturalFields(input)).id;

            return this.itopsClient.continueOnboardingSetup({
              onboardingIntakeId,
            });
          },
          (result) => ({
            employeeId: getNestedStringProperty(result, 'employee', 'id'),
            onboardingIntakeId: getNestedStringProperty(
              result,
              'onboardingIntake',
              'id',
            ),
          }),
          buildContinueOnboardingSetupResponse,
        ),
    );

    server.registerTool(
      'itops_finalize_onboarding_by_employee',
      {
        title: 'Finalize Onboarding By Employee',
        description:
          'Finalize a completed onboarding by employee name, company email, personal email, designation, or start date. Never ask Slack users for onboarding intake ids.',
        inputSchema: {
          onboardingIntakeId: z.string().uuid().optional(),
          employeeId: z.string().uuid().optional(),
          query: z.string().trim().min(1).max(255).optional(),
          name: z.string().trim().min(1).max(255).optional(),
          workEmail: z.string().email().optional(),
          personalEmail: z.string().email().optional(),
          designation: z.string().trim().min(1).max(180).optional(),
          doj: z.string().regex(datePattern).optional(),
          actorExternalUserId: z.string().trim().min(1).optional(),
          reason: z.string().trim().min(1).max(1000).optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_finalize_onboarding_by_employee',
          {
            onboardingIntakeId: input.onboardingIntakeId,
            employeeId: input.employeeId,
          },
          () => this.itopsClient.finalizeOnboardingByEmployee(input),
          (result) => ({
            employeeId: getNestedStringProperty(result, 'employee', 'id'),
            onboardingIntakeId: getNestedStringProperty(
              result,
              'onboardingIntake',
              'id',
            ),
          }),
          buildFinalizeOnboardingByEmployeeResponse,
        ),
    );

    server.registerTool(
      'itops_cancel_onboarding_intake',
      {
        title: 'Cancel Onboarding Intake',
        description:
          'Admin cleanup tool. Cancel a bad or duplicate onboarding intake by natural fields before setup starts. Use for incorrect intakes such as a wrong designation duplicate. Prefer designation/start date/personal email for disambiguation and always pass the requesting Slack user as actorExternalUserId.',
        inputSchema: {
          onboardingIntakeId: z.string().uuid().optional(),
          query: z.string().trim().min(1).max(255).optional(),
          name: z.string().trim().min(1).max(255).optional(),
          personalEmail: z.string().email().optional(),
          designation: z.string().trim().min(1).max(180).optional(),
          doj: z.string().regex(datePattern).optional(),
          actorExternalUserId: z.string().trim().min(1),
          reason: z.string().trim().min(1).max(1000).optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_cancel_onboarding_intake',
          { onboardingIntakeId: input.onboardingIntakeId },
          () => this.itopsClient.cancelOnboardingIntake(input),
          (result) => ({
            onboardingIntakeId: getNestedStringProperty(
              result,
              'onboardingIntake',
              'id',
            ),
          }),
          buildOnboardingIntakeStatusChangeResponse,
        ),
    );

    server.registerTool(
      'itops_supersede_onboarding_intake',
      {
        title: 'Supersede Onboarding Intake',
        description:
          'Admin cleanup tool. Mark a validation-failed duplicate onboarding intake as superseded by a corrected intake. Use for invalid duplicate New Joiner Alerts that should no longer appear as active onboarding work and always pass the requesting Slack user as actorExternalUserId.',
        inputSchema: {
          onboardingIntakeId: z.string().uuid().optional(),
          query: z.string().trim().min(1).max(255).optional(),
          name: z.string().trim().min(1).max(255).optional(),
          personalEmail: z.string().email().optional(),
          designation: z.string().trim().min(1).max(180).optional(),
          doj: z.string().regex(datePattern).optional(),
          actorExternalUserId: z.string().trim().min(1),
          reason: z.string().trim().min(1).max(1000).optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_supersede_onboarding_intake',
          { onboardingIntakeId: input.onboardingIntakeId },
          () => this.itopsClient.supersedeOnboardingIntake(input),
          (result) => ({
            onboardingIntakeId: getNestedStringProperty(
              result,
              'onboardingIntake',
              'id',
            ),
          }),
          buildOnboardingIntakeStatusChangeResponse,
        ),
    );

    server.registerTool(
      'itops_finalize_onboarding',
      {
        title: 'Finalize Onboarding',
        description:
          'Finalize an onboarding intake after all required setup tasks are complete. This marks the employee active but does not execute setup tasks.',
        inputSchema: {
          onboardingIntakeId: z.string().uuid(),
        },
      },
      async ({ onboardingIntakeId }) =>
        this.runTool(
          'itops_finalize_onboarding',
          { onboardingIntakeId },
          () => this.itopsClient.finalizeOnboarding({ onboardingIntakeId }),
          (result) => ({
            employeeId: getNestedStringProperty(result, 'employee', 'id'),
            onboardingIntakeId: getNestedStringProperty(
              result,
              'onboardingIntake',
              'id',
            ),
          }),
          buildFinalizeOnboardingResponse,
        ),
    );

    server.registerTool(
      'itops_create_offboarding_intake',
      {
        title: 'Create Offboarding Intake',
        description:
          'Manual/recovery path: create an offboarding intake and preview active access. For normal lifecycle offboarding requests, use itops_auto_process_offboarding. This tool does not approve offboarding, execute revoke tasks, call connectors, or change employee status.',
        inputSchema: {
          employeeId: z.string().uuid(),
          lastWorkingDay: z.string().regex(datePattern).nullable().optional(),
          reason: z.string().trim().min(1).max(1000).nullable().optional(),
          requestedByExternalUserId: z.string().trim().min(1).optional(),
          notes: z.string().trim().min(1).max(2000).nullable().optional(),
        },
      },
      async (input) => {
        const createInput = {
          ...input,
          requestedByExternalUserId:
            input.requestedByExternalUserId?.trim() ||
            UNKNOWN_GANTRY_REQUESTER_ID,
        };

        return this.runTool(
          'itops_create_offboarding_intake',
          { employeeId: input.employeeId },
          () => this.itopsClient.createOffboardingIntake(createInput),
          (result) => ({
            offboardingIntakeId: getNestedStringProperty(
              result,
              'offboardingIntake',
              'id',
            ),
            employeeId: getNestedStringProperty(result, 'employee', 'id'),
          }),
          buildCreateOffboardingIntakeResponse,
        );
      },
    );

    server.registerTool(
      'itops_auto_process_offboarding',
      {
        title: 'Auto Process Offboarding',
        description:
          'Default lifecycle path for offboarding or preboarding cancellation. Creates or reuses the offboarding intake, records the initial request as lifecycle authority, creates backend revoke tasks, executes available revoke tasks, and finalizes offboarding when backend state allows.',
        inputSchema: {
          employeeId: z.string().uuid(),
          lastWorkingDay: z.string().regex(datePattern).nullable().optional(),
          reason: z.string().trim().min(1).max(1000).nullable().optional(),
          requestedByExternalUserId: z.string().trim().min(1).optional(),
          notes: z.string().trim().min(1).max(2000).nullable().optional(),
        },
      },
      async (input) => {
        const createInput = {
          ...input,
          requestedByExternalUserId:
            input.requestedByExternalUserId?.trim() ||
            UNKNOWN_GANTRY_REQUESTER_ID,
        };

        return this.runTool(
          'itops_auto_process_offboarding',
          { employeeId: input.employeeId },
          () => this.itopsClient.autoProcessOffboarding(createInput),
          (result) => ({
            employeeId: getNestedStringProperty(result, 'employee', 'id'),
            offboardingIntakeId: getNestedStringProperty(
              result,
              'offboardingIntake',
              'id',
            ),
          }),
          buildAutoProcessOffboardingResponse,
        );
      },
    );

    server.registerTool(
      'itops_auto_process_offboarding_from_slack_message',
      {
        title: 'Auto Process Offboarding From Slack Message',
        description:
          'Required lifecycle channel path for a Slack Offboarding Alert. Call this tool first with rawText set to the full Slack message text. Parses Work Email and Last Working Day, resolves the employee by work email, records the initial request as lifecycle authority, executes available revoke tasks, retries supported revoke tasks, and finalizes when backend state allows.',
        inputSchema: {
          workspaceId: z.string().trim().min(1).max(100).nullable().optional(),
          channelId: z.string().trim().min(1).max(100).nullable().optional(),
          messageTs: z.string().trim().min(1).max(100).nullable().optional(),
          threadTs: z.string().trim().min(1).max(100).nullable().optional(),
          senderSlackUserId: z
            .string()
            .trim()
            .min(1)
            .max(120)
            .nullable()
            .optional(),
          senderExternalUserId: z
            .string()
            .trim()
            .min(1)
            .max(150)
            .nullable()
            .optional(),
          rawText: z.string().refine((value) => value.trim().length > 0, {
            message: 'rawText is required.',
          }),
        },
      },
      async (input) => {
        const normalizedInput = normalizeOffboardingSlackInput(input);

        return this.runTool(
          'itops_auto_process_offboarding_from_slack_message',
          {},
          () =>
            processOffboardingAlertSlackMessage(
              normalizedInput,
              this.itopsClient,
            ),
          (result) => ({
            employeeId: getNestedStringProperty(
              getRecordProperty(result, 'result'),
              'employee',
              'id',
            ),
            offboardingIntakeId: getNestedStringProperty(
              getRecordProperty(result, 'result'),
              'offboardingIntake',
              'id',
            ),
          }),
          buildAutoProcessOffboardingFromSlackMessageResponse,
        );
      },
    );

    server.registerTool(
      'itops_get_offboarding_intake',
      {
        title: 'Get Offboarding Intake',
        description: 'Get one offboarding intake by id. This is read-only.',
        inputSchema: {
          offboardingIntakeId: z.string().uuid(),
        },
      },
      async ({ offboardingIntakeId }) =>
        this.runTool(
          'itops_get_offboarding_intake',
          { offboardingIntakeId },
          () => this.itopsClient.getOffboardingIntake({ offboardingIntakeId }),
        ),
    );

    server.registerTool(
      'itops_decide_offboarding_intake',
      {
        title: 'Decide Offboarding Intake',
        description:
          'Approve or reject an offboarding intake. Approval creates revoke requests/tasks only; this tool does not execute revoke tasks or call connectors.',
        inputSchema: {
          offboardingIntakeId: z.string().uuid(),
          decision: z.enum(['approved', 'rejected']),
          approverExternalUserId: z.string().trim().min(1).optional(),
          comment: z.string().trim().min(1).nullable().optional(),
          source: z.string().trim().min(1).optional(),
          gantryConversationId: z.string().trim().min(1).nullable().optional(),
          gantryRuntimeEventId: z.string().trim().min(1).nullable().optional(),
        },
      },
      async (input) =>
        this.runTool(
          'itops_decide_offboarding_intake',
          { offboardingIntakeId: input.offboardingIntakeId },
          () =>
            this.itopsClient.decideOffboardingIntake({
              ...input,
              approverExternalUserId: withFallbackExternalUserId(
                input.approverExternalUserId,
                UNKNOWN_GANTRY_APPROVER_ID,
              ),
            }),
          (result) => ({
            employeeId: getNestedStringProperty(result, 'employee', 'id'),
            offboardingIntakeId: getNestedStringProperty(
              result,
              'offboardingIntake',
              'id',
            ),
            accessRequestId: getFirstNestedArrayStringProperty(
              result,
              'revokeItems',
              'accessRequestId',
            ),
            accessTaskId: getFirstNestedArrayStringProperty(
              result,
              'revokeItems',
              'accessTaskId',
            ),
          }),
          buildDecideOffboardingIntakeResponse,
        ),
    );

    server.registerTool(
      'itops_get_offboarding_status',
      {
        title: 'Get Offboarding Status',
        description:
          'Get offboarding revoke progress and whether the intake can be finalized. This is read-only.',
        inputSchema: {
          offboardingIntakeId: z.string().uuid(),
        },
      },
      async ({ offboardingIntakeId }) =>
        this.runTool(
          'itops_get_offboarding_status',
          { offboardingIntakeId },
          () => this.itopsClient.getOffboardingStatus({ offboardingIntakeId }),
        ),
    );

    server.registerTool(
      'itops_finalize_offboarding',
      {
        title: 'Finalize Offboarding',
        description:
          'Finalize an offboarding intake after all revoke tasks are complete or covered. This marks the employee offboarded but does not execute revoke tasks.',
        inputSchema: {
          offboardingIntakeId: z.string().uuid(),
        },
      },
      async ({ offboardingIntakeId }) =>
        this.runTool(
          'itops_finalize_offboarding',
          { offboardingIntakeId },
          () => this.itopsClient.finalizeOffboarding({ offboardingIntakeId }),
          (result) => ({
            employeeId: getNestedStringProperty(result, 'employee', 'id'),
            offboardingIntakeId: getNestedStringProperty(
              result,
              'offboardingIntake',
              'id',
            ),
          }),
          buildFinalizeOffboardingResponse,
        ),
    );
  }

  private async runTool(
    action: string,
    ids: AuditIds,
    operation: () => Promise<unknown>,
    successIds?: (result: unknown) => AuditIds,
    userFacingText?: (result: unknown) => string | undefined,
  ): Promise<ToolResult> {
    try {
      const result = await operation();
      this.auditService.record({
        action,
        success: true,
        ...ids,
        ...(successIds?.(result) ?? {}),
      });

      return toSuccessResult(result, userFacingText?.(result));
    } catch (error) {
      const message = toSafeErrorMessage(error);

      this.auditService.record({
        action,
        success: false,
        ...ids,
        error: message,
      });

      return toErrorResult(message);
    }
  }

  private async resolveOpenOnboardingIntakeByNaturalFields(input: {
    name?: string;
    designation?: string;
    doj?: string;
    personalEmail?: string;
  }): Promise<OnboardingIntake> {
    const result = await this.itopsClient.resolveOnboardingIntake({
      name: input.name,
      designation: input.designation,
      doj: input.doj,
      personalEmail: input.personalEmail,
      status: 'open',
    });

    return result.onboardingIntake;
  }

  private async resolveOnboardingIntakeForStatus(
    input: OnboardingStatusLookupInput,
  ): Promise<OnboardingIntake> {
    const statuses = [
      'open',
      'completed',
      'pending_review',
      'needs_correction',
    ] as const;
    let notFoundError: unknown;

    for (const status of statuses) {
      try {
        const result = await this.itopsClient.resolveOnboardingIntake({
          employeeId: input.employeeId,
          query: input.query,
          name: input.name,
          workEmail: input.workEmail,
          personalEmail: input.personalEmail,
          designation: input.designation,
          doj: input.doj,
          status,
        });

        return result.onboardingIntake;
      } catch (error) {
        if (!isItOpsApiNotFoundError(error)) {
          throw error;
        }

        notFoundError = error;
      }
    }

    throw (
      notFoundError ?? new Error('No matching onboarding intake was found.')
    );
  }
}

function toSuccessResult(result: unknown, text?: string): ToolResult {
  if (text) {
    return {
      content: [
        {
          type: 'text',
          text: sanitizeUserFacingToolText(text),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: { result },
  };
}

export function sanitizeUserFacingToolText(text: string): string {
  const lines = text.split(/\r?\n/u);
  const sanitizedLines = lines.filter((line) => !isToolInstructionLine(line));

  return sanitizedLines.join('\n').replace(/^\n+/u, '').trimEnd();
}

export function shouldAutoProcessOnboardingSlackMessage(input: {
  rawText: string;
  manualRecovery?: boolean;
}): boolean {
  if (input.manualRecovery === true) {
    return false;
  }

  return /\bnew\s+joiner\s+alert\b/iu.test(input.rawText);
}

export function shouldAutoProcessOffboardingSlackMessage(input: {
  rawText: string;
}): boolean {
  return /\boffboarding\s+aler(?:t)?\b/iu.test(input.rawText);
}

export function parseOffboardingAlert(rawText: string): {
  detectedType: 'offboarding_alert' | 'unknown';
  fields: {
    name: string | null;
    workEmail: string | null;
    lastWorkingDay: string | null;
  };
  missingFields: string[];
  parseErrors: string[];
} {
  if (!shouldAutoProcessOffboardingSlackMessage({ rawText })) {
    return {
      detectedType: 'unknown',
      fields: {
        name: null,
        workEmail: null,
        lastWorkingDay: null,
      },
      missingFields: [],
      parseErrors: [],
    };
  }

  const rawFieldValues = extractOffboardingRawFieldValues(rawText);
  const fields = {
    name: normalizeOffboardingTextValue(rawFieldValues.name),
    workEmail: normalizeOffboardingEmailValue(rawFieldValues.workEmail),
    lastWorkingDay: normalizeOffboardingTextValue(
      rawFieldValues.lastWorkingDay,
    ),
  };
  const missingFields = [
    ...(fields.workEmail ? [] : ['Work Email']),
    ...(fields.lastWorkingDay ? [] : ['Last Working Day']),
  ];
  const parseErrors = [
    ...(fields.workEmail &&
    !z.string().email().safeParse(fields.workEmail).success
      ? ['Work Email must be a valid email address.']
      : []),
    ...(fields.lastWorkingDay && !datePattern.test(fields.lastWorkingDay)
      ? ['Last Working Day must use YYYY-MM-DD format.']
      : []),
  ];

  return {
    detectedType: 'offboarding_alert',
    fields,
    missingFields,
    parseErrors,
  };
}

export async function processOffboardingAlertSlackMessage(
  input: OffboardingSlackInput,
  itopsClient: OffboardingAlertProcessorClient,
): Promise<OffboardingAlertProcessResult> {
  const normalizedInput = normalizeOffboardingSlackInput(input);
  const parsed = parseOffboardingAlert(normalizedInput.rawText);

  if (
    parsed.detectedType !== 'offboarding_alert' ||
    parsed.missingFields.length > 0 ||
    parsed.parseErrors.length > 0 ||
    !parsed.fields.workEmail ||
    !parsed.fields.lastWorkingDay
  ) {
    return {
      kind: 'offboarding_alert_validation_error',
      parsed,
    };
  }

  const resolution = await itopsClient.resolveEmployee({
    query: parsed.fields.workEmail,
    purpose: 'offboarding',
  });

  if (resolution.status !== 'resolved' || !resolution.employee) {
    return {
      kind: 'offboarding_alert_resolution_error',
      parsed,
      resolution,
    };
  }

  if (
    !offboardingAlertNameMatchesEmployee(
      parsed.fields.name,
      resolution.employee.fullName,
    )
  ) {
    return {
      kind: 'offboarding_alert_name_mismatch',
      parsed,
      resolution,
    };
  }

  const result = await itopsClient.autoProcessOffboarding({
    employeeId: resolution.employee.employeeId,
    lastWorkingDay: parsed.fields.lastWorkingDay,
    requestedByExternalUserId:
      normalizedInput.senderExternalUserId ?? UNKNOWN_GANTRY_REQUESTER_ID,
    notes: formatOffboardingAlertNotes({
      alertName: parsed.fields.name,
      alertWorkEmail: parsed.fields.workEmail,
      workspaceId: normalizedInput.workspaceId,
      channelId: normalizedInput.channelId,
      messageTs: normalizedInput.messageTs,
      threadTs: normalizedInput.threadTs,
    }),
  });

  return {
    kind: 'offboarding_alert_processed',
    parsed,
    resolution,
    result,
  };
}

function isToolInstructionLine(line: string): boolean {
  const normalized = line.trim();

  return (
    normalized.startsWith('Use this exact Slack response style.') ||
    normalized.startsWith('Use only this Slack response block.')
  );
}

function withFallbackExternalUserId(
  value: string | null | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export function buildCreateAccessRequestResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const action = getDisplayValue(getStringProperty(result, 'action'));
  const status = formatEmployeeStatus(getStringProperty(result, 'status'));
  const systemKey = formatCatalogKey(getStringProperty(result, 'systemKey'));
  const resourceKey = formatCatalogKey(
    getStringProperty(result, 'resourceKey'),
  );
  const roleKey = formatCatalogKey(getStringProperty(result, 'roleKey'));
  const title =
    action.toLowerCase() === 'revoke'
      ? 'Access revoke request created'
      : 'Access request created';

  return [
    `*${title}*`,
    '',
    `Target: ${systemKey} ${resourceKey} ${roleKey}`,
    `Status: ${status}`,
    '',
    'I’ll wait for an authorized approver before I run any setup or revoke task.',
  ].join('\n');
}

export function buildResolveEmployeeResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const status = getStringProperty(result, 'status');
  const query = getDisplayValue(getStringProperty(result, 'query'));
  const purpose = getStringProperty(result, 'purpose');
  const actionLabel = getResolutionActionLabel(purpose);
  const matches = getArrayProperty(result, 'matches');
  const employee = getRecordProperty(result, 'employee');

  if (status === 'multiple_matches') {
    return [
      `*I found multiple employees matching "${query}"*`,
      '',
      ...matches.map(
        (match, index) =>
          `${index + 1}. ${formatResolvedEmployeeSummary(match)}`,
      ),
      '',
      `Please send the number or company email for the right person, and I’ll continue with ${actionLabel}.`,
    ].join('\n');
  }

  if (status === 'needs_confirmation' && employee) {
    const employeeStatus = getStringProperty(employee, 'status')
      ?.trim()
      .toLowerCase();
    const workEmail = getDisplayValue(getStringProperty(employee, 'workEmail'));

    if (purpose === 'offboarding' && employeeStatus === 'offboarded') {
      return [
        '*No change*',
        '',
        `I found ${formatResolvedEmployeeSummary(employee)}.`,
        '',
        'This employee is already offboarded. No new offboarding workflow is needed.',
      ].join('\n');
    }

    if (purpose === 'offboarding') {
      return [
        '*Confirm employee*',
        '',
        `I found ${formatResolvedEmployeeSummary(employee)}.`,
        '',
        `To make sure I offboard the right person, can you confirm this is ${workEmail}? If not, send the correct company email.`,
      ].join('\n');
    }

    if (purpose === 'mutate') {
      return [
        '*Confirm employee*',
        '',
        `I found ${formatResolvedEmployeeSummary(employee)}.`,
        '',
        `To make sure I update the right person, can you confirm this is ${workEmail}? If not, send the correct company email.`,
      ].join('\n');
    }

    return [
      '*Confirm employee*',
      '',
      `I found ${formatResolvedEmployeeSummary(employee)}.`,
      '',
      `If this is the right person, can you confirm this is ${workEmail}? If not, send the correct company email.`,
    ].join('\n');
  }

  if (status === 'not_found') {
    return [
      '*Employee not found*',
      '',
      `I couldn't find an employee matching "${query}".`,
      '',
      'Please send the company email or a more specific name so I can find the right employee.',
    ].join('\n');
  }

  if (status === 'resolved' && employee) {
    return [
      '*Employee resolved*',
      '',
      formatResolvedEmployeeSummary(employee),
      '',
      'I have the right employee now. I’ll continue with the requested IT Ops action.',
    ].join('\n');
  }

  return undefined;
}

export function buildCreateOnboardingIntakeResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const intake = getRecordProperty(result, 'onboardingIntake');
  if (!intake) {
    return undefined;
  }

  const valid = getBooleanProperty(result, 'valid');
  const name = getDisplayValue(getStringProperty(intake, 'name'));
  const startDate = getDisplayValue(getStringProperty(intake, 'doj'));
  const employment = formatEmploymentType(
    getStringProperty(intake, 'employmentType'),
  );
  const designation = getDisplayValue(getStringProperty(intake, 'designation'));
  const laptop = getDisplayValue(getStringProperty(intake, 'laptop'));
  const relocation = getDisplayValue(getStringProperty(intake, 'relocation'));
  const slackChannels = formatSlackChannels(
    getArrayProperty(intake, 'requestedSlackChannels'),
  );
  const validationErrors = getStringArrayProperty(result, 'validationErrors');
  const created = getBooleanProperty(result, 'created') !== false;

  if (!valid) {
    return [
      '*Onboarding request needs correction*',
      '',
      '*Employee*',
      `Name: ${name}`,
      `Start date: ${startDate}`,
      `Employment: ${employment}`,
      `Designation: ${designation}`,
      '',
      '*Issue*',
      validationErrors.length > 0
        ? validationErrors.map((error) => `- ${error}`).join('\n')
        : 'Some required onboarding details are missing or invalid.',
      '',
      'Please send a corrected New Joiner Alert with the missing or invalid details.',
    ].join('\n');
  }

  return [
    created ? '*Onboarding request created*' : '*Existing onboarding found*',
    '',
    created
      ? `Got it — I’ve created the onboarding request for ${name}.`
      : `I found the existing onboarding for ${name}.`,
    '',
    '*Employee*',
    name,
    `Starts: ${startDate}`,
    `Role: ${designation}`,
    `Type: ${employment}`,
    '',
    '*Setup requested*',
    `Laptop: ${laptop}`,
    `Relocation: ${relocation}`,
    `Slack: ${slackChannels}`,
    '',
    '*Where it stands*',
    created
      ? 'I haven’t created any accounts yet. I’m waiting for admin approval.'
      : 'This is still waiting for admin approval.',
    '',
    created
      ? 'Once an authorized admin approves it, I can start the setup.'
      : 'Once an authorized admin approves it, I’ll continue from there.',
  ].join('\n');
}

export function buildAutoProcessOnboardingResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const valid = getBooleanProperty(result, 'valid');
  if (valid === false) {
    return buildCreateOnboardingIntakeResponse(result);
  }

  const setup = getRecordProperty(result, 'setup');
  if (setup) {
    return buildContinueOnboardingSetupResponse(setup, {
      created: getBooleanProperty(result, 'created'),
      lifecycleAuto: true,
    });
  }

  const intake = getRecordProperty(result, 'onboardingIntake');
  if (!intake) {
    return undefined;
  }

  return [
    '*Onboarding setup progress*',
    '',
    `Employee: ${getDisplayValue(getStringProperty(intake, 'name'))}`,
    `Starts: ${getDisplayValue(getStringProperty(intake, 'doj'))}`,
    `Role: ${getDisplayValue(getStringProperty(intake, 'designation'))}`,
    '',
    'The onboarding request was accepted from the lifecycle channel, but setup status was not returned. Check onboarding status before reporting completion.',
  ].join('\n');
}

export function buildListOnboardingIntakesResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const intakes = getArrayProperty(result, 'onboardingIntakes');
  const count = getNumberProperty(result, 'count') ?? intakes.length;

  if (count === 0 || intakes.length === 0) {
    return [
      '*Pending onboarding requests*',
      '',
      'I don’t see any pending onboarding requests right now.',
      '',
      'If you want to start one, post a New Joiner Alert.',
    ].join('\n');
  }

  return [
    '*Pending onboarding requests*',
    '',
    ...intakes.map(formatOnboardingIntakeListLine),
    '',
    'Once an authorized admin approves one in its thread, I can continue it.',
  ].join('\n');
}

export function buildGetOnboardingIntakeResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const intake = getRecordProperty(result, 'onboardingIntake');
  if (!intake) {
    return undefined;
  }

  const name = getDisplayValue(getStringProperty(intake, 'name'));
  const startDate = getDisplayValue(getStringProperty(intake, 'doj'));
  const designation = getDisplayValue(getStringProperty(intake, 'designation'));
  const status = formatOnboardingWorkflowStatus(
    getStringProperty(intake, 'status'),
  );

  return [
    '*Onboarding request found*',
    '',
    '*Employee*',
    name,
    `Starts: ${startDate}`,
    `Role: ${designation}`,
    '',
    `Status: ${status}`,
    '',
    'I can continue with this onboarding request.',
  ].join('\n');
}

export function buildListEmployeesWithOnboardingIntakesResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const intakes = getArrayProperty(result, 'openOnboardingIntakes');
  const count =
    getNumberProperty(result, 'openOnboardingCount') ?? intakes.length;

  return [
    '*Open onboarding requests*',
    '',
    ...(count === 0 || intakes.length === 0
      ? ['I don’t see any open onboarding requests right now.']
      : intakes.map(formatOnboardingIntakeListLine)),
    '',
    count === 0 || intakes.length === 0
      ? 'If you want to start one, post a New Joiner Alert.'
      : 'If you want me to continue one, approve it in its original thread or ask me to start an approved setup.',
  ].join('\n');
}

export function buildListEmployeesResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const employees = getArrayProperty(result, 'employees');
  const page = getNumberProperty(result, 'page') ?? 1;
  const pageSize = getNumberProperty(result, 'pageSize') ?? 20;
  const total = getNumberProperty(result, 'total') ?? employees.length;
  const hasNextPage = getBooleanProperty(result, 'hasNextPage') ?? false;
  const status = getStringProperty(result, 'status') ?? 'open';
  const totalPages = Math.max(1, Math.ceil(total / Math.max(pageSize, 1)));
  const title =
    status === 'offboarded'
      ? 'Offboarded employees'
      : status === 'all'
        ? 'Employees'
        : 'Current employees';

  return [
    `*${title}*`,
    `Page ${page} of ${totalPages} - ${total} total`,
    '',
    ...(employees.length === 0
      ? ['None found.']
      : employees.map(formatEmployeeListLine)),
    '',
    hasNextPage
      ? `If you want more, ask me to show page ${page + 1}.`
      : 'If you want access details, send me an employee name or company email.',
  ].join('\n');
}

export function buildDecideOnboardingIntakeResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const intake = getRecordProperty(result, 'onboardingIntake');
  if (!intake) {
    return undefined;
  }

  const decision = getRecordProperty(result, 'decision');
  const decisionValue = decision
    ? getStringProperty(decision, 'decision')
    : undefined;
  const name = getDisplayValue(getStringProperty(intake, 'name'));
  const startDate = getDisplayValue(getStringProperty(intake, 'doj'));
  const requestedSlackChannels = formatSlackChannels(
    getArrayProperty(intake, 'requestedSlackChannels'),
  );

  if (decisionValue === 'rejected') {
    return [
      '*Onboarding rejected*',
      '',
      '*Employee*',
      `Name: ${name}`,
      `Start date: ${startDate}`,
      '',
      '*Status*',
      'No employee record or access setup was created.',
      '',
      'If you want to restart onboarding, send a corrected New Joiner Alert.',
    ].join('\n');
  }

  return [
    '*Onboarding approved*',
    '',
    '*Employee*',
    `Name: ${name}`,
    `Start date: ${startDate}`,
    'Status: Ready for setup',
    '',
    '*Access setup*',
    'Waiting - Company email',
    'Waiting - Slack workspace invite',
    ...(requestedSlackChannels !== 'None'
      ? [
          '',
          '*Follow-up*',
          `Slack channels requested: ${requestedSlackChannels}`,
          'I’ll leave channel access out of onboarding for now so the setup can finish cleanly.',
        ]
      : []),
    '',
    `Should I start setup for ${name} now?`,
  ].join('\n');
}

export function buildOnboardingStatusResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const employee = getRecordProperty(result, 'employee');
  const intake = getRecordProperty(result, 'onboardingIntake');
  const setupItems = getArrayProperty(result, 'setupItems');
  const canFinalize = getBooleanProperty(result, 'canFinalize') === true;
  const criticalItems = setupItems.filter(
    (item) => !isFollowUpOnboardingSetupItem(item),
  );
  const completedItems = criticalItems.filter(isCompletedOnboardingSetupItem);
  const failedItems = criticalItems.filter(isFailedOnboardingSetupItem);
  const pendingItems = criticalItems.filter(
    (item) =>
      !isCompletedOnboardingSetupItem(item) &&
      !isFailedOnboardingSetupItem(item),
  );
  const requestedSlackChannels = intake
    ? formatSlackChannels(getArrayProperty(intake, 'requestedSlackChannels'))
    : 'None';
  const name = getDisplayValue(getStringProperty(employee, 'fullName'));
  const workEmail = getDisplayValue(getStringProperty(employee, 'workEmail'));
  const isActiveOrCompleted =
    getStringProperty(employee, 'status') === 'active' ||
    getStringProperty(intake, 'status') === 'completed';

  if (failedItems.length > 0) {
    return [
      `I found onboarding for ${name}, but one setup item still needs attention.`,
      '',
      formatOnboardingNeedsAttentionSummary(completedItems, failedItems),
      `Their work email is ${workEmail}.`,
      ...formatSlackChannelRequestLines(requestedSlackChannels),
      '',
      'I can retry after the Slack invite issue is fixed.',
    ].join('\n');
  }

  if (pendingItems.length > 0) {
    return [
      `I found onboarding for ${name}, and setup is still moving.`,
      '',
      formatOnboardingPartialSetupSummary(completedItems, pendingItems),
      `Their work email is ${workEmail}.`,
      ...formatSlackChannelPendingInviteFollowUp(requestedSlackChannels),
      '',
      formatOnboardingPendingSummary(pendingItems),
    ].join('\n');
  }

  if (canFinalize) {
    return [
      isActiveOrCompleted
        ? `${name} is active.`
        : `Setup is complete for ${name}.`,
      '',
      formatOnboardingCompletedSummary(completedItems),
      `Work email: ${workEmail}`,
      ...formatSlackChannelAcceptedInviteFollowUp(requestedSlackChannels),
    ].join('\n');
  }

  return [
    isActiveOrCompleted
      ? `${name} is active.`
      : `${name} is set up from the account side.`,
    '',
    formatOnboardingCompletedSummary(completedItems),
    `Work email: ${workEmail}`,
    ...formatSlackChannelAcceptedInviteFollowUp(requestedSlackChannels),
  ].join('\n');
}

export function buildListPendingOnboardingSetupsResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const pendingSetups = getArrayProperty(result, 'pendingSetups');

  if (pendingSetups.length === 0) {
    return [
      '*Pending onboarding setup*',
      '',
      'I don’t see any approved onboarding setup waiting on Google Workspace or Slack workspace membership right now.',
      '',
      'If you want me to check a specific employee, send their name or company email.',
    ].join('\n');
  }

  if (pendingSetups.length === 1) {
    const setup = pendingSetups[0];

    return [
      '*Pending onboarding setup found*',
      '',
      formatPendingOnboardingSetupLine(setup),
      '',
      'Should I continue this onboarding setup now?',
    ].join('\n');
  }

  return [
    '*Pending onboarding setups*',
    '',
    ...pendingSetups.map(formatPendingOnboardingSetupLine),
    '',
    'Which onboarding setup should I continue?',
  ].join('\n');
}

export function buildListOnboardingWorkQueueResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const items = getArrayProperty(result, 'items');

  if (items.length === 0) {
    return [
      '*Pending onboardings*',
      '',
      'I don’t see any onboarding work waiting right now.',
    ].join('\n');
  }

  return [
    '*Pending onboardings*',
    '',
    ...items.map(formatOnboardingWorkQueueLine),
    '',
    'I can continue or finalize a specific onboarding if you send the employee name or company email.',
  ].join('\n');
}

export function buildContinueOnboardingSetupResponse(
  result: unknown,
  options: {
    created?: boolean;
    lifecycleAuto?: boolean;
  } = {},
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const employee = getRecordProperty(result, 'employee');
  const intake = getRecordProperty(result, 'onboardingIntake');
  const setupItems = getArrayProperty(result, 'setupItems');
  const finalized = getBooleanProperty(result, 'finalized') === true;
  const criticalItems = setupItems.filter(
    (item) => !isFollowUpOnboardingSetupItem(item),
  );
  const completedItems = criticalItems.filter(isCompletedOnboardingSetupItem);
  const pendingItems = criticalItems.filter(
    (item) => !isCompletedOnboardingSetupItem(item),
  );
  const failedItems = criticalItems.filter(isFailedOnboardingSetupItem);
  const executionErrors = getArrayProperty(result, 'executionErrors');
  const requestedSlackChannels = intake
    ? formatSlackChannels(getArrayProperty(intake, 'requestedSlackChannels'))
    : 'None';
  const completedChannelFollowUp = formatSlackChannelAcceptedInviteFollowUp(
    requestedSlackChannels,
  );
  const pendingChannelFollowUp = formatSlackChannelPendingInviteFollowUp(
    requestedSlackChannels,
  );
  const name = getDisplayValue(getStringProperty(employee, 'fullName'));
  const workEmail = getDisplayValue(getStringProperty(employee, 'workEmail'));
  const hasPendingCriticalSetup = pendingItems.length > 0;

  if (finalized) {
    return [
      `Done, ${name} is set up.`,
      '',
      formatOnboardingCompletedSummary(completedItems),
      `Their work email is ${workEmail}.`,
      ...completedChannelFollowUp,
    ].join('\n');
  }

  if (failedItems.length > 0 || executionErrors.length > 0) {
    return [
      formatOnboardingSetupIntro(name, options),
      '',
      formatOnboardingNeedsAttentionSummary(
        completedItems,
        failedItems.length > 0 ? failedItems : pendingItems,
      ),
      `Their work email is ${workEmail}.`,
      ...formatSlackChannelRequestLines(requestedSlackChannels),
      '',
      'I can retry after the Slack invite issue is fixed.',
    ].join('\n');
  }

  return [
    hasPendingCriticalSetup
      ? `I started onboarding ${name}, and the account setup is still moving.`
      : `Done, ${name} is set up.`,
    '',
    hasPendingCriticalSetup
      ? formatOnboardingPartialSetupSummary(completedItems, pendingItems)
      : formatOnboardingCompletedSummary(completedItems),
    `Their work email is ${workEmail}.`,
    ...(hasPendingCriticalSetup
      ? pendingChannelFollowUp
      : completedChannelFollowUp),
    ...(hasPendingCriticalSetup
      ? ['', formatOnboardingPendingSummary(pendingItems)]
      : []),
  ].join('\n');
}

export function buildFinalizeOnboardingByEmployeeResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const employee = getRecordProperty(result, 'employee');
  const duplicateWarnings = getArrayProperty(result, 'duplicateWarnings');
  const warnings =
    duplicateWarnings.length > 0
      ? [
          '',
          '*Duplicate cleanup note*',
          'I also found older invalid or inactive onboarding records for this employee. They did not block this finalization.',
        ]
      : [];

  return [
    `Done, ${getDisplayValue(getStringProperty(employee, 'fullName'))} is set up.`,
    '',
    `Their work email is ${getDisplayValue(getStringProperty(employee, 'workEmail'))}.`,
    '',
    'Required Google Workspace and Slack workspace setup are complete.',
    ...warnings,
  ].join('\n');
}

export function buildOnboardingIntakeStatusChangeResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const intake = getRecordProperty(result, 'onboardingIntake');
  if (!intake) {
    return undefined;
  }

  const status = formatOnboardingWorkflowStatus(
    getStringProperty(intake, 'status'),
  );

  return [
    '*Onboarding intake updated*',
    '',
    `Employee: ${getDisplayValue(getStringProperty(intake, 'name'))}`,
    `Role: ${getDisplayValue(getStringProperty(intake, 'designation'))}`,
    `Status: ${status}`,
    '',
    'This intake is no longer part of the active onboarding flow.',
  ].join('\n');
}

export function buildFinalizeOnboardingResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const employee = getRecordProperty(result, 'employee');
  if (!employee) {
    return undefined;
  }

  const setupItems = getArrayProperty(result, 'setupItems');
  const completedItems = setupItems.filter(
    (item) =>
      !isFollowUpOnboardingSetupItem(item) &&
      isCompletedOnboardingSetupItem(item),
  );

  return [
    `Done, ${getDisplayValue(getStringProperty(employee, 'fullName'))} is set up.`,
    '',
    formatOnboardingCompletedSummary(completedItems),
    `Their work email is ${getDisplayValue(getStringProperty(employee, 'workEmail'))}.`,
  ].join('\n');
}

export function buildCreateOffboardingIntakeResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const intake = getRecordProperty(result, 'offboardingIntake');
  const employee = getRecordProperty(result, 'employee');
  if (!employee) {
    return undefined;
  }

  const name = getDisplayValue(getStringProperty(employee, 'fullName'));
  const workEmail = getDisplayValue(getStringProperty(employee, 'workEmail'));
  const employeeStatus = getDisplayValue(getStringProperty(employee, 'status'));
  const designation = getUnknownValue(
    getStringProperty(employee, 'designation'),
  );
  const lifecycleCase = getStringProperty(result, 'employeeLifecycleCase');
  const lifecycleMessage = getStringProperty(result, 'message');
  const nextAction = getStringProperty(result, 'nextAction');
  const activeAccessPreview = getArrayProperty(result, 'activeAccessPreview');
  const activeAccessLines =
    formatOffboardingActiveAccessLines(activeAccessPreview);
  const activeAccessBlock =
    activeAccessLines.length > 0
      ? ['Active access found:', ...activeAccessLines]
      : ['Active access found: None'];
  const title = titleForCreateOffboardingLifecycle(lifecycleCase);

  if (nextAction === 'no_change') {
    return [
      '*No change*',
      '',
      `Employee: ${name}`,
      `Work email: ${workEmail}`,
      `Current employee status: ${employeeStatus}`,
      '',
      lifecycleMessage ?? 'Employee is already offboarded.',
      '',
      'This employee is already offboarded, so I don’t need to start a new offboarding workflow.',
    ].join('\n');
  }

  if (nextAction === 'view_existing_status') {
    const offboardingStatus = getRecordProperty(result, 'offboardingStatus');
    const statusRevokeItems = offboardingStatus
      ? getArrayProperty(offboardingStatus, 'revokeItems')
      : [];
    const summary = offboardingStatus
      ? getRecordProperty(offboardingStatus, 'summary')
      : undefined;
    const pendingCount =
      getNumberProperty(summary, 'pending') ?? statusRevokeItems.length;

    return [
      '*Offboarding already in progress*',
      '',
      `Employee: ${name}`,
      `Work email: ${workEmail}`,
      `Current employee status: ${employeeStatus}`,
      '',
      lifecycleMessage ??
        'Offboarding is already in progress. Here is the current status.',
      ...(statusRevokeItems.length > 0
        ? [
            '',
            'Pending revoke tasks:',
            ...formatOffboardingRevokeReadyLines(statusRevokeItems),
          ]
        : []),
      ...(pendingCount > 0
        ? [
            '',
            'I haven’t revoked anything yet. Continuing will suspend their company email and deactivate their Slack workspace membership.',
            '',
            `Can you confirm this is the right employee before I revoke access for ${workEmail}?`,
          ]
        : [
            '',
            'I can check the current offboarding status if you want me to.',
          ]),
    ].join('\n');
  }

  if (!intake) {
    return undefined;
  }

  return [
    `*${title}*`,
    '',
    `Employee: ${name}`,
    `Work email: ${workEmail}`,
    `Current employee status: ${employeeStatus}`,
    `Designation: ${designation}`,
    '',
    ...activeAccessBlock,
    '',
    lifecycleMessage ??
      'This will start offboarding and revoke active access after approval.',
    'Offboarding status: Waiting for admin approval',
    'No access has been revoked yet.',
    '',
    'An authorized admin can approve it. I won’t revoke access until then.',
  ].join('\n');
}

export function buildDecideOffboardingIntakeResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const intake = getRecordProperty(result, 'offboardingIntake');
  const decision = getRecordProperty(result, 'decision');
  const decisionValue =
    getStringProperty(result, 'decision') ??
    getStringProperty(decision, 'decision');
  const employee = getRecordProperty(result, 'employee');
  const revokeItems = getArrayProperty(result, 'revokeItems');
  const name = getDisplayValue(getStringProperty(employee, 'fullName'));
  const workEmail = getDisplayValue(getStringProperty(employee, 'workEmail'));

  if (decisionValue === 'rejected') {
    return [
      `I’ve marked the offboarding request for ${name} as rejected.`,
      '',
      'I didn’t create any revoke tasks, and no access was changed.',
    ].join('\n');
  }

  const revokeLines = formatOffboardingRevokeReadyLines(revokeItems);
  return [
    `I’ve got approval to offboard ${name}.`,
    '',
    'Here’s what I’m ready to remove:',
    ...revokeLines,
    '',
    'I haven’t revoked anything yet. Continuing will suspend their company email and deactivate their Slack workspace membership.',
    '',
    `Can you confirm this is the right employee before I revoke access for ${workEmail}?`,
  ].join('\n');
}

export function buildFinalizeOffboardingResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const employee = getRecordProperty(result, 'employee');
  if (!employee) {
    return undefined;
  }

  const name = getDisplayValue(getStringProperty(employee, 'fullName'));
  const workEmail = getDisplayValue(getStringProperty(employee, 'workEmail'));
  const revokeItems = getArrayProperty(result, 'revokeItems');
  const summary = getRecordProperty(result, 'summary');
  const failedCount = getNumberProperty(summary, 'failed') ?? 0;
  const pendingCount = getNumberProperty(summary, 'pending') ?? 0;
  const isComplete = failedCount === 0 && pendingCount === 0;
  const lifecycleCase = getStringProperty(result, 'employeeLifecycleCase');

  if (!isComplete) {
    const completedItems = revokeItems.filter(isCompletedOffboardingRevokeItem);
    const attentionItems = revokeItems.filter(
      (item) => !isCompletedOffboardingRevokeItem(item),
    );

    return [
      `${name} is not fully offboarded yet.`,
      '',
      ...(completedItems.length > 0
        ? [formatOffboardingCompletedSummary(completedItems)]
        : []),
      `Their work email is ${workEmail}.`,
      '',
      formatOffboardingNeedsAttentionSummary(attentionItems),
      'I can retry after the issue is fixed.',
    ].join('\n');
  }

  return [
    lifecycleCase === 'preboarding_cancellation'
      ? `Done, I cancelled onboarding for ${name}.`
      : `Done, ${name} is offboarded.`,
    '',
    lifecycleCase === 'preboarding_cancellation'
      ? formatPreboardingCancellationCompletedSummary(revokeItems)
      : formatOffboardingCompletedSummary(revokeItems),
    `Their work email was ${workEmail}.`,
  ].join('\n');
}

export function buildAutoProcessOffboardingResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const finalStatus = getRecordProperty(result, 'finalStatus');
  const finalized = getBooleanProperty(result, 'finalized') === true;

  if (finalStatus && finalized) {
    return buildFinalizeOffboardingResponse(finalStatus);
  }

  const employee = getRecordProperty(result, 'employee');
  if (!employee) {
    return undefined;
  }

  const name = getDisplayValue(getStringProperty(employee, 'fullName'));
  const workEmail = getDisplayValue(getStringProperty(employee, 'workEmail'));
  const statusResult = finalStatus ?? result;
  const revokeItems = getArrayProperty(statusResult, 'revokeItems');
  const summary = getRecordProperty(statusResult, 'summary');
  const failedCount = getNumberProperty(summary, 'failed') ?? 0;
  const pendingCount = getNumberProperty(summary, 'pending') ?? 0;
  const executionErrors = getArrayProperty(result, 'executionErrors');
  const needsAttention =
    executionErrors.length > 0 || failedCount > 0 || pendingCount > 0;
  const noChange = getStringProperty(result, 'nextAction') === 'no_change';

  if (noChange) {
    return [
      `No change, ${name} is already offboarded.`,
      '',
      `Their work email was ${workEmail}.`,
      "I didn't revoke anything.",
    ].join('\n');
  }

  const completedItems = revokeItems.filter(isCompletedOffboardingRevokeItem);
  const attentionItems = revokeItems.filter(
    (item) => !isCompletedOffboardingRevokeItem(item),
  );

  return [
    needsAttention
      ? `I started offboarding ${name}, but ${formatOffboardingAttentionSubject(attentionItems)} still needs attention.`
      : `Done, ${name} is offboarded.`,
    '',
    completedItems.length > 0
      ? formatOffboardingCompletedSummary(completedItems)
      : 'No revoke tasks have completed yet.',
    `Their work email is ${workEmail}.`,
    '',
    needsAttention
      ? formatOffboardingNeedsAttentionSummary(attentionItems)
      : 'No remaining revoke work is pending.',
  ].join('\n');
}

export function buildAutoProcessOffboardingFromSlackMessageResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const kind = getStringProperty(result, 'kind');

  if (kind === 'offboarding_alert_processed') {
    const processedResult = getRecordProperty(result, 'result');
    return buildAutoProcessOffboardingResponse(processedResult);
  }

  const parsed = getRecordProperty(result, 'parsed');
  const fields = getRecordProperty(parsed, 'fields');
  const workEmail = getDisplayValue(getStringProperty(fields, 'workEmail'));
  const name = getDisplayValue(getStringProperty(fields, 'name'));
  const missingFields = getArrayProperty(parsed, 'missingFields')
    .map((value) => String(value))
    .filter(Boolean);
  const parseErrors = getArrayProperty(parsed, 'parseErrors')
    .map((value) => String(value))
    .filter(Boolean);

  if (kind === 'offboarding_alert_validation_error') {
    return [
      "I couldn't process this Offboarding Alert yet.",
      '',
      ...(missingFields.length > 0
        ? [`Missing: ${missingFields.join(', ')}`]
        : []),
      ...(parseErrors.length > 0 ? parseErrors : []),
      '',
      'Please resend it in this format:',
      'Offboarding Alert',
      'Name: Riya Sharma',
      'Work Email: riya.sharma@caw.tech',
      'Last Working Day: 2026-07-31',
    ].join('\n');
  }

  if (kind === 'offboarding_alert_resolution_error') {
    return [
      `I couldn't find an employee record for ${workEmail}.`,
      '',
      "Please resend the Offboarding Alert with the employee's company work email.",
    ].join('\n');
  }

  if (kind === 'offboarding_alert_name_mismatch') {
    const resolution = getRecordProperty(result, 'resolution');
    const employee = getRecordProperty(resolution, 'employee');

    return [
      'I found the work email, but the name does not match the employee record.',
      '',
      `Alert name: ${name}`,
      `Employee record: ${getDisplayValue(getStringProperty(employee, 'fullName'))}`,
      `Work email: ${workEmail}`,
      '',
      'Please resend the Offboarding Alert with the corrected name or work email.',
    ].join('\n');
  }

  return undefined;
}

export function buildSearchAccessGrantsResponse(
  result: unknown,
  input: {
    employeeQuery?: string;
    systemKey?: string;
    resourceKey?: string;
    status?: string;
    mode?: 'active' | 'inactive' | 'history';
  } = {},
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const grants = getArrayProperty(result, 'grants');
  const isInactiveSlackQuery =
    input.systemKey === 'slack' &&
    (input.mode === 'inactive' || input.status === 'revoked');

  if (grants.length === 0) {
    return [
      isInactiveSlackQuery ? '*Inactive Slack access*' : '*Access grants*',
      '',
      isInactiveSlackQuery
        ? 'Employees found: None'
        : 'No matching access grants found.',
    ].join('\n');
  }

  if (isInactiveSlackQuery) {
    return [
      '*Inactive Slack access*',
      '',
      '*Employees found:*',
      ...formatInactiveSlackAccessLines(grants),
    ].join('\n');
  }

  return [
    input.mode === 'history' ? '*Access history*' : '*Access grants*',
    '',
    '*Grants found:*',
    ...formatAccessGrantLines(grants),
  ].join('\n');
}

export function buildAccessDetailReportResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const reportType = getStringProperty(result, 'reportType');
  const employees = getArrayProperty(result, 'employees');

  if (employees.length === 0) {
    return [
      '*Access detail report*',
      '',
      'No employee found for that query.',
    ].join('\n');
  }

  return [
    `*${formatReportTitle(reportType)}*`,
    '',
    '*Employees*',
    ...employees.map(formatDetailEmployeeLine),
    '',
    '*Access requests*',
    ...formatDetailAccessRequestLines(
      getArrayProperty(result, 'accessRequests'),
    ),
    '',
    '*Approvals*',
    ...formatDetailApprovalLines(getArrayProperty(result, 'approvals')),
    '',
    '*Access tasks*',
    ...formatDetailAccessTaskLines(getArrayProperty(result, 'accessTasks')),
    '',
    '*Access grants*',
    ...formatDetailAccessGrantLines(getArrayProperty(result, 'accessGrants')),
    '',
    '*Offboarding*',
    ...formatDetailOffboardingLines(
      getArrayProperty(result, 'offboardingIntakes'),
      getArrayProperty(result, 'offboardingApprovals'),
    ),
    '',
    '*Audit events*',
    ...formatDetailAuditEventLines(getArrayProperty(result, 'auditEvents')),
  ].join('\n');
}

export function buildConfigHealthResponse(result: unknown): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const sections = getArrayProperty(result, 'sections');

  return [
    '*Config health*',
    '',
    `Google Workspace: ${formatBooleanHealth(getBooleanProperty(result, 'GOOGLE_WORKSPACE_ENABLED'))}`,
    `Slack connector: ${formatBooleanHealth(getBooleanProperty(result, 'SLACK_CONNECTOR_ENABLED'))}`,
    `Email: ${formatBooleanHealth(getBooleanProperty(result, 'EMAIL_ENABLED'))}`,
    `Approval policy: ${formatBooleanHealth(getBooleanProperty(result, 'APPROVAL_POLICY_ENABLED'))}`,
    '',
    '*Required config*',
    ...formatConfigHealthSections(sections),
  ].join('\n');
}

export function buildConnectorHealthResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const connectors = getArrayProperty(result, 'connectors');

  return [
    '*Connector health*',
    '',
    ...formatConnectorHealthLines(connectors),
  ].join('\n');
}

export function buildRecentFailedAccessTasksResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const tasks = getArrayProperty(result, 'failedAccessTasks');

  return [
    '*Recent failed access tasks*',
    '',
    ...(tasks.length > 0 ? formatDiagnosticsTaskLines(tasks) : ['None']),
  ].join('\n');
}

export function buildTaskStatusDiagnosticsResponse(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const tasks = getArrayProperty(result, 'tasks');

  return [
    '*Task status*',
    '',
    ...(tasks.length > 0
      ? formatDiagnosticsTaskLines(tasks)
      : ['No access tasks found.']),
  ].join('\n');
}

function toErrorResult(message: string): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
    isError: true,
  };
}

function toSafeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return 'IT Ops tool call failed.';
}

function isItOpsApiNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('IT Ops API request failed (404):')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRecordProperty(
  value: unknown,
  property: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const propertyValue = value[property];
  return isRecord(propertyValue) ? propertyValue : undefined;
}

function getStringProperty(
  value: unknown,
  property: string,
): string | undefined {
  if (typeof value !== 'object' || value === null || !(property in value)) {
    return undefined;
  }

  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === 'string' ? propertyValue : undefined;
}

function getNestedStringProperty(
  value: unknown,
  parent: string,
  property: string,
): string | undefined {
  if (typeof value !== 'object' || value === null || !(parent in value)) {
    return undefined;
  }

  return getStringProperty(
    (value as Record<string, unknown>)[parent],
    property,
  );
}

function getFirstNestedArrayStringProperty(
  value: unknown,
  parent: string,
  property: string,
): string | undefined {
  if (typeof value !== 'object' || value === null || !(parent in value)) {
    return undefined;
  }

  const parentValue = (value as Record<string, unknown>)[parent];

  if (!Array.isArray(parentValue) || parentValue.length === 0) {
    return undefined;
  }

  return getStringProperty(parentValue[0], property);
}

function getBooleanProperty(
  value: unknown,
  property: string,
): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const propertyValue = value[property];
  return typeof propertyValue === 'boolean' ? propertyValue : undefined;
}

function getNumberProperty(
  value: unknown,
  property: string,
): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const propertyValue = value[property];
  return typeof propertyValue === 'number' ? propertyValue : undefined;
}

function getArrayProperty(value: unknown, property: string): unknown[] {
  if (!isRecord(value)) {
    return [];
  }

  const propertyValue = value[property];
  return Array.isArray(propertyValue) ? propertyValue : [];
}

function getStringArrayProperty(value: unknown, property: string): string[] {
  return getArrayProperty(value, property).filter(
    (item): item is string =>
      typeof item === 'string' && item.trim().length > 0,
  );
}

function getDisplayValue(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : 'Not provided';
}

function getUnknownValue(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : 'Unknown';
}

function formatCatalogKey(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    return 'Unknown';
  }

  return normalized
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function formatEmployeeStatus(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    return 'Not provided';
  }

  return normalized
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function formatBooleanHealth(value: boolean | undefined): string {
  if (value === true) {
    return 'Enabled';
  }

  if (value === false) {
    return 'Disabled';
  }

  return 'Unknown';
}

function formatConfigHealthSections(sections: unknown[]): string[] {
  if (sections.length === 0) {
    return ['None'];
  }

  return sections.map((section) => {
    const name = getDisplayValue(getStringProperty(section, 'name'));
    const configItems = getArrayProperty(section, 'requiredConfig');
    const missing = configItems
      .filter((item) => getStringProperty(item, 'status') === 'missing')
      .map((item) => getDisplayValue(getStringProperty(item, 'key')));

    return missing.length > 0
      ? `- ${name}: Missing ${missing.join(', ')}`
      : `- ${name}: Ready`;
  });
}

function formatConnectorHealthLines(connectors: unknown[]): string[] {
  if (connectors.length === 0) {
    return ['None'];
  }

  return connectors.map((connector) => {
    const name = getDisplayValue(getStringProperty(connector, 'name'));
    const status = formatEmployeeStatus(getStringProperty(connector, 'status'));
    const mode = getStringProperty(connector, 'mode');
    const missing = getStringArrayProperty(connector, 'missingConfig');
    const suffix = missing.length > 0 ? ` - missing ${missing.join(', ')}` : '';
    const modeText = mode ? ` (${mode})` : '';

    return `- ${name}${modeText}: ${status}${suffix}`;
  });
}

function formatDiagnosticsTaskLines(tasks: unknown[]): string[] {
  return tasks.map((task) => {
    const employeeName = getDisplayValue(
      getStringProperty(task, 'employeeName'),
    );
    const employeeWorkEmail = getDisplayValue(
      getStringProperty(task, 'employeeWorkEmail'),
    );
    const operation = formatEmployeeStatus(
      getStringProperty(task, 'operation'),
    );
    const status = formatEmployeeStatus(getStringProperty(task, 'status'));
    const system = getDisplayValue(getStringProperty(task, 'system'));
    const resource = getDisplayValue(getStringProperty(task, 'resource'));
    const errorSummary = getStringProperty(task, 'errorSummary');
    const errorText = errorSummary ? ` - ${errorSummary}` : '';
    const target = formatDiagnosticsTaskTarget({ operation, system, resource });

    return `- ${employeeName} - ${employeeWorkEmail} - ${target}: ${status}${errorText}`;
  });
}

function formatDiagnosticsTaskTarget(input: {
  operation: string;
  system: string;
  resource: string;
}): string {
  const system = input.system === 'Unknown' ? '' : input.system;
  const resource = input.resource === 'Unknown' ? '' : input.resource;
  const resourceLower = resource.toLowerCase();
  const systemLower = system.toLowerCase();
  const baseTarget =
    system && resource && resourceLower.startsWith(systemLower)
      ? resource
      : [system, resource].filter(Boolean).join(' ');
  const operationSuffix =
    input.operation.toLowerCase() === 'revoke' ? ' revoke' : '';

  return `${baseTarget || 'Access task'}${operationSuffix}`;
}

function titleForCreateOffboardingLifecycle(value: string | undefined): string {
  if (value === 'preboarding_cancellation') {
    return 'Preboarding cancellation intake created';
  }

  return 'Offboarding intake created';
}

function getResolutionActionLabel(purpose: string | undefined): string {
  if (purpose === 'offboarding') {
    return 'offboard';
  }

  if (purpose === 'mutate') {
    return 'update';
  }

  return 'check';
}

function formatResolvedEmployeeSummary(value: unknown): string {
  const fullName = getDisplayValue(getStringProperty(value, 'fullName'));
  const workEmail =
    getStringProperty(value, 'workEmail')?.trim() || 'No company email';
  const status = getDisplayValue(getStringProperty(value, 'status'));
  const designation = getStringProperty(value, 'designation');
  const department = getStringProperty(value, 'department');
  const title = getDisplayValue(designation ?? department);

  return `${fullName} - ${workEmail} - ${status} - ${title}`;
}

function formatEmployeeListLine(value: unknown, index: number): string {
  const fullName = getDisplayValue(getStringProperty(value, 'fullName'));
  const workEmail =
    getStringProperty(value, 'workEmail')?.trim() || 'No company email';
  const designation = getUnknownValue(getStringProperty(value, 'designation'));
  const status = formatEmployeeStatus(getStringProperty(value, 'status'));
  const startDate = getStringProperty(value, 'startDate');
  const startText = startDate ? ` - starts ${startDate}` : '';

  return `${index + 1}. ${fullName}\nWork email: ${workEmail}\nDesignation: ${designation}\nStatus: ${status}${startText}`;
}

function formatEmploymentType(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();

  if (normalized === 'fte') {
    return 'FTE';
  }

  if (normalized === 'contractor') {
    return 'Contractor';
  }

  return getDisplayValue(value);
}

function formatOnboardingIntakeListLine(value: unknown): string {
  const name = getDisplayValue(getStringProperty(value, 'name'));
  const startDate = getDisplayValue(getStringProperty(value, 'doj'));
  const designation = getDisplayValue(getStringProperty(value, 'designation'));
  const status = formatOnboardingWorkflowStatus(
    getStringProperty(value, 'status'),
  );

  return `- ${name} - ${designation} - start ${startDate} - ${status}`;
}

function formatPendingOnboardingSetupLine(value: unknown): string {
  const intake = getRecordProperty(value, 'onboardingIntake');
  const employee = getRecordProperty(value, 'employee');
  const name = getDisplayValue(
    getStringProperty(intake, 'name') ??
      getStringProperty(employee, 'fullName'),
  );
  const startDate = getDisplayValue(getStringProperty(intake, 'doj'));
  const designation = getDisplayValue(getStringProperty(intake, 'designation'));
  const workEmail = getStringProperty(employee, 'workEmail');
  const emailText = workEmail ? ` - ${workEmail}` : '';
  const pending = getStringArrayProperty(value, 'pendingCriticalSetup');
  const pendingText =
    pending.length > 0 ? pending.join(', ') : 'critical setup';

  return `- ${name}${emailText} - ${designation} - start ${startDate} - pending ${pendingText}`;
}

function formatOnboardingWorkQueueLine(value: unknown): string {
  const intake = getRecordProperty(value, 'onboardingIntake');
  const employee = getRecordProperty(value, 'employee');
  const name = getDisplayValue(
    getStringProperty(intake, 'name') ??
      getStringProperty(employee, 'fullName'),
  );
  const workEmail = getStringProperty(employee, 'workEmail');
  const emailText = workEmail ? ` - ${workEmail}` : '';
  const designation = getDisplayValue(getStringProperty(intake, 'designation'));
  const startDate = getDisplayValue(getStringProperty(intake, 'doj'));
  const category = getStringProperty(value, 'category');
  const validationErrors = getStringArrayProperty(value, 'validationErrors');
  const statusText =
    category === 'ready_to_finalize'
      ? 'setup complete, ready to finalize'
      : category === 'needs_correction'
        ? `needs correction${validationErrors.length > 0 ? ` - ${validationErrors[0]}` : ''}`
        : category === 'waiting_approval'
          ? 'waiting for approval'
          : category === 'blocked'
            ? 'blocked'
            : 'setup pending';

  return `- ${name}${emailText} - ${designation} - start ${startDate} - ${statusText}`;
}

function formatOnboardingWorkflowStatus(value: string | undefined): string {
  switch (value) {
    case 'validation_failed':
      return 'Needs correction';
    case 'waiting_for_review':
    case 'received':
      return 'Waiting for admin review';
    case 'approved':
    case 'ready_for_provisioning':
      return 'Approved, waiting for setup';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
    case 'superseded':
      return 'Superseded';
    case 'rejected':
      return 'Rejected';
    default:
      return formatEmployeeStatus(value);
  }
}

function formatSlackChannels(values: unknown[]): string {
  const channels = values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .map(formatSlackChannelDisplayName);

  return channels.length > 0 ? channels.join(', ') : 'None';
}

function formatSlackChannelDisplayName(value: string): string {
  const normalized = value.trim().replace(/^#+/u, '');

  if (!normalized) {
    return 'selected Slack channel';
  }

  if (/^[CG][A-Z0-9]{8,}$/u.test(normalized)) {
    return 'selected Slack channel';
  }

  return `#${normalized}`;
}

function formatOnboardingSetupStatusLines(values: unknown[]): string[] {
  const lines = values.map(
    (value) =>
      `- ${formatOnboardingSetupLabel(value)} - ${formatOnboardingSetupStatus(value)}`,
  );

  return lines.length > 0 ? lines : ['None'];
}

function formatOnboardingSetupNeedsAttentionLines(values: unknown[]): string[] {
  const lines = values.map((value) => {
    const errorMessage = getStringProperty(value, 'taskErrorMessage');
    const suffix = errorMessage
      ? `: ${sanitizeTaskErrorSummary(errorMessage)}`
      : '';

    return `- ${formatOnboardingSetupLabel(value)} - ${formatOnboardingSetupStatus(value)}${suffix}`;
  });

  return lines.length > 0
    ? lines
    : [
        'No failed setup item was returned. Check onboarding status before retrying.',
      ];
}

function formatOnboardingSetupCompletedLines(values: unknown[]): string[] {
  const completed = values.map(
    (value) =>
      `- ${formatOnboardingSetupLabel(value)} - ${formatOnboardingSetupCompletedOutcome(value)}`,
  );

  return completed.length > 0 ? completed : ['None'];
}

function formatOnboardingCompletedSummary(values: unknown[]): string {
  const completedKeys = new Set(
    values.map(getOnboardingSetupKey).filter(Boolean),
  );
  const googleDone = completedKeys.has('google_workspace:company_email');
  const slackDone = completedKeys.has('slack:workspace_membership');

  if (googleDone && slackDone) {
    return 'I created the company email and sent the Slack workspace invite.';
  }

  if (googleDone) {
    return 'I created the company email.';
  }

  if (slackDone) {
    return 'I sent the Slack workspace invite.';
  }

  return 'I completed the required onboarding setup.';
}

function formatOnboardingSetupIntro(
  name: string,
  options: {
    created?: boolean;
    lifecycleAuto?: boolean;
  },
): string {
  if (options.lifecycleAuto && options.created === false) {
    return `I found the existing onboarding for ${name} and retried the setup, but Slack still needs attention.`;
  }

  if (options.lifecycleAuto) {
    return `I started onboarding ${name}, but Slack still needs attention.`;
  }

  return `I retried onboarding setup for ${name}, but Slack still needs attention.`;
}

function formatOnboardingPartialSetupSummary(
  completedItems: unknown[],
  pendingItems: unknown[],
): string {
  const completedKeys = new Set(
    completedItems.map(getOnboardingSetupKey).filter(Boolean),
  );
  const pendingKeys = new Set(
    pendingItems.map(getOnboardingSetupKey).filter(Boolean),
  );
  const googleDone = completedKeys.has('google_workspace:company_email');
  const slackPending = pendingKeys.has('slack:workspace_membership');

  if (googleDone && slackPending) {
    return 'I created the company email. The Slack workspace invite is still pending.';
  }

  if (googleDone) {
    return 'I created the company email. The remaining setup still needs to finish.';
  }

  if (slackPending) {
    return 'The Slack workspace invite is still pending.';
  }

  return 'The required onboarding setup is still in progress.';
}

function formatOnboardingNeedsAttentionSummary(
  completedItems: unknown[],
  failedItems: unknown[],
): string {
  const completedKeys = new Set(
    completedItems.map(getOnboardingSetupKey).filter(Boolean),
  );
  const failedKeys = new Set(
    failedItems.map(getOnboardingSetupKey).filter(Boolean),
  );
  const googleDone = completedKeys.has('google_workspace:company_email');
  const slackFailed = failedKeys.has('slack:workspace_membership');

  if (googleDone && slackFailed) {
    return 'Google Workspace is done. Slack invite still failed, so the employee is not active yet.';
  }

  if (slackFailed) {
    return 'Slack invite still failed, so onboarding is not complete yet and the employee is not active.';
  }

  if (googleDone) {
    return 'Google Workspace is done. The remaining setup still needs attention before the employee can be active.';
  }

  return 'Onboarding is not complete yet, and the employee is not active.';
}

function formatSlackChannelRequestLines(
  requestedSlackChannels: string,
): string[] {
  if (requestedSlackChannels === 'None') {
    return [];
  }

  return [
    formatSlackChannelNotAddedSentence(requestedSlackChannels),
    'I need the Slack workspace invite to be completed before channel access can start.',
  ];
}

function formatSlackChannelAcceptedInviteFollowUp(
  requestedSlackChannels: string,
): string[] {
  if (requestedSlackChannels === 'None') {
    return [];
  }

  return [
    '',
    formatSlackChannelNotAddedSentence(requestedSlackChannels),
    requestedSlackChannels.includes(',')
      ? 'Once they accept the Slack invite and join the workspace, I can start those channel requests.'
      : 'Once they accept the Slack invite and join the workspace, I can start that channel request.',
  ];
}

function formatSlackChannelPendingInviteFollowUp(
  requestedSlackChannels: string,
): string[] {
  if (requestedSlackChannels === 'None') {
    return [];
  }

  return [
    '',
    formatSlackChannelNotAddedSentence(requestedSlackChannels),
    'I can start that after the Slack invite is completed and they join the workspace.',
  ];
}

function formatSlackChannelNotAddedSentence(
  requestedSlackChannels: string,
): string {
  const target =
    requestedSlackChannels === 'selected Slack channel'
      ? 'the selected Slack channel'
      : requestedSlackChannels;

  return `I haven't added them to ${target} yet.`;
}

function getOnboardingSetupKey(value: unknown): string | null {
  const system = getRecordProperty(value, 'system');
  const resource = getRecordProperty(value, 'resource');
  const systemKey = getStringProperty(system, 'key')?.trim().toLowerCase();
  const resourceKey = getStringProperty(resource, 'key')?.trim().toLowerCase();

  return systemKey && resourceKey ? `${systemKey}:${resourceKey}` : null;
}

function formatOnboardingSetupLabel(value: unknown): string {
  const system = getRecordProperty(value, 'system');
  const resource = getRecordProperty(value, 'resource');
  const systemKey = getStringProperty(system, 'key')?.trim().toLowerCase();
  const systemName = getDisplayValue(
    getStringProperty(system, 'name') ?? getStringProperty(system, 'key'),
  );
  const resourceKey = getStringProperty(resource, 'key')?.trim().toLowerCase();
  const resourceName = getDisplayValue(
    getStringProperty(resource, 'name') ?? getStringProperty(resource, 'key'),
  );
  const resourceType = getStringProperty(resource, 'resourceType')
    ?.trim()
    .toLowerCase();

  if (systemKey === 'google_workspace' && resourceKey === 'company_email') {
    return 'Google Workspace Company Email';
  }

  if (systemKey === 'slack' && resourceKey === 'workspace_membership') {
    return 'Slack Workspace Membership';
  }

  if (systemKey === 'slack' && resourceType === 'channel') {
    return `Slack channel ${resourceName.startsWith('#') ? resourceName : `#${resourceName}`}`;
  }

  return `${systemName} ${resourceName}`;
}

function formatOnboardingSetupCompletedOutcome(value: unknown): string {
  const system = getRecordProperty(value, 'system');
  const resource = getRecordProperty(value, 'resource');
  const systemKey = getStringProperty(system, 'key')?.trim().toLowerCase();
  const resourceKey = getStringProperty(resource, 'key')?.trim().toLowerCase();

  if (systemKey === 'slack' && resourceKey === 'workspace_membership') {
    return 'invite sent';
  }

  if (systemKey === 'google_workspace' && resourceKey === 'company_email') {
    return 'created';
  }

  return 'completed';
}

function formatOnboardingSetupStatus(value: unknown): string {
  const taskStatus = getStringProperty(value, 'taskStatus')
    ?.trim()
    .toLowerCase();
  const grantStatus = getStringProperty(value, 'grantStatus')
    ?.trim()
    .toLowerCase();

  if (taskStatus === 'completed' && grantStatus === 'active') {
    return 'Done';
  }

  if (taskStatus === 'failed') {
    return 'Failed';
  }

  if (taskStatus === 'pending_dependency') {
    return 'Waiting on dependency';
  }

  if (taskStatus === 'pending_manual') {
    return 'Manual action required';
  }

  return 'Waiting';
}

function formatOnboardingPendingSummary(values: unknown[]): string {
  const hasSlackWorkspace = values.some((value) => {
    const system = getRecordProperty(value, 'system');
    const resource = getRecordProperty(value, 'resource');
    const systemKey = getStringProperty(system, 'key')?.trim().toLowerCase();
    const resourceKey = getStringProperty(resource, 'key')
      ?.trim()
      .toLowerCase();

    return systemKey === 'slack' && resourceKey === 'workspace_membership';
  });

  if (hasSlackWorkspace) {
    return 'Slack invite is still pending, so onboarding is not complete yet and the employee is not active.';
  }

  return 'Onboarding is not complete yet. The pending critical setup above still needs attention.';
}

function isCompletedOnboardingSetupItem(value: unknown): boolean {
  return (
    getStringProperty(value, 'taskStatus') === 'completed' &&
    getStringProperty(value, 'grantStatus') === 'active'
  );
}

function isFailedOnboardingSetupItem(value: unknown): boolean {
  return (
    getStringProperty(value, 'taskStatus') === 'failed' ||
    getStringProperty(value, 'requestStatus') === 'failed' ||
    getStringProperty(value, 'grantStatus') === 'failed'
  );
}

function isFollowUpOnboardingSetupItem(value: unknown): boolean {
  const system = getRecordProperty(value, 'system');
  const resource = getRecordProperty(value, 'resource');
  const systemKey = getStringProperty(system, 'key')?.trim().toLowerCase();
  const resourceType = getStringProperty(resource, 'resourceType')
    ?.trim()
    .toLowerCase();

  return systemKey === 'slack' && resourceType === 'channel';
}

function formatOffboardingActiveAccessLines(values: unknown[]): string[] {
  return values
    .map((value) => {
      const system = getRecordProperty(value, 'system');
      const resource = getRecordProperty(value, 'resource');
      const role = getRecordProperty(value, 'role');
      const systemName = getDisplayValue(
        getStringProperty(system, 'name') ?? getStringProperty(system, 'key'),
      );
      const resourceName = getDisplayValue(
        getStringProperty(resource, 'name') ??
          getStringProperty(resource, 'key'),
      );
      const roleName =
        getStringProperty(role, 'name') ?? getStringProperty(role, 'key');

      if (roleName?.trim()) {
        return `- ${systemName} / ${resourceName} / ${roleName.trim()}`;
      }

      return `- ${systemName} / ${resourceName}`;
    })
    .filter((line) => line !== '- Not provided / Not provided');
}

function formatFinalizedOffboardingRevokeLines(values: unknown[]): string[] {
  const lines = values
    .map((value) => {
      const resourceLabel = formatOffboardingResourceLabel(value);
      if (!resourceLabel) {
        return undefined;
      }

      return `- ${resourceLabel} - ${formatOffboardingOutcome(value)}`;
    })
    .filter((line): line is string => typeof line === 'string');

  return lines.length > 0 ? lines : ['None'];
}

function formatOffboardingRevokeReadyLines(values: unknown[]): string[] {
  const lines = values
    .map((value) => {
      const resourceLabel = formatOffboardingResourceLabel(value);
      if (!resourceLabel) {
        return undefined;
      }

      return `- ${resourceLabel}`;
    })
    .filter((line): line is string => typeof line === 'string');

  return lines.length > 0 ? lines : ['- No active access found'];
}

function formatOffboardingNeedsAttentionLines(values: unknown[]): string[] {
  const lines = values
    .filter((value) => !isCompletedOffboardingRevokeItem(value))
    .map((value) => {
      const resourceLabel =
        formatOffboardingResourceLabel(value) ?? 'Unknown access';
      const taskStatus = getDisplayValue(
        getStringProperty(value, 'taskStatus'),
      );

      return `- ${resourceLabel} - ${taskStatus}`;
    });

  return lines.length > 0 ? lines : ['None'];
}

function formatOffboardingResourceLabel(value: unknown): string | undefined {
  const system = getRecordProperty(value, 'system');
  const resource = getRecordProperty(value, 'resource');
  const systemName =
    getStringProperty(system, 'name') ?? getStringProperty(system, 'key');
  const resourceName =
    getStringProperty(resource, 'name') ?? getStringProperty(resource, 'key');

  if (!systemName?.trim() || !resourceName?.trim()) {
    return undefined;
  }

  return `${systemName.trim()} ${resourceName.trim()}`;
}

function formatOffboardingOutcome(value: unknown): string {
  const system = getRecordProperty(value, 'system');
  const resource = getRecordProperty(value, 'resource');
  const systemKey = getStringProperty(system, 'key')?.trim().toLowerCase();
  const resourceKey = getStringProperty(resource, 'key')?.trim().toLowerCase();
  const resourceType = getStringProperty(resource, 'resourceType')
    ?.trim()
    .toLowerCase();
  const taskStatus = getStringProperty(value, 'taskStatus')
    ?.trim()
    .toLowerCase();

  if (systemKey === 'google_workspace' && resourceKey === 'company_email') {
    return 'suspended';
  }

  if (systemKey === 'slack' && resourceKey === 'workspace_membership') {
    return 'deactivated';
  }

  if (
    systemKey === 'slack' &&
    resourceType === 'channel' &&
    taskStatus === 'skipped'
  ) {
    return 'revoked by workspace deactivation';
  }

  if (systemKey === 'slack' && resourceType === 'channel') {
    return 'revoked';
  }

  return 'revoked';
}

function formatOffboardingCompletedSummary(values: unknown[]): string {
  if (values.length === 0) {
    return 'There was no remaining access to revoke.';
  }

  const hasGoogleCompanyEmail = values.some(isGoogleWorkspaceCompanyEmailItem);
  const hasSlackWorkspace = values.some(isSlackWorkspaceMembershipItem);
  const otherCompletedCount = values.filter(
    (value) =>
      !isGoogleWorkspaceCompanyEmailItem(value) &&
      !isSlackWorkspaceMembershipItem(value),
  ).length;

  if (hasGoogleCompanyEmail && hasSlackWorkspace) {
    return otherCompletedCount > 0
      ? 'I suspended their company email, deactivated their Slack workspace access, and removed the remaining access covered by this offboarding.'
      : 'I suspended their company email and deactivated their Slack workspace access.';
  }

  if (hasGoogleCompanyEmail) {
    return otherCompletedCount > 0
      ? 'I suspended their company email and removed the remaining access covered by this offboarding.'
      : 'I suspended their company email.';
  }

  if (hasSlackWorkspace) {
    return otherCompletedCount > 0
      ? 'I deactivated their Slack workspace access and removed the remaining access covered by this offboarding.'
      : 'I deactivated their Slack workspace access.';
  }

  return 'I revoked the access covered by this offboarding.';
}

function formatPreboardingCancellationCompletedSummary(
  values: unknown[],
): string {
  if (values.length === 0) {
    return 'There was no provisioned access to revoke yet.';
  }

  return 'I revoked the access that had already been provisioned.';
}

function formatOffboardingNeedsAttentionSummary(values: unknown[]): string {
  const lines = formatOffboardingNeedsAttentionLines(values);

  if (lines.length === 1 && lines[0] === 'None') {
    return 'No remaining revoke work is pending.';
  }

  return ['Still needs attention:', ...lines].join('\n');
}

function formatOffboardingAttentionSubject(values: unknown[]): string {
  if (values.some(isSlackWorkspaceMembershipItem)) {
    return 'Slack workspace deactivation';
  }

  if (values.some(isGoogleWorkspaceCompanyEmailItem)) {
    return 'company email suspension';
  }

  const firstLabel = formatOffboardingResourceLabel(values[0]);
  return firstLabel ?? 'some access';
}

function isGoogleWorkspaceCompanyEmailItem(value: unknown): boolean {
  const system = getRecordProperty(value, 'system');
  const resource = getRecordProperty(value, 'resource');

  return (
    getStringProperty(system, 'key')?.trim().toLowerCase() ===
      'google_workspace' &&
    getStringProperty(resource, 'key')?.trim().toLowerCase() === 'company_email'
  );
}

function isSlackWorkspaceMembershipItem(value: unknown): boolean {
  const system = getRecordProperty(value, 'system');
  const resource = getRecordProperty(value, 'resource');

  return (
    getStringProperty(system, 'key')?.trim().toLowerCase() === 'slack' &&
    getStringProperty(resource, 'key')?.trim().toLowerCase() ===
      'workspace_membership' &&
    getStringProperty(resource, 'resourceType')?.trim().toLowerCase() ===
      'workspace'
  );
}

function isCompletedOffboardingRevokeItem(value: unknown): boolean {
  const taskStatus = getStringProperty(value, 'taskStatus')
    ?.trim()
    .toLowerCase();
  return taskStatus === 'completed' || taskStatus === 'skipped';
}

function formatInactiveSlackAccessLines(values: unknown[]): string[] {
  return values.flatMap((value) => {
    const employee = getRecordProperty(value, 'employee');
    const fullName = getDisplayValue(getStringProperty(employee, 'fullName'));
    const workEmail = getDisplayValue(getStringProperty(employee, 'workEmail'));
    const rawEmployeeStatus = getStringProperty(employee, 'status');
    const employeeStatus = formatEmployeeStatus(rawEmployeeStatus);
    const resource = getRecordProperty(value, 'resource');
    const resourceName = getDisplayValue(
      getStringProperty(resource, 'name') ?? getStringProperty(resource, 'key'),
    );
    const grantStatus = formatEmployeeStatus(
      getStringProperty(value, 'status'),
    );
    const normalizedEmployeeStatus = rawEmployeeStatus?.trim().toLowerCase();
    const reason =
      getStringProperty(value, 'status') === 'revoked' &&
      (normalizedEmployeeStatus === 'offboarded' ||
        normalizedEmployeeStatus === 'offboarding')
        ? 'Revoked during offboarding'
        : grantStatus;

    return [
      `- ${fullName} - ${workEmail}`,
      `  Employee status: ${employeeStatus}`,
      `  Slack ${resourceName}: ${grantStatus}`,
      `  ${reason}`,
    ];
  });
}

function formatAccessGrantLines(values: unknown[]): string[] {
  return values.map((value) => {
    const employee = getRecordProperty(value, 'employee');
    const system = getRecordProperty(value, 'system');
    const resource = getRecordProperty(value, 'resource');
    const role = getRecordProperty(value, 'role');
    const fullName = getDisplayValue(getStringProperty(employee, 'fullName'));
    const workEmail = getDisplayValue(getStringProperty(employee, 'workEmail'));
    const systemName = getDisplayValue(
      getStringProperty(system, 'name') ?? getStringProperty(system, 'key'),
    );
    const resourceName = getDisplayValue(
      getStringProperty(resource, 'name') ?? getStringProperty(resource, 'key'),
    );
    const roleName = getDisplayValue(
      getStringProperty(role, 'name') ?? getStringProperty(role, 'key'),
    );
    const status = formatEmployeeStatus(getStringProperty(value, 'status'));

    return `- ${fullName} - ${workEmail} - ${systemName} ${resourceName} ${roleName} - ${status}`;
  });
}

function formatReportTitle(value: string | undefined): string {
  if (value === 'offboarding_audit') {
    return 'Offboarding audit';
  }

  if (value === 'access_history') {
    return 'Access history detail';
  }

  if (value === 'revoke_task_status') {
    return 'Revoke task status';
  }

  if (value === 'access_request_status') {
    return 'Access request status';
  }

  return 'Access detail report';
}

function formatDetailEmployeeLine(value: unknown): string {
  const name = getDisplayValue(getStringProperty(value, 'fullName'));
  const workEmail = getDisplayValue(getStringProperty(value, 'workEmail'));
  const status = formatEmployeeStatus(getStringProperty(value, 'status'));

  return `- ${name} - ${workEmail} - ${status}`;
}

function formatDetailAccessRequestLines(values: unknown[]): string[] {
  if (values.length === 0) {
    return ['None'];
  }

  return values.map((value) => {
    const system = getRecordProperty(value, 'system');
    const resource = getRecordProperty(value, 'resource');
    const role = getRecordProperty(value, 'role');
    const target = formatDetailTarget(system, resource, role);
    const id = getDisplayValue(getStringProperty(value, 'id'));
    const action = formatEmployeeStatus(getStringProperty(value, 'action'));
    const status = formatEmployeeStatus(getStringProperty(value, 'status'));
    const requestedBy = getDisplayValue(
      getStringProperty(value, 'requestedByExternalUserId'),
    );
    const createdAt = formatTimestamp(getStringProperty(value, 'createdAt'));

    return `- ${id} - ${action} ${target} - ${status} - requested by ${requestedBy} - ${createdAt}`;
  });
}

function formatDetailApprovalLines(values: unknown[]): string[] {
  if (values.length === 0) {
    return ['None'];
  }

  return values.map((value) => {
    const id = getDisplayValue(getStringProperty(value, 'id'));
    const accessRequestId = getDisplayValue(
      getStringProperty(value, 'accessRequestId'),
    );
    const decision = formatEmployeeStatus(getStringProperty(value, 'decision'));
    const approver = getDisplayValue(
      getStringProperty(value, 'approverExternalUserId'),
    );
    const createdAt = formatTimestamp(getStringProperty(value, 'createdAt'));

    return `- ${id} - request ${accessRequestId} - ${decision} by ${approver} - ${createdAt}`;
  });
}

function formatDetailAccessTaskLines(values: unknown[]): string[] {
  if (values.length === 0) {
    return ['None'];
  }

  return values.map((value) => {
    const id = getDisplayValue(getStringProperty(value, 'id'));
    const accessRequestId = getDisplayValue(
      getStringProperty(value, 'accessRequestId'),
    );
    const operation = formatEmployeeStatus(
      getStringProperty(value, 'operation'),
    );
    const status = formatEmployeeStatus(getStringProperty(value, 'status'));
    const connector = getDisplayValue(getStringProperty(value, 'connector'));
    const createdAt = formatTimestamp(getStringProperty(value, 'createdAt'));
    const connectorSummary = formatConnectorResultSummary(
      getRecordProperty(value, 'connectorResultSummary'),
    );
    const errorMessage = getStringProperty(value, 'errorMessage');
    const errorText = errorMessage?.trim()
      ? ` - error: ${errorMessage.trim()}`
      : '';

    return `- ${id} - request ${accessRequestId} - ${operation} - ${status} - ${connector} - ${createdAt} - ${connectorSummary}${errorText}`;
  });
}

function formatDetailAccessGrantLines(values: unknown[]): string[] {
  if (values.length === 0) {
    return ['None'];
  }

  return values.map((value) => {
    const system = getRecordProperty(value, 'system');
    const resource = getRecordProperty(value, 'resource');
    const role = getRecordProperty(value, 'role');
    const id = getDisplayValue(getStringProperty(value, 'id'));
    const status = formatEmployeeStatus(getStringProperty(value, 'status'));
    const grantedAt = formatTimestamp(getStringProperty(value, 'grantedAt'));
    const revokedAt = formatTimestamp(getStringProperty(value, 'revokedAt'));

    return `- ${id} - ${formatDetailTarget(system, resource, role)} - ${status} - granted ${grantedAt} - revoked ${revokedAt}`;
  });
}

function formatDetailOffboardingLines(
  intakes: unknown[],
  approvalsValue: unknown[],
): string[] {
  const lines = [];

  if (intakes.length === 0) {
    lines.push('None');
  } else {
    lines.push(
      ...intakes.map((value) => {
        const id = getDisplayValue(getStringProperty(value, 'id'));
        const status = formatEmployeeStatus(getStringProperty(value, 'status'));
        const requestedBy = getDisplayValue(
          getStringProperty(value, 'requestedByExternalUserId'),
        );
        const createdAt = formatTimestamp(
          getStringProperty(value, 'createdAt'),
        );
        const completedAt = formatTimestamp(
          getStringProperty(value, 'completedAt'),
        );

        return `- Intake ${id} - ${status} - requested by ${requestedBy} - created ${createdAt} - completed ${completedAt}`;
      }),
    );
  }

  if (approvalsValue.length > 0) {
    lines.push(
      ...approvalsValue.map((value) => {
        const id = getDisplayValue(getStringProperty(value, 'id'));
        const intakeId = getDisplayValue(
          getStringProperty(value, 'offboardingIntakeId'),
        );
        const decision = formatEmployeeStatus(
          getStringProperty(value, 'decision'),
        );
        const approver = getDisplayValue(
          getStringProperty(value, 'approverExternalUserId'),
        );
        const createdAt = formatTimestamp(
          getStringProperty(value, 'createdAt'),
        );

        return `- Approval ${id} - intake ${intakeId} - ${decision} by ${approver} - ${createdAt}`;
      }),
    );
  }

  return lines;
}

function formatDetailAuditEventLines(values: unknown[]): string[] {
  if (values.length === 0) {
    return ['None'];
  }

  return values.map((value) => {
    const id = getDisplayValue(getStringProperty(value, 'id'));
    const eventType = getDisplayValue(getStringProperty(value, 'eventType'));
    const entityType = getDisplayValue(getStringProperty(value, 'entityType'));
    const entityId = getDisplayValue(getStringProperty(value, 'entityId'));
    const actor = getDisplayValue(
      getStringProperty(value, 'actorExternalUserId'),
    );
    const createdAt = formatTimestamp(getStringProperty(value, 'createdAt'));

    return `- ${createdAt} - ${eventType} - ${entityType}:${entityId} - actor ${actor} - event ${id}`;
  });
}

function formatDetailTarget(
  system: unknown,
  resource: unknown,
  role: unknown,
): string {
  const systemName = getDisplayValue(
    getStringProperty(system, 'name') ?? getStringProperty(system, 'key'),
  );
  const resourceName = getDisplayValue(
    getStringProperty(resource, 'name') ?? getStringProperty(resource, 'key'),
  );
  const roleName = getDisplayValue(
    getStringProperty(role, 'name') ?? getStringProperty(role, 'key'),
  );

  return `${systemName} ${resourceName} ${roleName}`;
}

function formatConnectorResultSummary(
  value: Record<string, unknown> | undefined,
): string {
  if (!value || Object.keys(value).length === 0) {
    return 'connector result: none';
  }

  return `connector result: ${Object.entries(value)
    .map(([key, entry]) => `${key}=${String(entry)}`)
    .join(', ')}`;
}

function formatTimestamp(value: string | undefined): string {
  return value?.trim() || 'Not recorded';
}

function sanitizeTaskErrorSummary(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();

  if (normalized.length <= 180) {
    return normalized;
  }

  return `${normalized.slice(0, 177)}...`;
}

type OffboardingAlertFieldKey = 'name' | 'workEmail' | 'lastWorkingDay';

const offboardingAlertLabelPattern =
  /(^|\n|\r|\s)(Name|Work\s+Email|Last\s+Working\s+Day)\s*:\s*/giu;

function extractOffboardingRawFieldValues(
  rawText: string,
): Partial<Record<OffboardingAlertFieldKey, string>> {
  const matches = [...rawText.matchAll(offboardingAlertLabelPattern)];
  const values: Partial<Record<OffboardingAlertFieldKey, string>> = {};

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const label = match[2]!;
    const key = offboardingAlertKeyForLabel(label);
    const valueStart = match.index! + match[0].length;
    const nextMatch = matches[index + 1];
    const valueEnd = nextMatch?.index ?? rawText.length;
    values[key] = rawText.slice(valueStart, valueEnd);
  }

  return values;
}

function offboardingAlertKeyForLabel(label: string): OffboardingAlertFieldKey {
  const normalizedLabel = label.replace(/\s+/gu, ' ').trim().toLowerCase();

  if (normalizedLabel === 'name') {
    return 'name';
  }

  if (normalizedLabel === 'work email') {
    return 'workEmail';
  }

  return 'lastWorkingDay';
}

function normalizeOffboardingTextValue(
  value: string | undefined,
): string | null {
  const normalized = value?.replace(/\s+/gu, ' ').trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeOffboardingEmailValue(
  value: string | undefined,
): string | null {
  const normalized = normalizeOffboardingTextValue(value);
  if (!normalized) {
    return null;
  }

  const slackMailtoMatch = normalized.match(/<mailto:([^|>]+)(?:\|[^>]+)?>/iu);
  return (slackMailtoMatch?.[1] ?? normalized).trim().toLowerCase();
}

function offboardingAlertNameMatchesEmployee(
  alertName: string | null,
  employeeName: string | null | undefined,
): boolean {
  if (!alertName) {
    return true;
  }

  const alertTokens = tokenizeComparableName(alertName);
  const employeeTokens = tokenizeComparableName(employeeName ?? '');

  if (alertTokens.length === 0 || employeeTokens.length === 0) {
    return false;
  }

  if (alertTokens.join(' ') === employeeTokens.join(' ')) {
    return true;
  }

  const employeeTokenSet = new Set(employeeTokens);
  const overlapCount = alertTokens.filter((token) =>
    employeeTokenSet.has(token),
  ).length;
  const firstNameMatches = alertTokens[0] === employeeTokens[0];

  return firstNameMatches || overlapCount >= 2;
}

function tokenizeComparableName(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/giu, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
}

function formatOffboardingAlertNotes(input: {
  alertName: string | null;
  alertWorkEmail: string;
  workspaceId: string;
  channelId: string;
  messageTs: string;
  threadTs?: string | null;
}): string {
  return [
    'Offboarding Alert from Slack lifecycle channel.',
    input.alertName ? `Alert name: ${input.alertName}` : null,
    `Alert work email: ${input.alertWorkEmail}`,
    `Slack workspace: ${input.workspaceId}`,
    `Slack channel: ${input.channelId}`,
    `Slack message ts: ${input.messageTs}`,
    input.threadTs ? `Slack thread ts: ${input.threadTs}` : null,
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');
}

function normalizeOffboardingSlackInput(input: OffboardingSlackInput): {
  workspaceId: string;
  channelId: string;
  messageTs: string;
  threadTs?: string | null;
  senderSlackUserId?: string | null;
  senderExternalUserId?: string | null;
  rawText: string;
} {
  return normalizeOnboardingSlackInput(input);
}

function normalizeOnboardingSlackInput(input: {
  workspaceId?: string | null;
  channelId?: string | null;
  messageTs?: string | null;
  threadTs?: string | null;
  senderSlackUserId?: string | null;
  senderExternalUserId?: string | null;
  rawText: string;
}): {
  workspaceId: string;
  channelId: string;
  messageTs: string;
  threadTs?: string | null;
  senderSlackUserId?: string | null;
  senderExternalUserId?: string | null;
  rawText: string;
} {
  const rawText = input.rawText.trim();
  const messageHash = createHash('sha256')
    .update(rawText)
    .digest('hex')
    .slice(0, 32);
  const messageTs = trimToNull(input.messageTs) ?? `raw:${messageHash}`;
  const senderExternalUserId =
    trimToNull(input.senderExternalUserId) ??
    normalizeSlackActorId(trimToNull(input.senderSlackUserId)) ??
    'gantry:unknown';

  return {
    workspaceId: trimToNull(input.workspaceId) ?? 'gantry:unknown_workspace',
    channelId: trimToNull(input.channelId) ?? 'gantry:unknown_channel',
    messageTs,
    threadTs: trimToNull(input.threadTs) ?? messageTs,
    senderSlackUserId: trimToNull(input.senderSlackUserId),
    senderExternalUserId,
    rawText,
  };
}

function normalizeSlackActorId(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value.startsWith('slack:') ? value : `slack:${value}`;
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
