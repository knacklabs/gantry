export type Employee = {
  id: string;
  fullName: string;
  workEmail: string | null;
  personalEmail: string | null;
  contactNo: string | null;
  employmentType: 'fte' | 'contractor';
  designation: string;
  department: string | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateEmployeeInput = {
  fullName: string;
  personalEmail?: string | null;
  workEmail?: string | null;
  employmentType: 'fte' | 'contractor';
  designation: string;
  department?: string | null;
  startDate?: string | null;
  createdByExternalUserId?: string;
};

export type SearchEmployeesInput = {
  query: string;
};

export type EmployeeListStatus =
  'open' | 'active' | 'preboarding' | 'offboarding' | 'offboarded' | 'all';

export type ListEmployeesInput = {
  query?: string;
  status?: EmployeeListStatus;
  page?: number;
  pageSize?: number;
};

export type ListEmployeesResult = {
  employees: Employee[];
  page: number;
  pageSize: number;
  total: number;
  hasNextPage: boolean;
};

export type ResolveEmployeeInput = {
  query: string;
  purpose?: 'read' | 'mutate' | 'offboarding';
};

export type ResolvedEmployeeSummary = {
  employeeId: string;
  fullName: string;
  workEmail: string | null;
  status: string;
  designation: string;
  department: string | null;
};

export type ResolveEmployeeResult = {
  status: 'resolved' | 'needs_confirmation' | 'multiple_matches' | 'not_found';
  query: string;
  purpose: 'read' | 'mutate' | 'offboarding';
  employee: ResolvedEmployeeSummary | null;
  matches: ResolvedEmployeeSummary[];
};

export type EmployeeIdInput = {
  employeeId: string;
};

export type EmailMessageIdInput = {
  emailMessageId: string;
};

export type EmailMessage = {
  id: string;
  templateKey: string;
  senderType: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  status: string;
  provider: string;
  providerMessageId: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  errorMessage: string | null;
  metadataJson: Record<string, unknown> | null;
  createdAt: string;
  sentAt: string | null;
  updatedAt: string;
};

export type AccessRequest = {
  id: string;
  employeeId: string;
  systemId: string;
  resourceId: string;
  roleId: string;
  action: 'grant' | 'revoke';
  status: string;
  reason: string | null;
  requestedByExternalUserId: string;
  requestedFrom: string | null;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RequestGoogleWorkspaceEmailInput = {
  employeeId: string;
  reason?: string | null;
  requestedByExternalUserId: string;
};

export type CreateAccessRequestInput = {
  employeeId: string;
  systemKey: string;
  resourceKey: string;
  roleKey: string;
  action: 'grant' | 'revoke';
  reason?: string | null;
  requestedByExternalUserId: string;
  requestedFrom?: string | null;
};

export type DecideAccessRequestInput = {
  accessRequestId: string;
  decision: 'approved' | 'rejected';
  approverExternalUserId: string;
  comment?: string | null;
  source?: string;
  gantryConversationId?: string | null;
  gantryRuntimeEventId?: string | null;
};

export type Approval = {
  id: string;
  accessRequestId: string;
  approverExternalUserId: string;
  decision: 'approved' | 'rejected';
  comment: string | null;
  source: string;
  gantryConversationId: string | null;
  gantryRuntimeEventId: string | null;
  createdAt: string;
};

export type AccessTask = {
  id: string;
  accessRequestId: string;
  operation: 'grant' | 'revoke';
  connector: string;
  status: string;
  idempotencyKey: string;
  attemptCount: number;
  externalResultJson: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AccessGrant = {
  id: string;
  employeeId: string;
  systemId: string;
  resourceId: string;
  roleId: string;
  status: string;
  externalAccountId: string | null;
  grantedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AccessRequestDecision = {
  accessRequest: AccessRequest;
  approval: Approval;
  accessTask: AccessTask | null;
};

export type AccessTaskExecutionResult = {
  task: AccessTask;
  grant: AccessGrant | null;
  dependencyRequired?: boolean;
  code?: string;
  message?: string;
  connectorResult?: Record<string, unknown>;
};

export type EmployeeAccessSummary = {
  employee: Pick<Employee, 'id' | 'fullName' | 'workEmail' | 'status'>;
  access: Array<{
    grantId: string;
    system: {
      key: string;
      name: string;
    };
    resource: {
      key: string;
      name: string;
      resourceType: string;
    };
    role: {
      key: string;
      name: string;
      riskLevel: string;
    };
    status: 'active';
    externalAccountId: string | null;
    grantedAt: string | null;
  }>;
};

export type SearchAccessGrantsInput = {
  employeeQuery?: string;
  systemKey?: string;
  resourceKey?: string;
  status?: string;
  mode?: 'active' | 'inactive' | 'history';
};

export type AccessGrantSearchResult = {
  grants: Array<{
    grantId: string;
    employee: Pick<Employee, 'id' | 'fullName' | 'workEmail' | 'status'>;
    system: {
      key: string;
      name: string;
    };
    resource: {
      key: string;
      name: string;
      resourceType: string;
    };
    role: {
      key: string;
      name: string;
      riskLevel: string;
    };
    status: string;
    externalAccountId: string | null;
    grantedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
};

export type AccessDetailReportInput = {
  employeeQuery: string;
  reportType:
    | 'offboarding_audit'
    | 'access_history'
    | 'revoke_task_status'
    | 'access_request_status';
};

export type AccessDetailReport = {
  reportType: AccessDetailReportInput['reportType'];
  employees: Array<Pick<Employee, 'id' | 'fullName' | 'workEmail' | 'status'>>;
  accessRequests: Array<{
    id: string;
    action: 'grant' | 'revoke';
    status: string;
    requestedFrom: string | null;
    requestedByExternalUserId: string;
    createdAt: string;
    updatedAt: string;
    system: { key: string; name: string };
    resource: { key: string; name: string; resourceType: string };
    role: { key: string; name: string };
  }>;
  approvals: Array<{
    id: string;
    accessRequestId: string;
    approverExternalUserId: string;
    decision: string;
    source: string;
    createdAt: string;
  }>;
  accessTasks: Array<{
    id: string;
    accessRequestId: string;
    operation: 'grant' | 'revoke';
    status: string;
    connector: string;
    attemptCount: number;
    connectorResultSummary: Record<string, unknown> | null;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  accessGrants: Array<{
    id: string;
    employeeId: string;
    status: string;
    externalAccountId: string | null;
    grantedAt: string | null;
    revokedAt: string | null;
    system: { key: string; name: string };
    resource: { key: string; name: string; resourceType: string };
    role: { key: string; name: string };
  }>;
  offboardingIntakes: Array<{
    id: string;
    employeeId: string;
    status: string;
    requestedByExternalUserId: string;
    createdAt: string;
    approvedAt: string | null;
    rejectedAt: string | null;
    completedAt: string | null;
  }>;
  offboardingApprovals: Array<{
    id: string;
    offboardingIntakeId: string;
    approverExternalUserId: string;
    decision: string;
    source: string;
    createdAt: string;
  }>;
  auditEvents: Array<{
    id: string;
    eventType: string;
    entityType: string;
    entityId: string | null;
    actorExternalUserId: string;
    createdAt: string;
  }>;
};

export type DiagnosticsActorInput = {
  actorExternalUserId: string;
};

export type TaskStatusDiagnosticsInput = DiagnosticsActorInput & {
  employeeQuery: string;
};

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
      status: 'present' | 'missing' | 'not_required';
    }>;
  }>;
};

export type ConnectorHealth = {
  connectors: Array<{
    name: string;
    enabled: boolean;
    mode?: string;
    status: 'ready' | 'not_configured' | 'disabled';
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
  updatedAt: string;
};

export type RecentFailedAccessTasksDiagnostics = {
  failedAccessTasks: DiagnosticsTaskSummary[];
};

export type TaskStatusDiagnostics = {
  tasks: DiagnosticsTaskSummary[];
};

export type SlackSourceMessage = {
  id: string;
  provider: string;
  workspaceId: string;
  channelId: string;
  messageTs: string;
  threadTs: string | null;
  senderExternalUserId: string | null;
  rawText: string;
  detectedType: string;
  processedStatus: string;
  createdAt: string;
  updatedAt: string;
};

export type OnboardingIntake = {
  id: string;
  sourceMessageId: string;
  employeeId: string | null;
  googleWorkspaceAccessRequestId: string | null;
  name: string | null;
  personalEmail: string | null;
  contactNo: string | null;
  doj: string | null;
  employmentType: string | null;
  designation: string | null;
  laptop: string | null;
  relocation: string | null;
  requestedSlackChannels: unknown[];
  validationErrors: unknown[];
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateOnboardingIntakeFromSlackMessageInput = {
  workspaceId?: string | null;
  channelId?: string | null;
  messageTs?: string | null;
  threadTs?: string | null;
  senderSlackUserId?: string | null;
  senderExternalUserId?: string | null;
  rawText: string;
};

export type CreateOnboardingIntakeFromSlackMessageResult = {
  sourceMessage: SlackSourceMessage;
  onboardingIntake: OnboardingIntake;
  created: boolean;
  valid: boolean;
  validationErrors: string[];
  nextAction: 'admin_review_required' | 'fix_validation_errors';
};

export type AutoProcessOnboardingFromSlackMessageResult = Omit<
  CreateOnboardingIntakeFromSlackMessageResult,
  'nextAction'
> & {
  authorityDecision: DecideOnboardingIntakeResult | null;
  setup: ContinueOnboardingSetupResult | null;
  nextAction: 'fix_validation_errors' | 'setup_complete' | 'setup_pending';
};

export type ListOnboardingIntakesInput = {
  status?:
    | 'open'
    | 'pending_review'
    | 'needs_correction'
    | 'validation_failed'
    | 'waiting_for_review'
    | 'approved'
    | 'ready_for_provisioning'
    | 'completed'
    | 'cancelled'
    | 'rejected'
    | 'superseded';
  limit?: number;
};

export type ListOnboardingIntakesResult = {
  onboardingIntakes: OnboardingIntake[];
  count: number;
};

export type DecideOnboardingIntakeInput = {
  onboardingIntakeId: string;
  decision: 'approved' | 'rejected';
  approverExternalUserId: string;
  comment?: string | null;
  source?: string;
  gantryConversationId?: string | null;
  gantryRuntimeEventId?: string | null;
};

export type OnboardingIntakeApproval = {
  id: string;
  onboardingIntakeId: string;
  approverExternalUserId: string;
  decision: 'approved' | 'rejected';
  comment: string | null;
  source: string;
  gantryConversationId: string | null;
  gantryRuntimeEventId: string | null;
  createdAt: string;
};

export type DecideOnboardingIntakeResult = {
  onboardingIntake: OnboardingIntake;
  decision: OnboardingIntakeApproval;
  employee: Employee | null;
  googleWorkspaceAccessRequest: AccessRequest | null;
  accessTask: AccessTask | null;
  slackWorkspaceAccessRequest: AccessRequest | null;
  slackWorkspaceAccessTask: AccessTask | null;
  slackChannelAccessRequests: AccessRequest[];
  slackChannelAccessTasks: AccessTask[];
  nextAction?: 'execute_google_workspace_task';
};

export type OnboardingIntakeIdInput = {
  onboardingIntakeId: string;
};

export type OnboardingSetupItem = {
  accessRequestId: string;
  accessTaskId: string | null;
  system: {
    key: string;
    name: string;
  };
  resource: {
    key: string;
    name: string;
    resourceType: string;
  };
  role: {
    key: string;
    name: string;
  };
  requestStatus: string;
  taskStatus: string | null;
  taskErrorMessage: string | null;
  grantStatus: string | null;
  required: boolean;
};

export type OnboardingStatusSummary = {
  total: number;
  completed: number;
  pending: number;
  failed: number;
};

export type OnboardingStatusResult = {
  onboardingIntake: OnboardingIntake;
  employee: Employee | null;
  summary: OnboardingStatusSummary;
  setupItems: OnboardingSetupItem[];
  canFinalize: boolean;
};

export type FinalizeOnboardingResult = OnboardingStatusResult;

export type ContinueOnboardingSetupResult = OnboardingStatusResult & {
  executedTasks: AccessTaskExecutionResult[];
  executionErrors: Array<{
    accessTaskId: string;
    message: string;
  }>;
  finalized: boolean;
};

export type PendingOnboardingSetupSummary = {
  onboardingIntake: OnboardingIntake;
  employee: Employee | null;
  pendingCriticalSetup: string[];
};

export type ListPendingOnboardingSetupsResult = {
  pendingSetups: PendingOnboardingSetupSummary[];
  count: number;
};

export type OnboardingNaturalTargetInput = {
  onboardingIntakeId?: string;
  employeeId?: string;
  query?: string;
  name?: string;
  workEmail?: string;
  personalEmail?: string;
  designation?: string;
  doj?: string;
  actorExternalUserId?: string;
  reason?: string;
};

export type ResolveOnboardingIntakeInput = OnboardingNaturalTargetInput & {
  status?: ListOnboardingIntakesInput['status'];
};

export type ResolveOnboardingIntakeResult = {
  onboardingIntake: OnboardingIntake;
};

export type OnboardingCleanupTargetInput = Omit<
  OnboardingNaturalTargetInput,
  'actorExternalUserId'
> & {
  actorExternalUserId: string;
};

export type OnboardingWorkQueueItem = OnboardingStatusResult & {
  category:
    | 'needs_correction'
    | 'waiting_approval'
    | 'setup_pending'
    | 'ready_to_finalize'
    | 'blocked';
  validationErrors: string[];
};

export type ListOnboardingWorkQueueResult = {
  items: OnboardingWorkQueueItem[];
  count: number;
};

export type FinalizeOnboardingByEmployeeResult = OnboardingStatusResult & {
  duplicateWarnings: OnboardingIntake[];
};

export type OnboardingIntakeStatusChangeResult = {
  onboardingIntake: OnboardingIntake;
};

export type OffboardingIntake = {
  id: string;
  employeeId: string;
  requestedByExternalUserId: string;
  reason: string | null;
  lastWorkingDay: string | null;
  notes: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  completedAt: string | null;
};

export type CreateOffboardingIntakeInput = {
  employeeId: string;
  lastWorkingDay?: string | null;
  reason?: string | null;
  requestedByExternalUserId: string;
  notes?: string | null;
};

export type OffboardingSystem = {
  id: string;
  key: string;
  name: string;
};

export type OffboardingResource = {
  id: string;
  key: string;
  name: string;
  resourceType: string;
};

export type OffboardingRole = {
  id: string;
  key: string;
  name: string;
  riskLevel: string;
};

export type OffboardingActiveAccessPreviewItem = {
  grantId: string;
  system: OffboardingSystem;
  resource: OffboardingResource;
  role: OffboardingRole;
  status: 'active';
};

export type OffboardingRevokeItem = {
  id: string;
  accessGrantId: string;
  accessRequestId: string | null;
  accessTaskId: string | null;
  status: string;
  errorMessage: string | null;
  system: OffboardingSystem;
  resource: OffboardingResource;
  role: OffboardingRole;
};

export type CreateOffboardingIntakeResult = {
  offboardingIntake: OffboardingIntake | null;
  employee: Employee;
  activeAccessPreview: OffboardingActiveAccessPreviewItem[];
  activeAccessCount: number;
  employeeLifecycleCase:
    | 'preboarding_cancellation'
    | 'active_offboarding'
    | 'already_offboarding'
    | 'already_offboarded';
  message: string;
  nextAction: 'approval_required' | 'view_existing_status' | 'no_change';
  offboardingStatus?: OffboardingStatusResult;
};

export type OffboardingIntakeDetail = {
  offboardingIntake: OffboardingIntake;
  employee: Employee;
  status: string;
  activeAccessPreview: OffboardingActiveAccessPreviewItem[];
  activeAccessCount: number;
  revokeItems: OffboardingRevokeItem[];
};

export type OffboardingIntakeIdInput = {
  offboardingIntakeId: string;
};

export type DecideOffboardingIntakeInput = OffboardingIntakeIdInput & {
  decision: 'approved' | 'rejected';
  approverExternalUserId: string;
  comment?: string | null;
  source?: string;
  gantryConversationId?: string | null;
  gantryRuntimeEventId?: string | null;
};

export type OffboardingIntakeApproval = {
  id: string;
  offboardingIntakeId: string;
  approverExternalUserId: string;
  decision: 'approved' | 'rejected';
  comment: string | null;
  source: string;
  gantryConversationId: string | null;
  gantryRuntimeEventId: string | null;
  createdAt: string;
};

export type OffboardingDecisionRevokeItem = {
  grantId: string;
  accessRequestId: string;
  accessTaskId: string;
  system: OffboardingSystem;
  resource: OffboardingResource;
  role: OffboardingRole;
  taskStatus: string;
};

export type DecideOffboardingIntakeResult = {
  offboardingIntake: OffboardingIntake;
  decision: OffboardingIntakeApproval;
  employee: Employee | null;
  revokeItems: OffboardingDecisionRevokeItem[];
  status: string;
  nextAction?: 'execute_revoke_tasks';
};

export type OffboardingStatusSummary = {
  total: number;
  completed: number;
  pending: number;
  failed: number;
};

export type OffboardingStatusRevokeItem = {
  id: string;
  system: OffboardingSystem;
  resource: OffboardingResource;
  role: OffboardingRole;
  grantStatus: string;
  taskStatus: string | null;
  accessTaskId: string | null;
};

export type OffboardingStatusResult = {
  offboardingIntake: OffboardingIntake;
  employee: Employee;
  summary: OffboardingStatusSummary;
  revokeItems: OffboardingStatusRevokeItem[];
  canFinalize: boolean;
  workflowState: string;
  employeeLifecycleCase:
    | 'preboarding_cancellation'
    | 'active_offboarding'
    | 'already_offboarding'
    | 'already_offboarded';
};

export type FinalizeOffboardingResult = OffboardingStatusResult;

export type AutoProcessOffboardingResult = CreateOffboardingIntakeResult & {
  authorityDecision: DecideOffboardingIntakeResult | null;
  executedTasks: AccessTaskExecutionResult[];
  executionErrors: Array<{
    accessTaskId: string;
    message: string;
  }>;
  finalStatus?: OffboardingStatusResult;
  finalized: boolean;
};
