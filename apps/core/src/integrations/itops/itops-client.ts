import type {
  AccessRequest,
  AccessRequestDecision,
  AccessTask,
  AccessTaskExecutionResult,
  AccessDetailReport,
  AccessDetailReportInput,
  AccessGrantSearchResult,
  AutoProcessOffboardingResult,
  AutoProcessOnboardingFromSlackMessageResult,
  ConfigHealth,
  ConnectorHealth,
  CreateAccessRequestInput,
  CreateEmployeeInput,
  CreateOnboardingIntakeFromSlackMessageInput,
  CreateOnboardingIntakeFromSlackMessageResult,
  ContinueOnboardingSetupResult,
  DecideOnboardingIntakeInput,
  DecideOnboardingIntakeResult,
  DiagnosticsActorInput,
  DecideAccessRequestInput,
  EmailMessage,
  EmailMessageIdInput,
  Employee,
  EmployeeAccessSummary,
  EmployeeIdInput,
  ListEmployeesInput,
  ListEmployeesResult,
  CreateOffboardingIntakeInput,
  CreateOffboardingIntakeResult,
  DecideOffboardingIntakeInput,
  DecideOffboardingIntakeResult,
  FinalizeOffboardingResult,
  FinalizeOnboardingByEmployeeResult,
  FinalizeOnboardingResult,
  ListOnboardingIntakesInput,
  ListOnboardingIntakesResult,
  ListOnboardingWorkQueueResult,
  ListPendingOnboardingSetupsResult,
  OffboardingIntakeDetail,
  OffboardingIntakeIdInput,
  OnboardingIntakeStatusChangeResult,
  OnboardingCleanupTargetInput,
  OnboardingNaturalTargetInput,
  OffboardingStatusResult,
  OnboardingIntakeIdInput,
  OnboardingStatusResult,
  RequestGoogleWorkspaceEmailInput,
  RecentFailedAccessTasksDiagnostics,
  ResolveOnboardingIntakeInput,
  ResolveOnboardingIntakeResult,
  ResolveEmployeeInput,
  ResolveEmployeeResult,
  SearchAccessGrantsInput,
  SearchEmployeesInput,
  TaskStatusDiagnostics,
  TaskStatusDiagnosticsInput,
} from './itops-types.js';

export interface ItOpsClientConfig {
  itopsApiBaseUrl: string;
  itopsApiTimeoutMs: number;
  itopsApiRetryAttempts: number;
  itopsApiRetryDelayMs: number;
  itopsApiKey?: string;
}

type HttpMethod = 'GET' | 'POST';

export class ItOpsClient {
  constructor(private readonly bridgeConfig: ItOpsClientConfig) {}

  searchEmployees(input: SearchEmployeesInput): Promise<Employee[]> {
    return this.requestJson<ListEmployeesResult>({
      method: 'GET',
      path: '/employees',
      query: {
        query: input.query,
        status: 'all',
        pageSize: 20,
      },
    }).then((result) => result.employees);
  }

  resolveEmployee(input: ResolveEmployeeInput): Promise<ResolveEmployeeResult> {
    return this.requestJson<ResolveEmployeeResult>({
      method: 'POST',
      path: '/employees/resolve',
      body: input,
    });
  }

  listEmployees(input: ListEmployeesInput = {}): Promise<ListEmployeesResult> {
    return this.requestJson<ListEmployeesResult>({
      method: 'GET',
      path: '/employees',
      query: {
        status: input.status,
        page: input.page,
        pageSize: input.pageSize,
        query: input.query,
      },
    });
  }

  createEmployee(input: CreateEmployeeInput): Promise<Employee> {
    return this.requestJson<Employee>({
      method: 'POST',
      path: '/employees',
      body: input,
    });
  }

  getEmployee(input: EmployeeIdInput): Promise<Employee> {
    return this.requestJson<Employee>({
      method: 'GET',
      path: `/employees/${encodeURIComponent(input.employeeId)}`,
    });
  }

  requestGoogleWorkspaceEmail(
    input: RequestGoogleWorkspaceEmailInput,
  ): Promise<AccessRequest> {
    return this.requestJson<AccessRequest>({
      method: 'POST',
      path: '/access-requests',
      body: {
        employeeId: input.employeeId,
        systemKey: 'google_workspace',
        resourceKey: 'company_email',
        roleKey: 'user',
        action: 'grant',
        reason: input.reason,
        requestedByExternalUserId: input.requestedByExternalUserId,
        requestedFrom: 'gantry',
      },
    });
  }

  createAccessRequest(input: CreateAccessRequestInput): Promise<AccessRequest> {
    return this.requestJson<AccessRequest>({
      method: 'POST',
      path: '/access-requests',
      body: {
        employeeId: input.employeeId,
        systemKey: input.systemKey,
        resourceKey: input.resourceKey,
        roleKey: input.roleKey,
        action: input.action,
        reason: input.reason ?? null,
        requestedByExternalUserId: input.requestedByExternalUserId,
        requestedFrom: input.requestedFrom ?? 'gantry',
      },
    });
  }

  decideAccessRequest(
    input: DecideAccessRequestInput,
  ): Promise<AccessRequestDecision> {
    const {
      accessRequestId,
      decision,
      approverExternalUserId,
      comment,
      source,
      gantryConversationId,
      gantryRuntimeEventId,
    } = input;

    return this.requestJson<AccessRequestDecision>({
      method: 'POST',
      path: `/access-requests/${encodeURIComponent(accessRequestId)}/decision`,
      body: {
        decision,
        approverExternalUserId,
        comment,
        source,
        gantryConversationId,
        gantryRuntimeEventId,
      },
    });
  }

  listAccessRequestTasks(input: {
    accessRequestId: string;
  }): Promise<AccessTask[]> {
    return this.requestJson<AccessTask[]>({
      method: 'GET',
      path: `/access-requests/${encodeURIComponent(input.accessRequestId)}/tasks`,
    });
  }

  executeAccessTask(input: {
    accessTaskId: string;
  }): Promise<AccessTaskExecutionResult> {
    return this.requestJson<AccessTaskExecutionResult>(
      {
        method: 'POST',
        path: `/access-tasks/${encodeURIComponent(input.accessTaskId)}/execute`,
      },
      {
        retryOnTimeout: true,
      },
    );
  }

  getEmployeeAccess(input: EmployeeIdInput): Promise<EmployeeAccessSummary> {
    return this.requestJson<EmployeeAccessSummary>({
      method: 'GET',
      path: `/employees/${encodeURIComponent(input.employeeId)}/access`,
    });
  }

  searchAccessGrants(
    input: SearchAccessGrantsInput,
  ): Promise<AccessGrantSearchResult> {
    return this.requestJson<AccessGrantSearchResult>({
      method: 'GET',
      path: '/employees/access-grants/search',
      query: {
        employeeQuery: input.employeeQuery,
        systemKey: input.systemKey,
        resourceKey: input.resourceKey,
        status: input.status,
        mode: input.mode,
      },
    });
  }

  getAccessDetailReport(
    input: AccessDetailReportInput,
  ): Promise<AccessDetailReport> {
    return this.requestJson<AccessDetailReport>({
      method: 'GET',
      path: '/employees/access-detail-report',
      query: {
        employeeQuery: input.employeeQuery,
        reportType: input.reportType,
      },
    });
  }

  getConfigHealth(input: DiagnosticsActorInput): Promise<ConfigHealth> {
    return this.requestJson<ConfigHealth>({
      method: 'GET',
      path: '/diagnostics/config-health',
      query: {
        actorExternalUserId: input.actorExternalUserId,
      },
    });
  }

  getConnectorHealth(input: DiagnosticsActorInput): Promise<ConnectorHealth> {
    return this.requestJson<ConnectorHealth>({
      method: 'GET',
      path: '/diagnostics/connector-health',
      query: {
        actorExternalUserId: input.actorExternalUserId,
      },
    });
  }

  getRecentFailedAccessTasks(
    input: DiagnosticsActorInput,
  ): Promise<RecentFailedAccessTasksDiagnostics> {
    return this.requestJson<RecentFailedAccessTasksDiagnostics>({
      method: 'GET',
      path: '/diagnostics/recent-failed-access-tasks',
      query: {
        actorExternalUserId: input.actorExternalUserId,
      },
    });
  }

  getTaskStatusByEmployee(
    input: TaskStatusDiagnosticsInput,
  ): Promise<TaskStatusDiagnostics> {
    return this.requestJson<TaskStatusDiagnostics>({
      method: 'GET',
      path: '/diagnostics/task-status',
      query: {
        actorExternalUserId: input.actorExternalUserId,
        employeeQuery: input.employeeQuery,
      },
    });
  }

  listEmployeeEmails(input: EmployeeIdInput): Promise<EmailMessage[]> {
    return this.requestJson<EmailMessage[]>({
      method: 'GET',
      path: `/employees/${encodeURIComponent(input.employeeId)}/emails`,
    });
  }

  getEmailMessage(input: EmailMessageIdInput): Promise<EmailMessage> {
    return this.requestJson<EmailMessage>({
      method: 'GET',
      path: `/email-messages/${encodeURIComponent(input.emailMessageId)}`,
    });
  }

  createOnboardingIntakeFromSlackMessage(
    input: CreateOnboardingIntakeFromSlackMessageInput,
  ): Promise<CreateOnboardingIntakeFromSlackMessageResult> {
    return this.requestJson<CreateOnboardingIntakeFromSlackMessageResult>({
      method: 'POST',
      path: '/onboarding-intakes/slack',
      body: input,
    });
  }

  autoProcessOnboardingFromSlackMessage(
    input: CreateOnboardingIntakeFromSlackMessageInput,
  ): Promise<AutoProcessOnboardingFromSlackMessageResult> {
    return this.requestJson<AutoProcessOnboardingFromSlackMessageResult>(
      {
        method: 'POST',
        path: '/onboarding-intakes/slack/auto-process',
        body: input,
      },
      { retryOnTimeout: true },
    );
  }

  listOnboardingIntakes(
    input: ListOnboardingIntakesInput,
  ): Promise<ListOnboardingIntakesResult> {
    return this.requestJson<ListOnboardingIntakesResult>({
      method: 'GET',
      path: '/onboarding-intakes',
      query: {
        status: input.status,
        limit: input.limit,
      },
    });
  }

  listPendingOnboardingSetups(
    input: { limit?: number } = {},
  ): Promise<ListPendingOnboardingSetupsResult> {
    return this.requestJson<ListPendingOnboardingSetupsResult>({
      method: 'GET',
      path: '/onboarding-intakes/pending-setups',
      query: {
        limit: input.limit,
      },
    });
  }

  listOnboardingWorkQueue(
    input: { limit?: number } = {},
  ): Promise<ListOnboardingWorkQueueResult> {
    return this.requestJson<ListOnboardingWorkQueueResult>({
      method: 'GET',
      path: '/onboarding-intakes/work-queue',
      query: {
        limit: input.limit,
      },
    });
  }

  resolveOnboardingIntake(
    input: ResolveOnboardingIntakeInput,
  ): Promise<ResolveOnboardingIntakeResult> {
    return this.requestJson<ResolveOnboardingIntakeResult>({
      method: 'POST',
      path: '/onboarding-intakes/resolve',
      body: input,
    });
  }

  decideOnboardingIntake(
    input: DecideOnboardingIntakeInput,
  ): Promise<DecideOnboardingIntakeResult> {
    const {
      onboardingIntakeId,
      decision,
      approverExternalUserId,
      comment,
      source,
      gantryConversationId,
      gantryRuntimeEventId,
    } = input;

    return this.requestJson<DecideOnboardingIntakeResult>({
      method: 'POST',
      path: `/onboarding-intakes/${encodeURIComponent(onboardingIntakeId)}/decision`,
      body: {
        decision,
        approverExternalUserId,
        comment,
        source,
        gantryConversationId,
        gantryRuntimeEventId,
      },
    });
  }

  getOnboardingStatus(
    input: OnboardingIntakeIdInput,
  ): Promise<OnboardingStatusResult> {
    return this.requestJson<OnboardingStatusResult>({
      method: 'GET',
      path: `/onboarding-intakes/${encodeURIComponent(input.onboardingIntakeId)}/status`,
    });
  }

  finalizeOnboarding(
    input: OnboardingIntakeIdInput,
  ): Promise<FinalizeOnboardingResult> {
    return this.requestJson<FinalizeOnboardingResult>({
      method: 'POST',
      path: `/onboarding-intakes/${encodeURIComponent(input.onboardingIntakeId)}/finalize`,
    });
  }

  finalizeOnboardingByEmployee(
    input: OnboardingNaturalTargetInput,
  ): Promise<FinalizeOnboardingByEmployeeResult> {
    return this.requestJson<FinalizeOnboardingByEmployeeResult>({
      method: 'POST',
      path: '/onboarding-intakes/finalize-by-employee',
      body: input,
    });
  }

  cancelOnboardingIntake(
    input: OnboardingCleanupTargetInput,
  ): Promise<OnboardingIntakeStatusChangeResult> {
    return this.requestJson<OnboardingIntakeStatusChangeResult>({
      method: 'POST',
      path: '/onboarding-intakes/cancel',
      body: input,
    });
  }

  supersedeOnboardingIntake(
    input: OnboardingCleanupTargetInput,
  ): Promise<OnboardingIntakeStatusChangeResult> {
    return this.requestJson<OnboardingIntakeStatusChangeResult>({
      method: 'POST',
      path: '/onboarding-intakes/supersede',
      body: input,
    });
  }

  continueOnboardingSetup(
    input: OnboardingIntakeIdInput,
  ): Promise<ContinueOnboardingSetupResult> {
    return this.requestJson<ContinueOnboardingSetupResult>({
      method: 'POST',
      path: `/onboarding-intakes/${encodeURIComponent(input.onboardingIntakeId)}/continue-setup`,
    });
  }

  createOffboardingIntake(
    input: CreateOffboardingIntakeInput,
  ): Promise<CreateOffboardingIntakeResult> {
    return this.requestJson<CreateOffboardingIntakeResult>({
      method: 'POST',
      path: '/offboarding-intakes',
      body: input,
    });
  }

  autoProcessOffboarding(
    input: CreateOffboardingIntakeInput,
  ): Promise<AutoProcessOffboardingResult> {
    return this.requestJson<AutoProcessOffboardingResult>(
      {
        method: 'POST',
        path: '/offboarding-intakes/auto-process',
        body: input,
      },
      { retryOnTimeout: true },
    );
  }

  getOffboardingIntake(
    input: OffboardingIntakeIdInput,
  ): Promise<OffboardingIntakeDetail> {
    return this.requestJson<OffboardingIntakeDetail>({
      method: 'GET',
      path: `/offboarding-intakes/${encodeURIComponent(input.offboardingIntakeId)}`,
    });
  }

  decideOffboardingIntake(
    input: DecideOffboardingIntakeInput,
  ): Promise<DecideOffboardingIntakeResult> {
    const {
      offboardingIntakeId,
      decision,
      approverExternalUserId,
      comment,
      source,
      gantryConversationId,
      gantryRuntimeEventId,
    } = input;

    return this.requestJson<DecideOffboardingIntakeResult>({
      method: 'POST',
      path: `/offboarding-intakes/${encodeURIComponent(offboardingIntakeId)}/decision`,
      body: {
        decision,
        approverExternalUserId,
        comment,
        source,
        gantryConversationId,
        gantryRuntimeEventId,
      },
    });
  }

  getOffboardingStatus(
    input: OffboardingIntakeIdInput,
  ): Promise<OffboardingStatusResult> {
    return this.requestJson<OffboardingStatusResult>({
      method: 'GET',
      path: `/offboarding-intakes/${encodeURIComponent(input.offboardingIntakeId)}/status`,
    });
  }

  finalizeOffboarding(
    input: OffboardingIntakeIdInput,
  ): Promise<FinalizeOffboardingResult> {
    return this.requestJson<FinalizeOffboardingResult>({
      method: 'POST',
      path: `/offboarding-intakes/${encodeURIComponent(input.offboardingIntakeId)}/finalize`,
    });
  }

  private async requestJson<T>(
    input: {
      method: HttpMethod;
      path: string;
      query?: Record<string, string | number | boolean | null | undefined>;
      body?: unknown;
    },
    options?: {
      retryOnTimeout?: boolean;
    },
  ): Promise<T> {
    const maxAttempts = options?.retryOnTimeout
      ? this.bridgeConfig.itopsApiRetryAttempts + 1
      : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.requestJsonOnce<T>(input);
      } catch (error) {
        lastError = error;

        if (
          !(error instanceof ItOpsApiTimeoutError) ||
          attempt >= maxAttempts
        ) {
          throw error;
        }

        await sleep(this.bridgeConfig.itopsApiRetryDelayMs);
      }
    }

    throw lastError;
  }

  private async requestJsonOnce<T>(input: {
    method: HttpMethod;
    path: string;
    query?: Record<string, string | number | boolean | null | undefined>;
    body?: unknown;
  }): Promise<T> {
    const url = this.buildUrl(input.path, input.query);
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      this.bridgeConfig.itopsApiTimeoutMs,
    );

    try {
      const response = await fetch(url, {
        method: input.method,
        headers: this.buildHeaders(input.body !== undefined),
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(
          `IT Ops API request failed (${response.status}): ${await getSafeErrorMessage(response)}`,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ItOpsApiTimeoutError(
          `IT Ops API request failed (timeout): exceeded ${this.bridgeConfig.itopsApiTimeoutMs}ms`,
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | null | undefined>,
  ): URL {
    const url = new URL(
      path,
      withTrailingSlash(this.bridgeConfig.itopsApiBaseUrl),
    );

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  private buildHeaders(hasBody: boolean): Headers {
    const headers = new Headers({
      Accept: 'application/json',
    });

    if (hasBody) {
      headers.set('Content-Type', 'application/json');
    }

    if (this.bridgeConfig.itopsApiKey) {
      headers.set('Authorization', `Bearer ${this.bridgeConfig.itopsApiKey}`);
    }

    return headers;
  }
}

class ItOpsApiTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItOpsApiTimeoutError';
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getSafeErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    try {
      return extractMessage(await response.json()) ?? response.statusText;
    } catch {
      return response.statusText;
    }
  }

  const text = (await response.text()).trim();
  return text || response.statusText;
}

function extractMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  if ('message' in value) {
    const message = value.message;

    if (typeof message === 'string' && message.trim()) {
      return message;
    }

    if (Array.isArray(message)) {
      const firstMessage = message.find(
        (item) => typeof item === 'string' && item.trim(),
      );

      if (typeof firstMessage === 'string') {
        return firstMessage;
      }
    }
  }

  if (
    'error' in value &&
    typeof value.error === 'string' &&
    value.error.trim()
  ) {
    return value.error;
  }

  return undefined;
}

function withTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
