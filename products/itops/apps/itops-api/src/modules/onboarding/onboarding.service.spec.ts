import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  ACCESS_REQUEST_ACTION,
  ACCESS_REQUEST_STATUS,
  EMPLOYEE_STATUS,
  ONBOARDING_INTAKE_APPROVAL_DECISION,
  ONBOARDING_INTAKE_STATUS
} from "@itops/db";
import type { SlackConnectorInterface } from "@itops/connectors";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OnboardingParserService, ParsedOnboardingFields } from "./onboarding-parser.service.js";
import {
  type AccessRequest,
  type AccessTask,
  type Employee,
  OnboardingRepository,
  type OnboardingIntake,
  type OnboardingIntakeApproval,
  type SlackSourceMessage
} from "./onboarding.repository.js";
import { OnboardingService } from "./onboarding.service.js";
import type { OnboardingValidationService } from "./onboarding-validation.service.js";
import type { AccessTaskExecutorService } from "../access-tasks/access-task-executor.service.js";
import type { ApprovalPolicyService } from "../policies/approval-policy.service.js";

type OnboardingRepositoryMock = {
  upsertSlackSourceMessage: ReturnType<typeof vi.fn>;
  findOnboardingIntakeBySourceMessageId: ReturnType<typeof vi.fn>;
  listOnboardingIntakes: ReturnType<typeof vi.fn>;
  findOnboardingIntakeCandidates: ReturnType<typeof vi.fn>;
  findOpenOnboardingIntakeByPersonalEmail: ReturnType<typeof vi.fn>;
  supersedeValidationFailedIntakesByPersonalEmail: ReturnType<typeof vi.fn>;
  updateOnboardingIntakeStatus: ReturnType<typeof vi.fn>;
  repairValidationFailedOnboardingIntake: ReturnType<typeof vi.fn>;
  createOnboardingIntake: ReturnType<typeof vi.fn>;
  findOnboardingIntakeById: ReturnType<typeof vi.fn>;
  findSlackSourceMessageById: ReturnType<typeof vi.fn>;
  findEmployeeById: ReturnType<typeof vi.fn>;
  findAccessRequestById: ReturnType<typeof vi.fn>;
  findAccessTaskByAccessRequestId: ReturnType<typeof vi.fn>;
  listSlackChannelAccessForOnboarding: ReturnType<typeof vi.fn>;
  findSlackWorkspaceMembershipAccessForOnboarding: ReturnType<typeof vi.fn>;
  findApprovedOnboardingIntakeDecision: ReturnType<typeof vi.fn>;
  recordOnboardingApprovalDeniedByPolicy: ReturnType<typeof vi.fn>;
  decideOnboardingIntake: ReturnType<typeof vi.fn>;
  getOnboardingStatus: ReturnType<typeof vi.fn>;
  finalizeOnboarding: ReturnType<typeof vi.fn>;
  createEmployeeForOnboarding: ReturnType<typeof vi.fn>;
  createGoogleWorkspaceAccessRequestForOnboarding: ReturnType<typeof vi.fn>;
};

type OnboardingParserServiceMock = {
  parse: ReturnType<typeof vi.fn>;
};

type OnboardingValidationServiceMock = {
  validate: ReturnType<typeof vi.fn>;
};

type ApprovalPolicyServiceMock = {
  canApproveExternalActor: ReturnType<typeof vi.fn>;
  canAccessDiagnostics: ReturnType<typeof vi.fn>;
};

type AccessTaskExecutorServiceMock = {
  executeAccessTask: ReturnType<typeof vi.fn>;
};

type SlackConnectorMock = {
  findChannelById: ReturnType<typeof vi.fn>;
};

describe("OnboardingService", () => {
  let repository: OnboardingRepositoryMock;
  let parserService: OnboardingParserServiceMock;
  let validationService: OnboardingValidationServiceMock;
  let approvalPolicyService: ApprovalPolicyServiceMock;
  let accessTaskExecutorService: AccessTaskExecutorServiceMock;
  let slackConnector: SlackConnectorMock;
  let service: OnboardingService;

  beforeEach(() => {
    repository = {
      upsertSlackSourceMessage: vi.fn(),
      findOnboardingIntakeBySourceMessageId: vi.fn(),
      listOnboardingIntakes: vi.fn(),
      findOnboardingIntakeCandidates: vi.fn(),
      findOpenOnboardingIntakeByPersonalEmail: vi.fn(),
      supersedeValidationFailedIntakesByPersonalEmail: vi.fn(),
      updateOnboardingIntakeStatus: vi.fn(),
      repairValidationFailedOnboardingIntake: vi.fn(),
      createOnboardingIntake: vi.fn(),
      findOnboardingIntakeById: vi.fn(),
      findSlackSourceMessageById: vi.fn(),
      findEmployeeById: vi.fn(),
      findAccessRequestById: vi.fn(),
      findAccessTaskByAccessRequestId: vi.fn(),
      listSlackChannelAccessForOnboarding: vi.fn(),
      findSlackWorkspaceMembershipAccessForOnboarding: vi.fn(),
      findApprovedOnboardingIntakeDecision: vi.fn(),
      recordOnboardingApprovalDeniedByPolicy: vi.fn(),
      decideOnboardingIntake: vi.fn(),
      getOnboardingStatus: vi.fn(),
      finalizeOnboarding: vi.fn(),
      createEmployeeForOnboarding: vi.fn(),
      createGoogleWorkspaceAccessRequestForOnboarding: vi.fn()
    };
    parserService = {
      parse: vi.fn()
    };
    validationService = {
      validate: vi.fn()
    };
    approvalPolicyService = {
      canApproveExternalActor: vi.fn(() => ({ allowed: true, reason: "approver is authorized" })),
      canAccessDiagnostics: vi.fn(() => ({ allowed: true, reason: "actor is authorized for diagnostics" }))
    };
    accessTaskExecutorService = {
      executeAccessTask: vi.fn()
    };
    slackConnector = {
      findChannelById: vi.fn()
    };
    service = new OnboardingService(
      repository as unknown as OnboardingRepository,
      parserService as unknown as OnboardingParserService,
      validationService as unknown as OnboardingValidationService,
      approvalPolicyService as unknown as ApprovalPolicyService,
      accessTaskExecutorService as unknown as AccessTaskExecutorService,
      slackConnector as unknown as SlackConnectorInterface
    );
  });

  it("creates a valid onboarding intake with status waiting_for_review", async () => {
    const sourceMessage = makeSourceMessage();
    const onboardingIntake = makeOnboardingIntake();
    const parseResult = makeParseResult();
    const validation = makeValidationResult();

    repository.upsertSlackSourceMessage.mockResolvedValue(sourceMessage);
    repository.findOnboardingIntakeBySourceMessageId.mockResolvedValue(undefined);
    parserService.parse.mockReturnValue(parseResult);
    validationService.validate.mockResolvedValue(validation);
    repository.createOnboardingIntake.mockResolvedValue({ sourceMessage, onboardingIntake });

    await expect(service.createSlackOnboardingIntake(makePayload())).resolves.toEqual({
      sourceMessage,
      onboardingIntake,
      created: true,
      valid: true,
      validationErrors: [],
      nextAction: "admin_review_required"
    });

    expect(repository.upsertSlackSourceMessage).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "C123",
      messageTs: "1710000000.000000",
      threadTs: "1710000000.000000",
      rawText: "New Joiner Alert\nName: Riya Sharma",
      actorExternalUserId: "slack:U123"
    });
    expect(repository.createOnboardingIntake).toHaveBeenCalledWith({
      sourceMessage,
      actorExternalUserId: "slack:U123",
      parsedFields: parseResult.fields,
      validation
    });
  });

  it("resolves bare Slack channel ids before validating and storing onboarding intake", async () => {
    const sourceMessage = makeSourceMessage();
    const onboardingIntake = makeOnboardingIntake();
    const parseResult = makeParseResult({
      slackChannels: ["C082B4DK080"]
    });
    const validation = makeValidationResult();

    repository.upsertSlackSourceMessage.mockResolvedValue(sourceMessage);
    repository.findOnboardingIntakeBySourceMessageId.mockResolvedValue(undefined);
    parserService.parse.mockReturnValue(parseResult);
    slackConnector.findChannelById.mockResolvedValue({
      id: "C082B4DK080",
      name: "engineering-team-1",
      isPrivate: false,
      isArchived: false
    });
    validationService.validate.mockResolvedValue(validation);
    repository.createOnboardingIntake.mockResolvedValue({ sourceMessage, onboardingIntake });

    await expect(service.createSlackOnboardingIntake(makePayload())).resolves.toMatchObject({
      valid: true,
      onboardingIntake
    });

    expect(slackConnector.findChannelById).toHaveBeenCalledWith({
      channelId: "C082B4DK080"
    });
    expect(validationService.validate).toHaveBeenCalledWith(expect.objectContaining({
      slackChannels: ["engineering-team-1"]
    }));
    expect(repository.createOnboardingIntake).toHaveBeenCalledWith(expect.objectContaining({
      parsedFields: expect.objectContaining({
        slackChannels: ["engineering-team-1"]
      })
    }));
  });

  it("keeps onboarding intake creation recoverable when Slack channel id lookup fails", async () => {
    const sourceMessage = makeSourceMessage();
    const onboardingIntake = makeOnboardingIntake();
    const parseResult = makeParseResult({
      slackChannels: ["C082B4DK080"]
    });
    const validation = makeValidationResult();

    repository.upsertSlackSourceMessage.mockResolvedValue(sourceMessage);
    repository.findOnboardingIntakeBySourceMessageId.mockResolvedValue(undefined);
    parserService.parse.mockReturnValue(parseResult);
    slackConnector.findChannelById.mockRejectedValue(new Error("Slack lookup failed"));
    validationService.validate.mockResolvedValue(validation);
    repository.createOnboardingIntake.mockResolvedValue({ sourceMessage, onboardingIntake });

    await expect(service.createSlackOnboardingIntake(makePayload())).resolves.toMatchObject({
      valid: true,
      onboardingIntake
    });

    expect(validationService.validate).toHaveBeenCalledWith(expect.objectContaining({
      slackChannels: ["C082B4DK080"]
    }));
  });

  it("creates an invalid onboarding intake with status validation_failed", async () => {
    const sourceMessage = makeSourceMessage();
    const onboardingIntake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.validationFailed,
      validationErrors: ["personalEmail must be a valid email"]
    });
    const parseResult = makeParseResult();
    const validation = makeValidationResult({
      valid: false,
      normalized: null,
      validationErrors: ["personalEmail must be a valid email"]
    });

    repository.upsertSlackSourceMessage.mockResolvedValue(sourceMessage);
    repository.findOnboardingIntakeBySourceMessageId.mockResolvedValue(undefined);
    parserService.parse.mockReturnValue(parseResult);
    validationService.validate.mockResolvedValue(validation);
    repository.createOnboardingIntake.mockResolvedValue({ sourceMessage, onboardingIntake });

    await expect(service.createSlackOnboardingIntake(makePayload())).resolves.toEqual({
      sourceMessage,
      onboardingIntake,
      created: true,
      valid: false,
      validationErrors: ["personalEmail must be a valid email"],
      nextAction: "fix_validation_errors"
    });
  });

  it("returns an existing onboarding intake idempotently for duplicate Slack messages", async () => {
    const sourceMessage = makeSourceMessage();
    const onboardingIntake = makeOnboardingIntake();
    const parseResult = makeParseResult();
    const validation = makeValidationResult();

    repository.upsertSlackSourceMessage.mockResolvedValue(sourceMessage);
    repository.findOnboardingIntakeBySourceMessageId.mockResolvedValue(onboardingIntake);
    parserService.parse.mockReturnValue(parseResult);
    validationService.validate.mockResolvedValue(validation);

    await expect(service.createSlackOnboardingIntake(makePayload())).resolves.toEqual({
      sourceMessage,
      onboardingIntake,
      created: false,
      valid: true,
      validationErrors: [],
      nextAction: "admin_review_required"
    });

    expect(parserService.parse).toHaveBeenCalledWith("New Joiner Alert\nName: Riya Sharma");
    expect(validationService.validate).toHaveBeenCalledWith(parseResult.fields);
    expect(repository.repairValidationFailedOnboardingIntake).not.toHaveBeenCalled();
    expect(repository.createOnboardingIntake).not.toHaveBeenCalled();
  });

  it("repairs an existing validation-failed intake when the same source message now parses cleanly", async () => {
    const sourceMessage = makeSourceMessage();
    const existingIntake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.validationFailed,
      name: null,
      personalEmail: null,
      validationErrors: ["name is required"]
    });
    const repairedIntake = makeOnboardingIntake();
    const parseResult = makeParseResult();
    const validation = makeValidationResult();

    repository.upsertSlackSourceMessage.mockResolvedValue(sourceMessage);
    repository.findOnboardingIntakeBySourceMessageId.mockResolvedValue(existingIntake);
    parserService.parse.mockReturnValue(parseResult);
    validationService.validate.mockResolvedValue(validation);
    repository.repairValidationFailedOnboardingIntake.mockResolvedValue({
      sourceMessage,
      onboardingIntake: repairedIntake
    });

    await expect(service.createSlackOnboardingIntake(makePayload())).resolves.toEqual({
      sourceMessage,
      onboardingIntake: repairedIntake,
      created: false,
      valid: true,
      validationErrors: [],
      nextAction: "admin_review_required"
    });

    expect(repository.repairValidationFailedOnboardingIntake).toHaveBeenCalledWith({
      sourceMessage,
      actorExternalUserId: "slack:U123",
      onboardingIntake: existingIntake,
      parsedFields: parseResult.fields,
      validation
    });
    expect(repository.createOnboardingIntake).not.toHaveBeenCalled();
  });

  it("returns an existing open onboarding intake for the same normalized personal email", async () => {
    const sourceMessage = makeSourceMessage({
      id: "798febd7-dc75-4c25-8bb6-1706c99f2c4d",
      messageTs: "1710000001.000000"
    });
    const existingIntake = makeOnboardingIntake({
      personalEmail: "riya.personal@example.com"
    });
    const parseResult = makeParseResult();
    const validation = makeValidationResult();

    repository.upsertSlackSourceMessage.mockResolvedValue(sourceMessage);
    repository.findOnboardingIntakeBySourceMessageId.mockResolvedValue(undefined);
    parserService.parse.mockReturnValue(parseResult);
    validationService.validate.mockResolvedValue(validation);
    repository.findOpenOnboardingIntakeByPersonalEmail.mockResolvedValue(existingIntake);

    await expect(service.createSlackOnboardingIntake(makePayload())).resolves.toEqual({
      sourceMessage,
      onboardingIntake: existingIntake,
      created: false,
      valid: true,
      validationErrors: [],
      nextAction: "admin_review_required"
    });

    expect(repository.findOpenOnboardingIntakeByPersonalEmail).toHaveBeenCalledWith("riya.personal@example.com");
    expect(repository.supersedeValidationFailedIntakesByPersonalEmail).toHaveBeenCalledWith({
      personalEmail: "riya.personal@example.com",
      replacementSourceMessageId: sourceMessage.id,
      actorExternalUserId: "slack:U123"
    });
    expect(repository.createOnboardingIntake).not.toHaveBeenCalled();
  });

  it("supersedes older validation-failed intakes when a corrected valid alert arrives", async () => {
    const sourceMessage = makeSourceMessage({
      id: "798febd7-dc75-4c25-8bb6-1706c99f2c4d",
      messageTs: "1710000001.000000"
    });
    const onboardingIntake = makeOnboardingIntake();
    const parseResult = makeParseResult();
    const validation = makeValidationResult();

    repository.upsertSlackSourceMessage.mockResolvedValue(sourceMessage);
    repository.findOnboardingIntakeBySourceMessageId.mockResolvedValue(undefined);
    parserService.parse.mockReturnValue(parseResult);
    validationService.validate.mockResolvedValue(validation);
    repository.findOpenOnboardingIntakeByPersonalEmail.mockResolvedValue(undefined);
    repository.supersedeValidationFailedIntakesByPersonalEmail.mockResolvedValue([
      makeOnboardingIntake({
        id: "bb1b5c16-55e9-4da3-aeb1-4e7b9c883d74",
        status: ONBOARDING_INTAKE_STATUS.superseded,
        designation: "VP of Engineering",
        validationErrors: ["designation is not approved for FTE employees"]
      })
    ]);
    repository.createOnboardingIntake.mockResolvedValue({ sourceMessage, onboardingIntake });

    await expect(service.createSlackOnboardingIntake(makePayload())).resolves.toMatchObject({
      onboardingIntake,
      created: true,
      valid: true
    });

    expect(repository.supersedeValidationFailedIntakesByPersonalEmail).toHaveBeenCalledWith({
      personalEmail: "riya.personal@example.com",
      replacementSourceMessageId: sourceMessage.id,
      actorExternalUserId: "slack:U123"
    });
  });

  it("lists onboarding intakes waiting for admin review", async () => {
    const onboardingIntake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.waitingForReview
    });

    repository.listOnboardingIntakes.mockResolvedValue([onboardingIntake]);

    await expect(service.listOnboardingIntakes({ status: "pending_review" })).resolves.toEqual({
      onboardingIntakes: [onboardingIntake],
      count: 1
    });

    expect(repository.listOnboardingIntakes).toHaveBeenCalledWith({
      statuses: [ONBOARDING_INTAKE_STATUS.waitingForReview, ONBOARDING_INTAKE_STATUS.received],
      limit: undefined
    });
  });

  it("resolves onboarding intake ids directly without candidate search", async () => {
    const onboardingIntake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning
    });

    repository.findOnboardingIntakeById.mockResolvedValue(onboardingIntake);

    await expect(service.resolveOnboardingIntake({
      onboardingIntakeId: onboardingIntake.id,
      status: "open"
    })).resolves.toEqual({
      onboardingIntake
    });

    expect(repository.findOnboardingIntakeById).toHaveBeenCalledWith(onboardingIntake.id);
    expect(repository.findOnboardingIntakeCandidates).not.toHaveBeenCalled();
  });

  it("resolves open onboarding intakes through repository candidate search", async () => {
    const onboardingIntake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.approved,
      name: "Kartik Bansal Demo",
      designation: "Backend Engineer",
      doj: "2026-06-30"
    });

    repository.findOnboardingIntakeCandidates.mockResolvedValue([onboardingIntake]);

    await expect(service.resolveOnboardingIntake({
      name: "Kartik Bansal Demo",
      designation: "Backend Engineer",
      doj: "2026-06-30",
      status: "open"
    })).resolves.toEqual({
      onboardingIntake
    });

    expect(repository.findOnboardingIntakeCandidates).toHaveBeenCalledWith({
      onboardingIntakeId: undefined,
      employeeId: undefined,
      query: undefined,
      name: "Kartik Bansal Demo",
      workEmail: undefined,
      personalEmail: undefined,
      designation: "Backend Engineer",
      doj: "2026-06-30",
      statuses: [
        ONBOARDING_INTAKE_STATUS.waitingForReview,
        ONBOARDING_INTAKE_STATUS.approved,
        ONBOARDING_INTAKE_STATUS.readyForProvisioning
      ]
    });
  });

  it("does not guess when onboarding resolve has multiple natural-field matches", async () => {
    repository.findOnboardingIntakeCandidates.mockResolvedValue([
      makeOnboardingIntake({
        id: "08eebdd5-c91d-4ef0-8927-89346898ca19",
        name: "Kartik Bansal Demo"
      }),
      makeOnboardingIntake({
        id: "09eebdd5-c91d-4ef0-8927-89346898ca19",
        name: "Kartik Bansal Demo"
      })
    ]);

    await expect(service.resolveOnboardingIntake({
      name: "Kartik Bansal Demo",
      status: "open"
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects unknown messages", async () => {
    const sourceMessage = makeSourceMessage();

    repository.upsertSlackSourceMessage.mockResolvedValue(sourceMessage);
    repository.findOnboardingIntakeBySourceMessageId.mockResolvedValue(undefined);
    parserService.parse.mockReturnValue({
      detectedType: "unknown",
      fields: makeParseResult().fields,
      missingFields: [],
      parseErrors: []
    });

    await expect(service.createSlackOnboardingIntake(makePayload())).rejects.toBeInstanceOf(BadRequestException);

    expect(validationService.validate).not.toHaveBeenCalled();
    expect(repository.createOnboardingIntake).not.toHaveBeenCalled();
  });

  it("uses canonical senderExternalUserId before senderSlackUserId", async () => {
    const sourceMessage = makeSourceMessage({ senderExternalUserId: "slack:U999" });
    const onboardingIntake = makeOnboardingIntake();
    const parseResult = makeParseResult();
    const validation = makeValidationResult();

    repository.upsertSlackSourceMessage.mockResolvedValue(sourceMessage);
    repository.findOnboardingIntakeBySourceMessageId.mockResolvedValue(undefined);
    parserService.parse.mockReturnValue(parseResult);
    validationService.validate.mockResolvedValue(validation);
    repository.createOnboardingIntake.mockResolvedValue({ sourceMessage, onboardingIntake });

    await service.createSlackOnboardingIntake({
      ...makePayload(),
      senderExternalUserId: "slack:U999"
    });

    expect(repository.upsertSlackSourceMessage).toHaveBeenCalledWith(expect.objectContaining({
      actorExternalUserId: "slack:U999"
    }));
  });

  it("rejects payloads without an actor id", async () => {
    await expect(
      service.createSlackOnboardingIntake({
        workspaceId: "T123",
        channelId: "C123",
        messageTs: "1710000000.000000",
        rawText: "New Joiner Alert"
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.upsertSlackSourceMessage).not.toHaveBeenCalled();
  });

  it("does not process a waiting_for_review intake without admin decision", async () => {
    const intake = makeOnboardingIntake();

    repository.findOnboardingIntakeById.mockResolvedValue(intake);

    await expect(service.processOnboardingIntake(intake.id)).rejects.toBeInstanceOf(ConflictException);

    expect(repository.findSlackSourceMessageById).not.toHaveBeenCalled();
    expect(repository.createEmployeeForOnboarding).not.toHaveBeenCalled();
    expect(repository.createGoogleWorkspaceAccessRequestForOnboarding).not.toHaveBeenCalled();
  });

  it("approves an intake through policy and returns employee, access request, and access task", async () => {
    const sourceMessage = makeSourceMessage();
    const intake = makeOnboardingIntake();
    const employee = makeEmployee();
    const accessRequest = makeAccessRequest({
      employeeId: employee.id,
      status: ACCESS_REQUEST_STATUS.approved
    });
    const accessTask = makeAccessTask({ accessRequestId: accessRequest.id });
    const decision = makeOnboardingIntakeApproval();
    const result = {
      onboardingIntake: makeOnboardingIntake({
        employeeId: employee.id,
        googleWorkspaceAccessRequestId: accessRequest.id,
        status: ONBOARDING_INTAKE_STATUS.readyForProvisioning
      }),
      decision,
      employee,
      googleWorkspaceAccessRequest: accessRequest,
      accessTask,
      slackWorkspaceAccessRequest: null,
      slackWorkspaceAccessTask: null,
      slackChannelAccessRequests: [],
      slackChannelAccessTasks: [],
      nextAction: "execute_google_workspace_task" as const
    };

    repository.findOnboardingIntakeById.mockResolvedValue(intake);
    repository.findSlackSourceMessageById.mockResolvedValue(sourceMessage);
    repository.findApprovedOnboardingIntakeDecision.mockResolvedValue(undefined);
    repository.decideOnboardingIntake.mockResolvedValue(result);

    await expect(
      service.decideOnboardingIntake(intake.id, {
        decision: ONBOARDING_INTAKE_APPROVAL_DECISION.approved,
        approverExternalUserId: "slack:U999",
        comment: "Approved"
      })
    ).resolves.toEqual(result);

    expect(approvalPolicyService.canApproveExternalActor).toHaveBeenCalledWith({
      requesterExternalUserId: "slack:U123",
      approverExternalUserId: "slack:U999"
    });
    expect(repository.decideOnboardingIntake).toHaveBeenCalledWith(expect.objectContaining({
      onboardingIntake: intake,
      sourceMessage,
      decision: ONBOARDING_INTAKE_APPROVAL_DECISION.approved,
      approverExternalUserId: "slack:U999"
    }));
    expect(employee.personalEmail).toBe("riya.personal@example.com");
    expect(employee.workEmail).toBeNull();
  });

  it("rejects an intake without creating employee or access request", async () => {
    const sourceMessage = makeSourceMessage();
    const intake = makeOnboardingIntake();
    const result = {
      onboardingIntake: makeOnboardingIntake({ status: ONBOARDING_INTAKE_STATUS.rejected }),
      decision: makeOnboardingIntakeApproval({ decision: ONBOARDING_INTAKE_APPROVAL_DECISION.rejected }),
      employee: null,
      googleWorkspaceAccessRequest: null,
      accessTask: null,
      slackWorkspaceAccessRequest: null,
      slackWorkspaceAccessTask: null,
      slackChannelAccessRequests: [],
      slackChannelAccessTasks: []
    };

    repository.findOnboardingIntakeById.mockResolvedValue(intake);
    repository.findSlackSourceMessageById.mockResolvedValue(sourceMessage);
    repository.findApprovedOnboardingIntakeDecision.mockResolvedValue(undefined);
    repository.decideOnboardingIntake.mockResolvedValue(result);

    await expect(
      service.decideOnboardingIntake(intake.id, {
        decision: ONBOARDING_INTAKE_APPROVAL_DECISION.rejected,
        approverExternalUserId: "slack:U999"
      })
    ).resolves.toEqual(result);

    expect(repository.decideOnboardingIntake).toHaveBeenCalledWith(expect.objectContaining({
      decision: ONBOARDING_INTAKE_APPROVAL_DECISION.rejected
    }));
  });

  it("denies unauthorized onboarding intake approvers by policy", async () => {
    const intake = makeOnboardingIntake();

    repository.findOnboardingIntakeById.mockResolvedValue(intake);
    repository.findSlackSourceMessageById.mockResolvedValue(makeSourceMessage());
    approvalPolicyService.canApproveExternalActor.mockReturnValue({
      allowed: false,
      reason: "approver is not authorized"
    });

    await expect(
      service.decideOnboardingIntake(intake.id, {
        decision: ONBOARDING_INTAKE_APPROVAL_DECISION.approved,
        approverExternalUserId: "slack:U999"
      })
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(repository.recordOnboardingApprovalDeniedByPolicy).toHaveBeenCalledWith({
      onboardingIntake: intake,
      approverExternalUserId: "slack:U999",
      reason: "approver is not authorized"
    });
    expect(repository.decideOnboardingIntake).not.toHaveBeenCalled();
  });

  it("rejects a validation_failed intake with validation errors", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.validationFailed,
      validationErrors: ["designation is required"]
    });

    repository.findOnboardingIntakeById.mockResolvedValue(intake);

    await expect(service.processOnboardingIntake(intake.id)).rejects.toBeInstanceOf(ConflictException);

    expect(repository.findSlackSourceMessageById).not.toHaveBeenCalled();
    expect(repository.createEmployeeForOnboarding).not.toHaveBeenCalled();
    expect(repository.createGoogleWorkspaceAccessRequestForOnboarding).not.toHaveBeenCalled();
  });

  it("returns an idempotent result when employee and access request already exist", async () => {
    const employee = makeEmployee();
    const accessRequest = makeAccessRequest({ employeeId: employee.id });
    const intake = makeOnboardingIntake({
      employeeId: employee.id,
      googleWorkspaceAccessRequestId: accessRequest.id,
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning
    });

    repository.findOnboardingIntakeById.mockResolvedValue(intake);
    repository.findSlackSourceMessageById.mockResolvedValue(makeSourceMessage());
    repository.findEmployeeById.mockResolvedValue(employee);
    repository.findAccessRequestById.mockResolvedValue(accessRequest);

    await expect(service.processOnboardingIntake(intake.id)).resolves.toEqual({
      employee,
      onboardingIntake: intake,
      googleWorkspaceAccessRequest: accessRequest
    });

    expect(repository.createEmployeeForOnboarding).not.toHaveBeenCalled();
    expect(repository.createGoogleWorkspaceAccessRequestForOnboarding).not.toHaveBeenCalled();
  });

  it("ignores Slack channel access when an approved intake is retried", async () => {
    const employee = makeEmployee();
    const accessRequest = makeAccessRequest({
      employeeId: employee.id,
      status: ACCESS_REQUEST_STATUS.approved
    });
    const accessTask = makeAccessTask({ accessRequestId: accessRequest.id });
    const slackWorkspaceAccessRequest = makeAccessRequest({
      id: "5c88c2da-2366-43b4-8d87-2a332dd19f6f",
      employeeId: employee.id,
      systemId: "dd9a3297-33d0-41ac-aec7-e4596ee7da30",
      resourceId: "ef37663c-21f2-4ab2-a85e-3aece830c268",
      roleId: "35db1d8a-7932-4c9e-9336-3c6343908086",
      status: ACCESS_REQUEST_STATUS.approved,
      reason: "Slack workspace membership required for onboarding"
    });
    const slackWorkspaceAccessTask = makeAccessTask({
      id: "959b92cd-00fd-4528-83f6-250fbc8e590d",
      accessRequestId: slackWorkspaceAccessRequest.id,
      connector: "slack",
      idempotencyKey: `grant:${employee.id}:slack:workspace_membership:member`
    });
    const intake = makeOnboardingIntake({
      employeeId: employee.id,
      googleWorkspaceAccessRequestId: accessRequest.id,
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning
    });
    const decision = makeOnboardingIntakeApproval();

    repository.findOnboardingIntakeById.mockResolvedValue(intake);
    repository.findSlackSourceMessageById.mockResolvedValue(makeSourceMessage());
    repository.findApprovedOnboardingIntakeDecision.mockResolvedValue(decision);
    repository.findEmployeeById.mockResolvedValue(employee);
    repository.findAccessRequestById.mockResolvedValue(accessRequest);
    repository.findAccessTaskByAccessRequestId.mockResolvedValue(accessTask);
    repository.findSlackWorkspaceMembershipAccessForOnboarding.mockResolvedValue({
      accessRequest: slackWorkspaceAccessRequest,
      accessTask: slackWorkspaceAccessTask
    });

    await expect(
      service.decideOnboardingIntake(intake.id, {
        decision: ONBOARDING_INTAKE_APPROVAL_DECISION.approved,
        approverExternalUserId: "slack:U999"
      })
    ).resolves.toEqual({
      onboardingIntake: intake,
      decision,
      employee,
      googleWorkspaceAccessRequest: accessRequest,
      accessTask,
      slackWorkspaceAccessRequest,
      slackWorkspaceAccessTask,
      slackChannelAccessRequests: [],
      slackChannelAccessTasks: [],
      nextAction: "execute_google_workspace_task"
    });

    expect(repository.decideOnboardingIntake).not.toHaveBeenCalled();
    expect(repository.listSlackChannelAccessForOnboarding).not.toHaveBeenCalled();
    expect(repository.findSlackWorkspaceMembershipAccessForOnboarding).toHaveBeenCalledWith({
      employeeId: employee.id,
      requestedSlackChannels: ["backend-alerts", "engineering"]
    });
  });

  it("returns onboarding status", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning,
      employeeId: "cc9e59fa-2e04-4317-b2ab-35438461b888"
    });
    const status = makeOnboardingStatus({ onboardingIntake: intake });

    repository.findOnboardingIntakeById.mockResolvedValue(intake);
    repository.getOnboardingStatus.mockResolvedValue(status);

    await expect(service.getOnboardingStatus(intake.id)).resolves.toEqual(status);

    expect(repository.getOnboardingStatus).toHaveBeenCalledWith(intake);
  });

  it("lists pending onboarding setups with incomplete Slack workspace membership", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning,
      employeeId: "cc9e59fa-2e04-4317-b2ab-35438461b888"
    });
    const employee = makeEmployee({ workEmail: "kartik.demo@caw.tech" });
    const status = makeOnboardingStatus({
      onboardingIntake: intake,
      employee,
      setupItems: [
        makeOnboardingSetupItem(),
        makeOnboardingSetupItem({
          system: { key: "slack", name: "Slack" },
          resource: { key: "workspace_membership", name: "Workspace Membership", resourceType: "workspace" },
          taskStatus: "pending",
          grantStatus: null
        })
      ]
    });

    repository.listOnboardingIntakes.mockResolvedValue([intake]);
    repository.getOnboardingStatus.mockResolvedValue(status);

    await expect(service.listPendingOnboardingSetups()).resolves.toEqual({
      pendingSetups: [{
        onboardingIntake: intake,
        employee,
        pendingCriticalSetup: ["Slack workspace membership"]
      }],
      count: 1
    });
  });

  it("does not list onboarding when only Slack channel follow-up is pending", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning,
      employeeId: "cc9e59fa-2e04-4317-b2ab-35438461b888"
    });
    const status = makeOnboardingStatus({
      onboardingIntake: intake,
      setupItems: [
        makeOnboardingSetupItem(),
        makeOnboardingSetupItem({
          system: { key: "slack", name: "Slack" },
          resource: { key: "workspace_membership", name: "Workspace Membership", resourceType: "workspace" }
        }),
        makeOnboardingSetupItem({
          system: { key: "slack", name: "Slack" },
          resource: { key: "general", name: "#general", resourceType: "channel" },
          taskStatus: "pending_dependency",
          grantStatus: null
        })
      ]
    });

    repository.listOnboardingIntakes.mockResolvedValue([intake]);
    repository.getOnboardingStatus.mockResolvedValue(status);

    await expect(service.listPendingOnboardingSetups()).resolves.toEqual({
      pendingSetups: [],
      count: 0
    });
  });

  it("lists completed setup with preboarding employee as ready to finalize in the work queue", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning,
      employeeId: "cc9e59fa-2e04-4317-b2ab-35438461b888"
    });
    const status = makeOnboardingStatus({
      onboardingIntake: intake,
      employee: makeEmployee({ status: EMPLOYEE_STATUS.preboarding }),
      setupItems: [
        makeOnboardingSetupItem(),
        makeOnboardingSetupItem({
          system: { key: "slack", name: "Slack" },
          resource: { key: "workspace_membership", name: "Slack Workspace Membership", resourceType: "workspace" }
        })
      ],
      summary: { total: 2, completed: 2, pending: 0, failed: 0 },
      canFinalize: true
    });

    repository.listOnboardingIntakes.mockResolvedValue([intake]);
    repository.getOnboardingStatus.mockResolvedValue(status);

    await expect(service.listOnboardingWorkQueue()).resolves.toEqual({
      items: [
        {
          ...status,
          category: "ready_to_finalize",
          validationErrors: []
        }
      ],
      count: 1
    });
  });

  it("finalizes onboarding by employee work email and returns invalid duplicates as warnings", async () => {
    const invalidIntake = makeOnboardingIntake({
      id: "bb1b5c16-55e9-4da3-aeb1-4e7b9c883d74",
      status: ONBOARDING_INTAKE_STATUS.validationFailed,
      designation: "VP of Engineering",
      validationErrors: ["designation is not approved for FTE employees"]
    });
    const validIntake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning,
      employeeId: "cc9e59fa-2e04-4317-b2ab-35438461b888"
    });
    const employee = makeEmployee({ workEmail: "kartik.demo@caw.tech" });
    const validStatus = makeOnboardingStatus({
      onboardingIntake: validIntake,
      employee,
      setupItems: [
        makeOnboardingSetupItem(),
        makeOnboardingSetupItem({
          system: { key: "slack", name: "Slack" },
          resource: { key: "workspace_membership", name: "Slack Workspace Membership", resourceType: "workspace" }
        })
      ],
      summary: { total: 2, completed: 2, pending: 0, failed: 0 },
      canFinalize: true
    });
    const invalidStatus = makeOnboardingStatus({
      onboardingIntake: invalidIntake,
      employee,
      setupItems: [],
      summary: { total: 0, completed: 0, pending: 0, failed: 0 },
      canFinalize: false
    });
    const finalizedStatus = makeOnboardingStatus({
      onboardingIntake: makeOnboardingIntake({
        ...validIntake,
        status: ONBOARDING_INTAKE_STATUS.completed
      }),
      employee: makeEmployee({ ...employee, status: EMPLOYEE_STATUS.active }),
      canFinalize: true
    });

    repository.findOnboardingIntakeCandidates.mockResolvedValue([invalidIntake, validIntake]);
    repository.getOnboardingStatus
      .mockResolvedValueOnce(invalidStatus)
      .mockResolvedValueOnce(validStatus)
      .mockResolvedValueOnce(validStatus)
      .mockResolvedValueOnce(finalizedStatus);
    repository.findOnboardingIntakeById.mockResolvedValue(validIntake);
    repository.finalizeOnboarding.mockResolvedValue({
      onboardingIntake: finalizedStatus.onboardingIntake,
      employee: finalizedStatus.employee
    });

    await expect(service.finalizeOnboardingByEmployee({ workEmail: "kartik.demo@caw.tech" })).resolves.toEqual({
      ...finalizedStatus,
      duplicateWarnings: [invalidIntake]
    });

    expect(repository.finalizeOnboarding).toHaveBeenCalledWith({
      onboardingIntake: validIntake,
      employee
    });
    expect(repository.findOnboardingIntakeCandidates).toHaveBeenCalledWith({
      onboardingIntakeId: undefined,
      employeeId: undefined,
      query: undefined,
      name: undefined,
      workEmail: "kartik.demo@caw.tech",
      personalEmail: undefined,
      designation: undefined,
      doj: undefined,
      limit: 200
    });
  });

  it("supersedes a validation-failed onboarding intake when the actor is authorized", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.validationFailed,
      validationErrors: ["designation is not approved for FTE employees"]
    });
    const superseded = makeOnboardingIntake({
      ...intake,
      status: ONBOARDING_INTAKE_STATUS.superseded
    });

    repository.findOnboardingIntakeById.mockResolvedValue(intake);
    repository.updateOnboardingIntakeStatus.mockResolvedValue(superseded);

    await expect(service.supersedeOnboardingIntake({
      onboardingIntakeId: intake.id,
      actorExternalUserId: "slack:U_ADMIN",
      reason: "corrected duplicate"
    })).resolves.toEqual({
      onboardingIntake: superseded
    });

    expect(approvalPolicyService.canAccessDiagnostics).toHaveBeenCalledWith({
      actorExternalUserId: "slack:U_ADMIN"
    });
    expect(repository.updateOnboardingIntakeStatus).toHaveBeenCalledWith({
      onboardingIntake: intake,
      status: ONBOARDING_INTAKE_STATUS.superseded,
      actorExternalUserId: "slack:U_ADMIN",
      reason: "corrected duplicate"
    });
  });

  it("cancels a waiting-for-review onboarding intake when the actor is authorized", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.waitingForReview
    });
    const cancelled = makeOnboardingIntake({
      ...intake,
      status: ONBOARDING_INTAKE_STATUS.cancelled
    });

    repository.findOnboardingIntakeById.mockResolvedValue(intake);
    repository.updateOnboardingIntakeStatus.mockResolvedValue(cancelled);

    await expect(service.cancelOnboardingIntake({
      onboardingIntakeId: intake.id,
      actorExternalUserId: "slack:U_ADMIN"
    })).resolves.toEqual({
      onboardingIntake: cancelled
    });

    expect(repository.updateOnboardingIntakeStatus).toHaveBeenCalledWith({
      onboardingIntake: intake,
      status: ONBOARDING_INTAKE_STATUS.cancelled,
      actorExternalUserId: "slack:U_ADMIN",
      reason: "cancelled_by_admin"
    });
  });

  it("requires an actor for onboarding cleanup", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.validationFailed
    });

    repository.findOnboardingIntakeById.mockResolvedValue(intake);

    await expect(service.supersedeOnboardingIntake({
      onboardingIntakeId: intake.id
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(approvalPolicyService.canAccessDiagnostics).not.toHaveBeenCalled();
    expect(repository.updateOnboardingIntakeStatus).not.toHaveBeenCalled();
  });

  it("denies onboarding cleanup when approval policy rejects the actor", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.validationFailed
    });

    repository.findOnboardingIntakeById.mockResolvedValue(intake);
    approvalPolicyService.canAccessDiagnostics.mockReturnValue({
      allowed: false,
      reason: "actor is not authorized for diagnostics"
    });

    await expect(service.supersedeOnboardingIntake({
      onboardingIntakeId: intake.id,
      actorExternalUserId: "slack:U_NOT_ADMIN"
    })).rejects.toBeInstanceOf(ForbiddenException);

    expect(repository.updateOnboardingIntakeStatus).not.toHaveBeenCalled();
  });

  it("does not supersede approved onboarding intakes", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.approved
    });

    repository.findOnboardingIntakeById.mockResolvedValue(intake);

    await expect(service.supersedeOnboardingIntake({
      onboardingIntakeId: intake.id,
      actorExternalUserId: "slack:U_ADMIN"
    })).rejects.toBeInstanceOf(ConflictException);

    expect(repository.updateOnboardingIntakeStatus).not.toHaveBeenCalled();
  });

  it("does not cancel onboarding intakes after employee or access setup has started", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.waitingForReview,
      employeeId: "cc9e59fa-2e04-4317-b2ab-35438461b888"
    });

    repository.findOnboardingIntakeById.mockResolvedValue(intake);

    await expect(service.cancelOnboardingIntake({
      onboardingIntakeId: intake.id,
      actorExternalUserId: "slack:U_ADMIN"
    })).rejects.toBeInstanceOf(ConflictException);

    expect(repository.updateOnboardingIntakeStatus).not.toHaveBeenCalled();
  });

  it("continues onboarding setup from Slack workspace when Google is already complete", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning,
      employeeId: "cc9e59fa-2e04-4317-b2ab-35438461b888"
    });
    const employee = makeEmployee({
      workEmail: "kartik.demo@caw.tech"
    });
    const googleComplete = makeOnboardingSetupItem({
      accessTaskId: "11111111-1111-4111-8111-111111111111",
      system: { key: "google_workspace", name: "Google Workspace" },
      resource: { key: "company_email", name: "Company Email", resourceType: "account" },
      taskStatus: "completed",
      grantStatus: "active"
    });
    const slackPending = makeOnboardingSetupItem({
      accessTaskId: "22222222-2222-4222-8222-222222222222",
      system: { key: "slack", name: "Slack" },
      resource: { key: "workspace_membership", name: "Workspace Membership", resourceType: "workspace" },
      taskStatus: "pending",
      grantStatus: "pending"
    });
    const slackComplete = {
      ...slackPending,
      taskStatus: "completed",
      grantStatus: "active"
    };
    const pendingStatus = makeOnboardingStatus({
      onboardingIntake: intake,
      employee,
      setupItems: [googleComplete, slackPending],
      canFinalize: false
    });
    const readyToFinalizeStatus = makeOnboardingStatus({
      onboardingIntake: intake,
      employee,
      setupItems: [googleComplete, slackComplete],
      canFinalize: true
    });
    const completedIntake = makeOnboardingIntake({
      ...intake,
      status: ONBOARDING_INTAKE_STATUS.completed
    });
    const finalizedStatus = makeOnboardingStatus({
      onboardingIntake: completedIntake,
      employee: makeEmployee({ status: EMPLOYEE_STATUS.active, workEmail: "kartik.demo@caw.tech" }),
      setupItems: [googleComplete, slackComplete],
      canFinalize: true
    });

    repository.findOnboardingIntakeById.mockResolvedValue(intake);
    repository.getOnboardingStatus
      .mockResolvedValueOnce(pendingStatus)
      .mockResolvedValueOnce(pendingStatus)
      .mockResolvedValueOnce(readyToFinalizeStatus)
      .mockResolvedValueOnce(readyToFinalizeStatus)
      .mockResolvedValueOnce(finalizedStatus);
    repository.finalizeOnboarding.mockResolvedValue({
      onboardingIntake: completedIntake,
      employee: finalizedStatus.employee
    });
    accessTaskExecutorService.executeAccessTask.mockResolvedValue({
      task: { id: slackPending.accessTaskId },
      grant: { id: "33333333-3333-4333-8333-333333333333" }
    });

    await expect(service.continueOnboardingSetup(intake.id)).resolves.toMatchObject({
      onboardingIntake: completedIntake,
      executedTasks: [{ task: { id: slackPending.accessTaskId } }],
      executionErrors: [],
      finalized: true
    });

    expect(accessTaskExecutorService.executeAccessTask).toHaveBeenCalledTimes(1);
    expect(accessTaskExecutorService.executeAccessTask).toHaveBeenCalledWith(slackPending.accessTaskId);
    expect(repository.finalizeOnboarding).toHaveBeenCalledWith({
      onboardingIntake: intake,
      employee
    });
  });

  it("returns completed onboarding status without re-finalizing", async () => {
    const completedIntake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.completed,
      employeeId: "cc9e59fa-2e04-4317-b2ab-35438461b888"
    });
    const completedStatus = makeOnboardingStatus({
      onboardingIntake: completedIntake,
      employee: makeEmployee({ status: EMPLOYEE_STATUS.active }),
      canFinalize: true
    });

    repository.findOnboardingIntakeById.mockResolvedValue(completedIntake);
    repository.getOnboardingStatus.mockResolvedValue(completedStatus);

    await expect(service.continueOnboardingSetup(completedIntake.id)).resolves.toEqual({
      ...completedStatus,
      executedTasks: [],
      executionErrors: [],
      finalized: true
    });

    expect(accessTaskExecutorService.executeAccessTask).not.toHaveBeenCalled();
    expect(repository.finalizeOnboarding).not.toHaveBeenCalled();
  });

  it("returns success when the access task executor auto-finalizes onboarding", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning,
      employeeId: "cc9e59fa-2e04-4317-b2ab-35438461b888"
    });
    const employee = makeEmployee({ status: EMPLOYEE_STATUS.preboarding });
    const googleComplete = makeOnboardingSetupItem({
      system: { key: "google_workspace", name: "Google Workspace" },
      resource: { key: "company_email", name: "Company Email", resourceType: "account" },
      taskStatus: "completed",
      grantStatus: "active"
    });
    const slackPending = makeOnboardingSetupItem({
      accessTaskId: "22222222-2222-4222-8222-222222222222",
      system: { key: "slack", name: "Slack" },
      resource: { key: "workspace_membership", name: "Workspace Membership", resourceType: "workspace" },
      taskStatus: "pending",
      grantStatus: "pending"
    });
    const completedIntake = makeOnboardingIntake({
      ...intake,
      status: ONBOARDING_INTAKE_STATUS.completed
    });
    const completedStatus = makeOnboardingStatus({
      onboardingIntake: completedIntake,
      employee: makeEmployee({ status: EMPLOYEE_STATUS.active }),
      setupItems: [
        googleComplete,
        {
          ...slackPending,
          taskStatus: "completed",
          grantStatus: "active"
        }
      ],
      canFinalize: true
    });

    repository.findOnboardingIntakeById
      .mockResolvedValueOnce(intake)
      .mockResolvedValueOnce(intake)
      .mockResolvedValueOnce(intake)
      .mockResolvedValueOnce(completedIntake);
    repository.getOnboardingStatus
      .mockResolvedValueOnce(makeOnboardingStatus({
        onboardingIntake: intake,
        employee,
        setupItems: [googleComplete, slackPending],
        canFinalize: false
      }))
      .mockResolvedValueOnce(makeOnboardingStatus({
        onboardingIntake: intake,
        employee,
        setupItems: [googleComplete, slackPending],
        canFinalize: false
      }))
      .mockResolvedValueOnce(completedStatus);
    accessTaskExecutorService.executeAccessTask.mockResolvedValue({
      task: { id: slackPending.accessTaskId },
      grant: { id: "33333333-3333-4333-8333-333333333333" }
    });

    await expect(service.continueOnboardingSetup(intake.id)).resolves.toMatchObject({
      onboardingIntake: completedIntake,
      executedTasks: [{ task: { id: slackPending.accessTaskId } }],
      executionErrors: [],
      finalized: true
    });

    expect(repository.finalizeOnboarding).not.toHaveBeenCalled();
  });

  it("returns recoverable setup status when onboarding task execution fails", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning,
      employeeId: "cc9e59fa-2e04-4317-b2ab-35438461b888"
    });
    const employee = makeEmployee({ status: EMPLOYEE_STATUS.preboarding });
    const googleComplete = makeOnboardingSetupItem({
      system: { key: "google_workspace", name: "Google Workspace" },
      resource: { key: "company_email", name: "Company Email", resourceType: "account" },
      taskStatus: "completed",
      grantStatus: "active"
    });
    const slackPending = makeOnboardingSetupItem({
      accessTaskId: "22222222-2222-4222-8222-222222222222",
      system: { key: "slack", name: "Slack" },
      resource: { key: "workspace_membership", name: "Workspace Membership", resourceType: "workspace" },
      taskStatus: "pending",
      grantStatus: "pending"
    });
    const failedStatus = makeOnboardingStatus({
      onboardingIntake: intake,
      employee,
      setupItems: [
        googleComplete,
        {
          ...slackPending,
          taskStatus: "failed",
          taskErrorMessage: "Slack browser invite did not submit the workspace invite.",
          grantStatus: null
        }
      ],
      summary: {
        total: 2,
        completed: 1,
        pending: 0,
        failed: 1
      },
      canFinalize: false
    });

    repository.findOnboardingIntakeById.mockResolvedValue(intake);
    repository.getOnboardingStatus
      .mockResolvedValueOnce(makeOnboardingStatus({
        onboardingIntake: intake,
        employee,
        setupItems: [googleComplete, slackPending],
        canFinalize: false
      }))
      .mockResolvedValueOnce(makeOnboardingStatus({
        onboardingIntake: intake,
        employee,
        setupItems: [googleComplete, slackPending],
        canFinalize: false
      }))
      .mockResolvedValueOnce(failedStatus);
    accessTaskExecutorService.executeAccessTask.mockRejectedValue(new Error("Slack browser invite did not submit the workspace invite."));

    await expect(service.continueOnboardingSetup(intake.id)).resolves.toMatchObject({
      onboardingIntake: intake,
      executedTasks: [],
      executionErrors: [{
        accessTaskId: slackPending.accessTaskId,
        message: "Slack browser invite did not submit the workspace invite."
      }],
      finalized: false
    });

    expect(repository.finalizeOnboarding).not.toHaveBeenCalled();
  });

  it("auto-processes valid Slack onboarding using initial-message authority without approval policy", async () => {
    const sourceMessage = makeSourceMessage();
    const intake = makeOnboardingIntake();
    const employee = makeEmployee({ status: EMPLOYEE_STATUS.active, workEmail: "riya.sharma@caw.tech" });
    const accessRequest = makeAccessRequest({ employeeId: employee.id, status: ACCESS_REQUEST_STATUS.approved });
    const accessTask = makeAccessTask({ accessRequestId: accessRequest.id });
    const approvedIntake = makeOnboardingIntake({
      ...intake,
      employeeId: employee.id,
      googleWorkspaceAccessRequestId: accessRequest.id,
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning
    });
    const completedIntake = makeOnboardingIntake({
      ...approvedIntake,
      status: ONBOARDING_INTAKE_STATUS.completed
    });
    const authorityDecision = {
      onboardingIntake: approvedIntake,
      decision: makeOnboardingIntakeApproval({
        approverExternalUserId: sourceMessage.senderExternalUserId!,
        source: "slack_initial_message_authority",
        comment: "Initial Slack lifecycle message accepted as authority."
      }),
      employee,
      googleWorkspaceAccessRequest: accessRequest,
      accessTask,
      slackWorkspaceAccessRequest: null,
      slackWorkspaceAccessTask: null,
      slackChannelAccessRequests: [],
      slackChannelAccessTasks: [],
      nextAction: "execute_google_workspace_task" as const
    };
    const completedStatus = makeOnboardingStatus({
      onboardingIntake: completedIntake,
      employee,
      setupItems: [
        makeOnboardingSetupItem(),
        makeOnboardingSetupItem({
          accessTaskId: "22222222-2222-4222-8222-222222222222",
          system: { key: "slack", name: "Slack" },
          resource: { key: "workspace_membership", name: "Workspace Membership", resourceType: "workspace" },
          taskStatus: "completed",
          grantStatus: "active"
        })
      ],
      canFinalize: true
    });

    repository.upsertSlackSourceMessage.mockResolvedValue(sourceMessage);
    repository.findOnboardingIntakeBySourceMessageId.mockResolvedValue(undefined);
    parserService.parse.mockReturnValue(makeParseResult());
    validationService.validate.mockResolvedValue(makeValidationResult());
    repository.findOpenOnboardingIntakeByPersonalEmail.mockResolvedValue(undefined);
    repository.supersedeValidationFailedIntakesByPersonalEmail.mockResolvedValue(undefined);
    repository.createOnboardingIntake.mockResolvedValue({
      sourceMessage,
      onboardingIntake: intake
    });
    repository.findOnboardingIntakeById
      .mockResolvedValueOnce(intake)
      .mockResolvedValue(approvedIntake);
    repository.findSlackSourceMessageById.mockResolvedValue(sourceMessage);
    repository.findApprovedOnboardingIntakeDecision.mockResolvedValue(undefined);
    repository.decideOnboardingIntake.mockResolvedValue(authorityDecision);
    repository.getOnboardingStatus.mockResolvedValue(completedStatus);

    await expect(service.autoProcessSlackOnboardingIntake(makePayload())).resolves.toMatchObject({
      valid: true,
      authorityDecision,
      setup: {
        onboardingIntake: completedIntake,
        finalized: true
      },
      nextAction: "setup_complete"
    });

    expect(approvalPolicyService.canApproveExternalActor).not.toHaveBeenCalled();
    expect(repository.decideOnboardingIntake).toHaveBeenCalledWith(expect.objectContaining({
      approverExternalUserId: "slack:U123",
      source: "slack_initial_message_authority",
      decision: ONBOARDING_INTAKE_APPROVAL_DECISION.approved
    }));
  });

  it("does not finalize onboarding while setup tasks are pending", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning,
      employeeId: "cc9e59fa-2e04-4317-b2ab-35438461b888"
    });
    const status = makeOnboardingStatus({
      onboardingIntake: intake,
      canFinalize: false,
      summary: {
        total: 1,
        completed: 0,
        pending: 1,
        failed: 0
      }
    });

    repository.findOnboardingIntakeById.mockResolvedValue(intake);
    repository.getOnboardingStatus.mockResolvedValue(status);

    await expect(service.finalizeOnboarding(intake.id)).rejects.toBeInstanceOf(ConflictException);

    expect(repository.finalizeOnboarding).not.toHaveBeenCalled();
  });

  it("rejects finalization from invalid lifecycle states", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.rejected,
      employeeId: "cc9e59fa-2e04-4317-b2ab-35438461b888"
    });

    repository.findOnboardingIntakeById.mockResolvedValue(intake);

    await expect(service.finalizeOnboarding(intake.id)).rejects.toBeInstanceOf(ConflictException);

    expect(repository.getOnboardingStatus).not.toHaveBeenCalled();
    expect(repository.finalizeOnboarding).not.toHaveBeenCalled();
  });

  it("finalizes onboarding and returns refreshed active status when setup is complete", async () => {
    const intake = makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning,
      employeeId: "cc9e59fa-2e04-4317-b2ab-35438461b888"
    });
    const employee = makeEmployee({
      workEmail: "riya.sharma@caw.tech"
    });
    const readyStatus = makeOnboardingStatus({
      onboardingIntake: intake,
      employee,
      canFinalize: true,
      summary: {
        total: 1,
        completed: 1,
        pending: 0,
        failed: 0
      }
    });
    const completedIntake = makeOnboardingIntake({
      ...intake,
      status: ONBOARDING_INTAKE_STATUS.completed
    });
    const activeEmployee = makeEmployee({
      status: EMPLOYEE_STATUS.active,
      workEmail: "riya.sharma@caw.tech"
    });
    const finalizedStatus = makeOnboardingStatus({
      onboardingIntake: completedIntake,
      employee: activeEmployee,
      canFinalize: true,
      summary: {
        total: 1,
        completed: 1,
        pending: 0,
        failed: 0
      }
    });

    repository.findOnboardingIntakeById.mockResolvedValue(intake);
    repository.getOnboardingStatus.mockResolvedValueOnce(readyStatus).mockResolvedValueOnce(finalizedStatus);
    repository.finalizeOnboarding.mockResolvedValue({
      onboardingIntake: completedIntake,
      employee: activeEmployee
    });

    await expect(service.finalizeOnboarding(intake.id)).resolves.toEqual(finalizedStatus);

    expect(repository.finalizeOnboarding).toHaveBeenCalledWith({
      onboardingIntake: intake,
      employee
    });
    expect(repository.getOnboardingStatus).toHaveBeenLastCalledWith(completedIntake);
  });

  it("returns not found for invalid or missing intake ids", async () => {
    await expect(service.processOnboardingIntake("not-a-uuid")).rejects.toBeInstanceOf(NotFoundException);

    repository.findOnboardingIntakeById.mockResolvedValue(undefined);

    await expect(service.processOnboardingIntake("08eebdd5-c91d-4ef0-8927-89346898ca19")).rejects.toBeInstanceOf(
      NotFoundException
    );
  });
});

function makePayload() {
  return {
    workspaceId: "T123",
    channelId: "C123",
    messageTs: "1710000000.000000",
    threadTs: "1710000000.000000",
    senderSlackUserId: "U123",
    rawText: "New Joiner Alert\nName: Riya Sharma"
  };
}

function makeSourceMessage(overrides: Partial<SlackSourceMessage> = {}): SlackSourceMessage {
  return {
    id: "36efa7e4-e73b-4414-8d56-9e2a5c72c6fb",
    provider: "slack",
    workspaceId: "T123",
    channelId: "C123",
    messageTs: "1710000000.000000",
    threadTs: "1710000000.000000",
    senderExternalUserId: "slack:U123",
    rawText: "New Joiner Alert\nName: Riya Sharma",
    detectedType: "new_joiner_alert",
    processedStatus: "received",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeOnboardingIntake(overrides: Partial<OnboardingIntake> = {}): OnboardingIntake {
  return {
    id: "08eebdd5-c91d-4ef0-8927-89346898ca19",
    sourceMessageId: "36efa7e4-e73b-4414-8d56-9e2a5c72c6fb",
    employeeId: null,
    googleWorkspaceAccessRequestId: null,
    name: "Riya Sharma",
    personalEmail: "riya.personal@example.com",
    contactNo: "+91 9876543210",
    doj: "2026-07-01",
    employmentType: "fte",
    designation: "Backend Engineer",
    laptop: "MacBook Pro",
    relocation: "No",
    requestedSlackChannels: ["backend-alerts", "engineering"],
    validationErrors: [],
    status: ONBOARDING_INTAKE_STATUS.waitingForReview,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "cc9e59fa-2e04-4317-b2ab-35438461b888",
    fullName: "Riya Sharma",
    workEmail: null,
    personalEmail: "riya.personal@example.com",
    contactNo: "+91 9876543210",
    employmentType: "fte",
    designation: "Backend Engineer",
    department: null,
    status: EMPLOYEE_STATUS.preboarding,
    startDate: "2026-07-01",
    endDate: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeAccessRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    id: "7a49574e-287c-4d2b-9583-14a4a425df5d",
    employeeId: "cc9e59fa-2e04-4317-b2ab-35438461b888",
    systemId: "4d4659d9-5f9a-4ffb-9d8e-d35715ed4f9d",
    resourceId: "fc475b10-4b1f-4685-8a50-a4bd898eac2f",
    roleId: "51f04689-d1c5-4185-a6ce-d418c1ad323f",
    action: ACCESS_REQUEST_ACTION.grant,
    status: ACCESS_REQUEST_STATUS.waitingForApproval,
    reason: "Company email required for onboarding",
    requestedByExternalUserId: "slack:U123",
    requestedFrom: "onboarding_intake",
    sourceConversationId: null,
    sourceMessageId: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeOnboardingIntakeApproval(
  overrides: Partial<OnboardingIntakeApproval> = {}
): OnboardingIntakeApproval {
  return {
    id: "e7bd5ace-8621-4850-9665-12364a1b6155",
    onboardingIntakeId: "08eebdd5-c91d-4ef0-8927-89346898ca19",
    approverExternalUserId: "slack:U999",
    decision: ONBOARDING_INTAKE_APPROVAL_DECISION.approved,
    comment: "Approved",
    source: "slack",
    gantryConversationId: null,
    gantryRuntimeEventId: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeAccessTask(overrides: Partial<AccessTask> = {}): AccessTask {
  return {
    id: "fb65e3ec-9c15-44ce-92f9-b318c741be38",
    accessRequestId: "7a49574e-287c-4d2b-9583-14a4a425df5d",
    operation: ACCESS_REQUEST_ACTION.grant,
    connector: "google_workspace",
    status: "pending_manual",
    idempotencyKey: "grant:cc9e59fa-2e04-4317-b2ab-35438461b888:google_workspace:company_email:user",
    attemptCount: 0,
    externalResultJson: null,
    errorMessage: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeOnboardingStatus(overrides: Record<string, unknown> = {}) {
  const employee = makeEmployee();

  return {
    onboardingIntake: makeOnboardingIntake({
      status: ONBOARDING_INTAKE_STATUS.readyForProvisioning,
      employeeId: employee.id
    }),
    employee,
    summary: {
      total: 1,
      completed: 0,
      pending: 1,
      failed: 0
    },
    setupItems: [makeOnboardingSetupItem()],
    canFinalize: false,
    ...overrides
  };
}

function makeOnboardingSetupItem(overrides: Record<string, unknown> = {}) {
  return {
    accessRequestId: "7a49574e-287c-4d2b-9583-14a4a425df5d",
    accessTaskId: "fb65e3ec-9c15-44ce-92f9-b318c741be38",
    system: {
      key: "google_workspace",
      name: "Google Workspace"
    },
    resource: {
      key: "company_email",
      name: "Company Email",
      resourceType: "account"
    },
    role: {
      key: "user",
      name: "User"
    },
    requestStatus: ACCESS_REQUEST_STATUS.completed,
    taskStatus: "completed",
    taskErrorMessage: null,
    grantStatus: "active",
    required: true,
    ...overrides
  };
}

function makeParseResult(overrides: Partial<ParsedOnboardingFields> = {}) {
  return {
    detectedType: "new_joiner_alert" as const,
    fields: {
      name: "Riya Sharma",
      personalEmail: "riya.personal@example.com",
      contactNo: "+91 9876543210",
      doj: "2026-07-01",
      employmentType: "fte" as const,
      designation: "Backend Engineer",
      laptop: "MacBook Pro",
      relocation: "No",
      slackChannels: ["backend-alerts", "engineering"],
      ...overrides
    },
    missingFields: [],
    parseErrors: []
  };
}

function makeValidationResult(overrides: Partial<Awaited<ReturnType<OnboardingValidationService["validate"]>>> = {}) {
  return {
    valid: true,
    normalized: {
      name: "Riya Sharma",
      personalEmail: "riya.personal@example.com",
      contactNo: "+91 9876543210",
      doj: "2026-07-01",
      employmentType: "fte" as const,
      designation: "Backend Engineer",
      laptop: "MacBook Pro",
      relocation: "No",
      slackChannels: ["backend-alerts", "engineering"]
    },
    validationErrors: [],
    ...overrides
  };
}
