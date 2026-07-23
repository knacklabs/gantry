import { describe, expect, it, vi } from 'vitest';

import {
  buildAccessDetailReportResponse,
  buildAutoProcessOffboardingResponse,
  buildAutoProcessOffboardingFromSlackMessageResponse,
  buildAutoProcessOnboardingResponse,
  buildCreateAccessRequestResponse,
  buildConfigHealthResponse,
  buildConnectorHealthResponse,
  buildContinueOnboardingSetupResponse,
  buildCreateOnboardingIntakeResponse,
  buildCreateOffboardingIntakeResponse,
  buildDecideOnboardingIntakeResponse,
  buildDecideOffboardingIntakeResponse,
  buildFinalizeOnboardingResponse,
  buildFinalizeOnboardingByEmployeeResponse,
  buildFinalizeOffboardingResponse,
  buildGetOnboardingIntakeResponse,
  buildListEmployeesResponse,
  buildListEmployeesWithOnboardingIntakesResponse,
  buildListOnboardingIntakesResponse,
  buildListOnboardingWorkQueueResponse,
  buildListPendingOnboardingSetupsResponse,
  buildOnboardingIntakeStatusChangeResponse,
  buildRecentFailedAccessTasksResponse,
  buildResolveEmployeeResponse,
  sanitizeUserFacingToolText,
  buildTaskStatusDiagnosticsResponse,
  buildOnboardingStatusResponse,
  buildSearchAccessGrantsResponse,
  parseOffboardingAlert,
  processOffboardingAlertSlackMessage,
  shouldAutoProcessOffboardingSlackMessage,
  shouldAutoProcessOnboardingSlackMessage,
} from '@core/integrations/itops/itops-tools.js';

describe('user-facing tool response safety', () => {
  it('strips formatter instruction prefaces before returning tool text', () => {
    expect(
      sanitizeUserFacingToolText(
        [
          'Use this exact Slack response style. Do not add internal details.',
          '',
          '*Task status*',
          '',
          'No access tasks found.',
        ].join('\n'),
      ),
    ).toBe('*Task status*\n\nNo access tasks found.');

    expect(
      sanitizeUserFacingToolText(
        [
          'Use only this Slack response block. Do not add process narration.',
          '',
          '*Onboarding complete*',
        ].join('\n'),
      ),
    ).toBe('*Onboarding complete*');
  });

  it('does not include formatter instructions in representative Slack responses', () => {
    const responses = [
      buildCreateAccessRequestResponse({
        action: 'grant',
        status: 'waiting_for_approval',
        systemKey: 'slack',
        resourceKey: 'workspace_membership',
        roleKey: 'member',
      }),
      buildTaskStatusDiagnosticsResponse({ tasks: [] }),
      buildAutoProcessOnboardingResponse({
        valid: true,
        nextAction: 'setup_complete',
        setup: makeOnboardingStatusResult({
          finalized: true,
          employee: {
            fullName: 'Riya Sharma',
            workEmail: 'riya.sharma@caw.tech',
            status: 'active',
          },
        }),
      }),
      buildAutoProcessOffboardingResponse({
        finalized: true,
        finalStatus: {
          employee: {
            fullName: 'Riya Sharma',
            workEmail: 'riya.sharma@caw.tech',
            status: 'offboarded',
          },
          revokeItems: [],
          summary: {
            total: 0,
            completed: 0,
            pending: 0,
            failed: 0,
          },
        },
      }),
    ];

    for (const response of responses) {
      expect(response).toBeDefined();
      expect(response).not.toContain('Use this exact Slack response style');
      expect(response).not.toContain('Use only this Slack response block');
    }
  });
});

describe('shouldAutoProcessOnboardingSlackMessage', () => {
  it('redirects New Joiner Alert manual tool calls to the auto lifecycle path', () => {
    expect(
      shouldAutoProcessOnboardingSlackMessage({
        rawText: 'New Joiner Alert\nName: Test Auto Onboarding',
      }),
    ).toBe(true);

    expect(
      shouldAutoProcessOnboardingSlackMessage({
        rawText: 'new   joiner   alert\nName: Test Auto Onboarding',
      }),
    ).toBe(true);
  });

  it('preserves explicit manual recovery calls', () => {
    expect(
      shouldAutoProcessOnboardingSlackMessage({
        manualRecovery: true,
        rawText: 'New Joiner Alert\nName: Test Auto Onboarding',
      }),
    ).toBe(false);
  });
});

describe('offboarding alert parsing', () => {
  it('detects and parses the final Offboarding Alert template', () => {
    const result = parseOffboardingAlert(
      [
        'Offboarding Alert',
        'Name: Riya Sharma',
        ' Work Email: riya.sharma@caw.tech',
        ' Last Working Day: 2026-07-31',
      ].join('\n'),
    );

    expect(
      shouldAutoProcessOffboardingSlackMessage({
        rawText: 'Offboarding Alert',
      }),
    ).toBe(true);
    expect(result).toEqual({
      detectedType: 'offboarding_alert',
      fields: {
        name: 'Riya Sharma',
        workEmail: 'riya.sharma@caw.tech',
        lastWorkingDay: '2026-07-31',
      },
      missingFields: [],
      parseErrors: [],
    });
  });

  it('accepts the common Offboarding Aler typo and Slack-flattened mailto text', () => {
    const result = parseOffboardingAlert(
      'Offboarding Aler Name: Riya Sharma Work Email: <mailto:RIYA.SHARMA@CAW.TECH|riya.sharma@caw.tech> Last Working Day: 2026-07-31',
    );

    expect(
      shouldAutoProcessOffboardingSlackMessage({ rawText: 'Offboarding Aler' }),
    ).toBe(true);
    expect(result.fields).toEqual({
      name: 'Riya Sharma',
      workEmail: 'riya.sharma@caw.tech',
      lastWorkingDay: '2026-07-31',
    });
    expect(result.missingFields).toEqual([]);
    expect(result.parseErrors).toEqual([]);
  });

  it('reports missing and invalid Offboarding Alert fields', () => {
    const result = parseOffboardingAlert(
      [
        'Offboarding Alert',
        'Name: Riya Sharma',
        'Last Working Day: 07/31/2026',
      ].join('\n'),
    );

    expect(result.missingFields).toEqual(['Work Email']);
    expect(result.parseErrors).toEqual([
      'Last Working Day must use YYYY-MM-DD format.',
    ]);
  });
});

describe('processOffboardingAlertSlackMessage', () => {
  it('resolves by work email and auto-processes with alert metadata', async () => {
    const client = makeOffboardingAlertClient();

    client.resolveEmployee.mockResolvedValue(
      makeResolvedEmployee({
        fullName: 'Riya S Sharma',
      }),
    );
    client.autoProcessOffboarding.mockResolvedValue(
      makeAutoProcessedOffboardingResult(),
    );

    await expect(
      processOffboardingAlertSlackMessage(
        {
          workspaceId: 'T123',
          channelId: 'C123',
          messageTs: '1710000000.000100',
          threadTs: '1710000000.000100',
          senderExternalUserId: 'slack:U123',
          rawText: [
            'Offboarding Alert',
            'Name: Riya Sharma',
            'Work Email: riya.sharma@caw.tech',
            'Last Working Day: 2026-07-31',
          ].join('\n'),
        },
        client,
      ),
    ).resolves.toMatchObject({
      kind: 'offboarding_alert_processed',
    });

    expect(client.resolveEmployee).toHaveBeenCalledWith({
      query: 'riya.sharma@caw.tech',
      purpose: 'offboarding',
    });
    expect(client.autoProcessOffboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: 'employee_riya',
        lastWorkingDay: '2026-07-31',
        requestedByExternalUserId: 'slack:U123',
        notes: expect.stringContaining('Alert name: Riya Sharma'),
      }),
    );
    expect(client.autoProcessOffboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        notes: expect.stringContaining('Slack workspace: T123'),
      }),
    );
    expect(client.autoProcessOffboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        notes: expect.stringContaining('Slack message ts: 1710000000.000100'),
      }),
    );
  });

  it('does not auto-process invalid alerts', async () => {
    const client = makeOffboardingAlertClient();

    await expect(
      processOffboardingAlertSlackMessage(
        {
          rawText: [
            'Offboarding Alert',
            'Name: Riya Sharma',
            'Last Working Day: 07/31/2026',
          ].join('\n'),
        },
        client,
      ),
    ).resolves.toMatchObject({
      kind: 'offboarding_alert_validation_error',
    });

    expect(client.resolveEmployee).not.toHaveBeenCalled();
    expect(client.autoProcessOffboarding).not.toHaveBeenCalled();
  });

  it('does not auto-process when the work email cannot be resolved', async () => {
    const client = makeOffboardingAlertClient();

    client.resolveEmployee.mockResolvedValue({
      status: 'not_found',
      query: 'riya.sharma@caw.tech',
      purpose: 'offboarding',
      employee: null,
      matches: [],
    });

    await expect(
      processOffboardingAlertSlackMessage(makeOffboardingAlertText(), client),
    ).resolves.toMatchObject({
      kind: 'offboarding_alert_resolution_error',
    });

    expect(client.autoProcessOffboarding).not.toHaveBeenCalled();
  });

  it('allows small name differences when work email resolves exactly', async () => {
    const client = makeOffboardingAlertClient();

    client.resolveEmployee.mockResolvedValue(
      makeResolvedEmployee({
        fullName: 'Riya S Sharma',
      }),
    );
    client.autoProcessOffboarding.mockResolvedValue(
      makeAutoProcessedOffboardingResult(),
    );

    await expect(
      processOffboardingAlertSlackMessage(makeOffboardingAlertText(), client),
    ).resolves.toMatchObject({
      kind: 'offboarding_alert_processed',
    });
    expect(client.autoProcessOffboarding).toHaveBeenCalledTimes(1);
  });

  it('blocks clearly unrelated alert names', async () => {
    const client = makeOffboardingAlertClient();

    client.resolveEmployee.mockResolvedValue(
      makeResolvedEmployee({
        fullName: 'Priya Sharma',
      }),
    );

    await expect(
      processOffboardingAlertSlackMessage(makeOffboardingAlertText(), client),
    ).resolves.toMatchObject({
      kind: 'offboarding_alert_name_mismatch',
    });
    expect(client.autoProcessOffboarding).not.toHaveBeenCalled();
  });
});

describe('buildAutoProcessOnboardingResponse', () => {
  it('formats completed lifecycle onboarding without approval wait text', () => {
    const response = buildAutoProcessOnboardingResponse({
      valid: true,
      nextAction: 'setup_complete',
      onboardingIntake: {
        name: 'Riya Sharma',
      },
      setup: makeOnboardingStatusResult({
        finalized: true,
        onboardingIntake: {
          requestedSlackChannels: [],
        },
        employee: {
          fullName: 'Riya Sharma',
          workEmail: 'riya.sharma@caw.tech',
          status: 'active',
        },
      }),
    });

    expect(response).not.toContain('*Onboarding complete*');
    expect(response).toContain('Done, Riya Sharma is set up.');
    expect(response).toContain('I created the company email.');
    expect(response).toContain('riya.sharma@caw.tech');
    expect(response).not.toContain('waiting for admin approval');
    expect(response).not.toContain('Let me');
    expect(response).not.toContain('Done -');
    expect(response).not.toContain('ready from the account setup side');
    expect(response).not.toContain('Work email:');
    expect(response).not.toContain('I’ve noted');
    expect(response).not.toContain('*Onboarding in progress*');
    expect(response).not.toContain('*Done*');
    expect(response).not.toContain('*Still pending*');
  });

  it('formats existing onboarding retry failure without report headings or retry question', () => {
    const response = buildAutoProcessOnboardingResponse({
      created: false,
      valid: true,
      nextAction: 'setup_pending',
      onboardingIntake: {
        name: 'Test Auto Onboarding Two',
      },
      setup: makeOnboardingStatusResult({
        finalized: false,
        onboardingIntake: {
          requestedSlackChannels: ['engineering-team-1'],
        },
        employee: {
          fullName: 'Test Auto Onboarding Two',
          workEmail: 'test.two@caw.tech',
          status: 'preboarding',
        },
        setupItems: [
          makeOnboardingSetupItem({
            taskStatus: 'completed',
            grantStatus: 'active',
          }),
          makeOnboardingSetupItem({
            system: {
              key: 'slack',
              name: 'Slack',
            },
            resource: {
              key: 'workspace_membership',
              name: 'Workspace Membership',
              resourceType: 'workspace',
            },
            taskStatus: 'failed',
            taskErrorMessage:
              'Slack browser invite confirmation was not shown after submitting.',
            grantStatus: null,
          }),
        ],
        executionErrors: [
          {
            accessTaskId: '3155feeb-f028-48a9-bce5-2b6274a839c2',
            message:
              'Slack browser invite confirmation was not shown after submitting.',
          },
        ],
      }),
    });

    expect(response).not.toContain('*Onboarding needs attention*');
    expect(response).toContain(
      'I found the existing onboarding for Test Auto Onboarding Two and retried the setup, but Slack still needs attention.',
    );
    expect(response).toContain(
      'Google Workspace is done. Slack invite still failed, so the employee is not active yet.',
    );
    expect(response).toContain('Their work email is test.two@caw.tech.');
    expect(response).toContain(
      "I haven't added them to #engineering-team-1 yet.",
    );
    expect(response).toContain(
      'I need the Slack workspace invite to be completed before channel access can start.',
    );
    expect(response).not.toContain('Once they accept the Slack invite');
    expect(response).toContain(
      'I can retry after the Slack invite issue is fixed.',
    );
    expect(response).not.toContain('*Onboarding request already exists*');
    expect(response).not.toContain('*Setup status*');
    expect(response).not.toContain('*Where it stands*');
    expect(response).not.toContain('Should I retry');
    expect(response).not.toContain('3155feeb');
  });
});

describe('buildCreateOnboardingIntakeResponse', () => {
  it('formats onboarding intake without process preamble or raw Slack channel ids', () => {
    const response = buildCreateOnboardingIntakeResponse({
      valid: true,
      onboardingIntake: {
        name: 'melon eusk',
        doj: '2026-06-30',
        employmentType: 'fte',
        designation: 'Backend Engineer',
        laptop: 'Yes',
        relocation: 'No',
        requestedSlackChannels: ['C65FRCXCY'],
      },
      validationErrors: [],
    });

    expect(response).toContain('*Onboarding request created*');
    expect(response).toContain('Got it');
    expect(response).toContain(
      'I’ve created the onboarding request for melon eusk',
    );
    expect(response).toContain('melon eusk');
    expect(response).toContain('Slack: selected Slack channel');
    expect(response).toContain('I haven’t created any accounts yet.');
    expect(response).toContain(
      'Once an authorized admin approves it, I can start the setup.',
    );
    expect(response).not.toContain('#C65FRCXCY');
    expect(response).not.toContain('*Next action*');
    expect(response).not.toContain('*Next step*');
    expect(response).not.toContain("I'll handle");
    expect(response).not.toContain('Let me');
    expect(response).not.toContain('Used');
    expect(response).not.toContain('Delegated');
  });

  it('keeps Slack channel names readable when names are available', () => {
    const response = buildCreateOnboardingIntakeResponse({
      valid: true,
      onboardingIntake: {
        name: 'Riya Sharma',
        doj: '2026-07-01',
        employmentType: 'fte',
        designation: 'Backend Engineer',
        laptop: 'No',
        relocation: 'No',
        requestedSlackChannels: ['general', '#backend-alerts'],
      },
      validationErrors: [],
    });

    expect(response).toContain('Slack: #general, #backend-alerts');
  });

  it('labels an idempotent manual intake as an existing onboarding', () => {
    const response = buildCreateOnboardingIntakeResponse({
      created: false,
      valid: true,
      onboardingIntake: {
        name: 'melon eusk',
        doj: '2026-06-30',
        employmentType: 'fte',
        designation: 'Backend Engineer',
        laptop: 'Yes',
        relocation: 'No',
        requestedSlackChannels: ['general'],
      },
      validationErrors: [],
    });

    expect(response).toContain('*Existing onboarding found*');
    expect(response).toContain(
      'I found the existing onboarding for melon eusk',
    );
    expect(response).not.toContain('*Onboarding request created*');
  });
});

describe('buildCreateAccessRequestResponse', () => {
  it('formats standalone revoke access requests as waiting for approval', () => {
    const response = buildCreateAccessRequestResponse({
      id: '0a6f04d5-b890-42c7-99e8-e10be81b6ffe',
      action: 'revoke',
      status: 'waiting_for_approval',
      systemKey: 'slack',
      resourceKey: 'workspace_membership',
      roleKey: 'member',
    });

    expect(response).toContain('*Access revoke request created*');
    expect(response).toContain('Target: Slack Workspace Membership Member');
    expect(response).toContain('Status: Waiting For Approval');
    expect(response).toContain(
      'I’ll wait for an authorized approver before I run any setup or revoke task.',
    );
    expect(response).not.toContain('0a6f04d5');
    expect(response).not.toContain('Used');
  });
});

describe('buildListOnboardingIntakesResponse', () => {
  it('lists pending onboarding intakes without internal details or process narration', () => {
    const response = buildListOnboardingIntakesResponse({
      count: 1,
      onboardingIntakes: [
        {
          name: 'melon eusk',
          doj: '2026-06-30',
          designation: 'Backend Engineer',
          status: 'waiting_for_review',
        },
      ],
    });

    expect(response).toContain('*Pending onboarding requests*');
    expect(response).toContain(
      '- melon eusk - Backend Engineer - start 2026-06-30 - Waiting for admin review',
    );
    expect(response).toContain(
      'Once an authorized admin approves one in its thread, I can continue it.',
    );
    expect(response).not.toContain('*Next action*');
    expect(response).not.toContain('*Next step*');
    expect(response).not.toContain('Let me check');
    expect(response).not.toContain('available tools');
    expect(response).not.toContain('Used');
  });

  it('returns none found when there are no pending onboarding intakes', () => {
    const response = buildListOnboardingIntakesResponse({
      count: 0,
      onboardingIntakes: [],
    });

    expect(response).toContain(
      'I don’t see any pending onboarding requests right now.',
    );
    expect(response).toContain(
      'If you want to start one, post a New Joiner Alert.',
    );
    expect(response).not.toContain('*Next action*');
    expect(response).not.toContain('*Next step*');
    expect(response).not.toContain(
      'No pending onboarding requests found.\n\nEmployees',
    );
  });
});

describe('buildGetOnboardingIntakeResponse', () => {
  it('formats a resolved onboarding intake without backend references or ids', () => {
    const response = buildGetOnboardingIntakeResponse({
      onboardingIntake: {
        id: '0a6f04d5-b890-42c7-99e8-e10be81b6ffe',
        name: 'Kartik Bansal Demo',
        doj: '2026-06-30',
        designation: 'Backend Engineer',
        status: 'waiting_for_review',
      },
    });

    expect(response).toContain('*Onboarding request found*');
    expect(response).toContain('Kartik Bansal Demo');
    expect(response).toContain('Role: Backend Engineer');
    expect(response).toContain('Status: Waiting for admin review');
    expect(response).toContain('I can continue with this onboarding request.');
    expect(response).not.toContain('0a6f04d5');
    expect(response).not.toContain('backend');
    expect(response).not.toContain('UUID');
    expect(response).not.toContain('*Next action*');
    expect(response).not.toContain('*Next step*');
  });
});

describe('buildListEmployeesWithOnboardingIntakesResponse', () => {
  it('formats open onboarding intakes through the approved employee-listing tool path', () => {
    const response = buildListEmployeesWithOnboardingIntakesResponse({
      employees: [],
      openOnboardingCount: 2,
      openOnboardingIntakes: [
        {
          name: 'melon eusk',
          doj: '2026-06-30',
          designation: 'Backend Engineer',
          status: 'waiting_for_review',
        },
        {
          name: 'akhay khan',
          doj: '2026-06-30',
          designation: 'Backend Engineer',
          status: 'ready_for_provisioning',
        },
      ],
    });

    expect(response).toContain('*Open onboarding requests*');
    expect(response).toContain(
      '- melon eusk - Backend Engineer - start 2026-06-30 - Waiting for admin review',
    );
    expect(response).toContain(
      '- akhay khan - Backend Engineer - start 2026-06-30 - Approved, waiting for setup',
    );
    expect(response).toContain(
      'If you want me to continue one, approve it in its original thread or ask me to start an approved setup.',
    );
    expect(response).not.toContain('*Next action*');
    expect(response).not.toContain('*Next step*');
    expect(response).not.toContain('Let me check');
    expect(response).not.toContain('available tools');
    expect(response).not.toContain('Used');
  });
});

describe('buildListEmployeesResponse', () => {
  it('formats current employees with pagination metadata', () => {
    const response = buildListEmployeesResponse({
      employees: [
        {
          fullName: 'Melon Eusk',
          workEmail: 'melon.eusk@caw.tech',
          designation: 'Backend Engineer',
          status: 'active',
          startDate: '2026-06-30',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 21,
      hasNextPage: true,
      status: 'open',
    });

    expect(response).toContain('*Current employees*');
    expect(response).toContain('Page 1 of 2 - 21 total');
    expect(response).toContain('1. Melon Eusk');
    expect(response).toContain('If you want more, ask me to show page 2.');
    expect(response).not.toContain('*Next action*');
    expect(response).not.toContain('*Next step*');
    expect(response).not.toContain('Personal email:');
    expect(response).not.toContain('Used');
  });

  it('uses offboarded title only for explicit offboarded lists', () => {
    const response = buildListEmployeesResponse({
      employees: [],
      page: 1,
      pageSize: 20,
      total: 0,
      hasNextPage: false,
      status: 'offboarded',
    });

    expect(response).toContain('*Offboarded employees*');
    expect(response).toContain('None found.');
  });
});

describe('buildDecideOnboardingIntakeResponse', () => {
  it('uses natural explicit onboarding setup confirmation after approval', () => {
    const response = buildDecideOnboardingIntakeResponse({
      onboardingIntake: {
        name: 'melon eusk',
        doj: '2026-06-30',
        requestedSlackChannels: ['general'],
      },
      decision: {
        decision: 'approved',
      },
      slackChannelAccessTasks: [{}],
    });

    expect(response).toContain('Should I start setup for melon eusk now?');
    expect(response).toContain('Slack channels requested: #general');
    expect(response).not.toContain('Waiting - Slack channel');
    expect(response).not.toContain('run onboarding setup');
    expect(response).not.toContain('Reply `yes`');
  });
});

describe('buildResolveEmployeeResponse', () => {
  it('asks for contextual confirmation when confirming offboarding', () => {
    const response = buildResolveEmployeeResponse({
      status: 'needs_confirmation',
      query: 'akhay',
      purpose: 'offboarding',
      employee: {
        fullName: 'Akhay Khan',
        workEmail: 'akhay.khan@caw.tech',
        status: 'active',
        designation: 'Backend Engineer',
      },
    });

    expect(response).toContain(
      'To make sure I offboard the right person, can you confirm this is akhay.khan@caw.tech?',
    );
    expect(response).not.toContain('send `akhay.khan@caw.tech`');
    expect(response).not.toContain('Reply `yes`');
  });

  it('requires work email confirmation for mutating access changes', () => {
    const response = buildResolveEmployeeResponse({
      status: 'needs_confirmation',
      query: 'melon',
      purpose: 'mutate',
      employee: {
        fullName: 'Melon Eusk',
        workEmail: 'melon.eusk@caw.tech',
        status: 'active',
        designation: 'Backend Engineer',
      },
    });

    expect(response).toContain(
      'To make sure I update the right person, can you confirm this is melon.eusk@caw.tech?',
    );
    expect(response).not.toContain('send `melon.eusk@caw.tech`');
    expect(response).not.toContain('Reply `yes`');
  });

  it('returns no change for already offboarded confirmation matches', () => {
    const response = buildResolveEmployeeResponse({
      status: 'needs_confirmation',
      query: 'akhay',
      purpose: 'offboarding',
      employee: {
        fullName: 'Akhay Khan',
        workEmail: 'akhay.khan@caw.tech',
        status: 'offboarded',
        designation: 'Backend Engineer',
      },
    });

    expect(response).toContain('*No change*');
    expect(response).toContain('already offboarded');
    expect(response).not.toContain('Reply `yes`');
  });
});

describe('buildOnboardingStatusResponse', () => {
  it('formats onboarding setup progress in human language without internal ids', () => {
    const response = buildOnboardingStatusResponse(
      makeOnboardingStatusResult({
        canFinalize: false,
        summary: {
          total: 3,
          completed: 1,
          pending: 2,
          failed: 0,
        },
      }),
    );

    expect(response).toContain(
      'I found onboarding for Riya Sharma, and setup is still moving.',
    );
    expect(response).toContain(
      'I created the company email. The Slack workspace invite is still pending.',
    );
    expect(response).toContain('Their work email is riya.sharma@caw.tech.');
    expect(response).toContain('Slack invite is still pending');
    expect(response).not.toContain('*Onboarding status*');
    expect(response).not.toContain('Setup tasks');
    expect(response).not.toContain('Current employee status');
    expect(response).not.toContain('- Slack Workspace Membership - Waiting');
    expect(response).not.toContain('*Follow-up setup pending:*');
    expect(response).not.toContain('Slack channel #general');
    expect(response).not.toContain('fb65e3ec-9c15-44ce-92f9-b318c741be38');
    expect(response).not.toContain('Used');
    expect(response).not.toContain('Delegated');
  });

  it('formats completed onboarding status as a compact Slack reply', () => {
    const response = buildOnboardingStatusResponse(
      makeOnboardingStatusResult({
        canFinalize: true,
        onboardingIntake: {
          requestedSlackChannels: ['engineering-team-1'],
        },
        employee: {
          id: 'cc9e59fa-2e04-4317-b2ab-35438461b888',
          fullName: 'Test Auto Onboarding Two',
          workEmail: 'test.two@caw.tech',
          status: 'active',
        },
        summary: {
          total: 3,
          completed: 2,
          pending: 1,
          failed: 0,
        },
        setupItems: [
          makeOnboardingSetupItem(),
          makeOnboardingSetupItem({
            system: {
              key: 'slack',
              name: 'Slack',
            },
            resource: {
              key: 'workspace_membership',
              name: 'Workspace Membership',
              resourceType: 'workspace',
            },
          }),
          makeOnboardingSetupItem({
            system: {
              key: 'slack',
              name: 'Slack',
            },
            resource: {
              key: 'general',
              name: '#general',
              resourceType: 'channel',
            },
            taskStatus: 'pending_dependency',
            grantStatus: null,
          }),
        ],
      }),
    );

    expect(response).toBeDefined();
    const text = response!;

    expect(text).toContain('Test Auto Onboarding Two is active.');
    expect(text).toContain(
      'I created the company email and sent the Slack workspace invite.',
    );
    expect(text).toContain('Work email: test.two@caw.tech');
    expect(text).toContain("I haven't added them to #engineering-team-1 yet.");
    expect(text).toContain(
      'Once they accept the Slack invite and join the workspace, I can start that channel request.',
    );
    expect(text.split('Test Auto Onboarding Two is active.')).toHaveLength(2);
    expect(text).not.toContain('*Onboarding status*');
    expect(text).not.toContain("Done — here's the current status");
    expect(text).not.toContain('Employee\n');
    expect(text).not.toContain('Onboarding\n');
    expect(text).not.toContain('Active access');
    expect(text).not.toContain('Offboarding');
    expect(text).not.toContain('Role:');
    expect(text).not.toContain('both today');
    expect(text).not.toContain('auto-activated');
    expect(text).not.toContain('Employee auto-activated');
    expect(text).not.toContain('Let me know');
    expect(text).not.toContain('Want me to proceed');
    expect(text).not.toContain('Setup tasks');
    expect(text).not.toContain(
      'Google Workspace Company Email Account: Completed',
    );
    expect(text).not.toContain('Slack Workspace Membership: Completed');
    expect(text).not.toContain('Slack channel #general');
    expect(text).not.toContain('*Follow-up setup pending:*');
  });
});

describe('buildFinalizeOnboardingResponse', () => {
  it('formats final onboarding completion with active employee status', () => {
    const response = buildFinalizeOnboardingResponse(
      makeOnboardingStatusResult({
        employee: {
          id: 'cc9e59fa-2e04-4317-b2ab-35438461b888',
          fullName: 'Riya Sharma',
          workEmail: 'riya.sharma@caw.tech',
          status: 'active',
        },
        canFinalize: true,
        summary: {
          total: 3,
          completed: 3,
          pending: 0,
          failed: 0,
        },
        setupItems: [
          makeOnboardingSetupItem(),
          makeOnboardingSetupItem({
            system: {
              key: 'slack',
              name: 'Slack',
            },
            resource: {
              key: 'workspace_membership',
              name: 'Workspace Membership',
              resourceType: 'workspace',
            },
          }),
          makeOnboardingSetupItem({
            system: {
              key: 'slack',
              name: 'Slack',
            },
            resource: {
              key: 'general',
              name: '#general',
              resourceType: 'channel',
            },
          }),
        ],
      }),
    );

    expect(response).not.toContain('*Onboarding complete*');
    expect(response).toContain('Done, Riya Sharma is set up.');
    expect(response).toContain('Their work email is riya.sharma@caw.tech.');
    expect(response).toContain(
      'I created the company email and sent the Slack workspace invite.',
    );
    expect(response).not.toContain('Final employee status');
    expect(response).not.toContain('*Setup completed:*');
    expect(response).not.toContain('Slack channel #general');
    expect(response).not.toContain('Used');
    expect(response).not.toContain('Delegated');
    expect(response).not.toContain('fb65e3ec-9c15-44ce-92f9-b318c741be38');
  });

  it('hides pending Slack channel setup after finalization', () => {
    const response = buildFinalizeOnboardingResponse(
      makeOnboardingStatusResult({
        employee: {
          id: 'cc9e59fa-2e04-4317-b2ab-35438461b888',
          fullName: 'Riya Sharma',
          workEmail: 'riya.sharma@caw.tech',
          status: 'active',
        },
        canFinalize: true,
        setupItems: [
          makeOnboardingSetupItem(),
          makeOnboardingSetupItem({
            system: {
              key: 'slack',
              name: 'Slack',
            },
            resource: {
              key: 'workspace_membership',
              name: 'Workspace Membership',
              resourceType: 'workspace',
            },
          }),
          makeOnboardingSetupItem({
            system: {
              key: 'slack',
              name: 'Slack',
            },
            resource: {
              key: 'general',
              name: '#general',
              resourceType: 'channel',
            },
            taskStatus: 'pending_dependency',
            grantStatus: null,
          }),
        ],
      }),
    );

    expect(response).toContain('Done, Riya Sharma is set up.');
    expect(response).toContain(
      'I created the company email and sent the Slack workspace invite.',
    );
    expect(response).not.toContain('*Setup completed:*');
    expect(response).not.toContain('*Follow-up setup pending:*');
    expect(response).not.toContain('Slack channel #general');
  });
});

describe('buildContinueOnboardingSetupResponse', () => {
  it('formats completed onboarding with Slack channels as follow-up only', () => {
    const response = buildContinueOnboardingSetupResponse(
      makeOnboardingStatusResult({
        finalized: true,
        onboardingIntake: {
          requestedSlackChannels: ['C65FRCXCY'],
        },
        employee: {
          id: 'cc9e59fa-2e04-4317-b2ab-35438461b888',
          fullName: 'Kartik Bansal Demo',
          workEmail: 'kartik.demo@caw.tech',
          status: 'active',
        },
        setupItems: [
          makeOnboardingSetupItem(),
          makeOnboardingSetupItem({
            system: {
              key: 'slack',
              name: 'Slack',
            },
            resource: {
              key: 'workspace_membership',
              name: 'Workspace Membership',
              resourceType: 'workspace',
            },
          }),
        ],
      }),
    );

    expect(response).not.toContain('*Onboarding complete*');
    expect(response).toContain('Done, Kartik Bansal Demo is set up.');
    expect(response).toContain(
      'I created the company email and sent the Slack workspace invite.',
    );
    expect(response).not.toContain('*Setup completed:*');
    expect(response).not.toContain('*Slack channels*');
    expect(response).toContain(
      "I haven't added them to the selected Slack channel yet.",
    );
    expect(response).toContain(
      'Once they accept the Slack invite and join the workspace, I can start that channel request.',
    );
    expect(response).not.toContain('#C65FRCXCY');
    expect(response).not.toContain('task id');
    expect(response).not.toContain('*Next action*');
    expect(response).not.toContain('Done -');
    expect(response).not.toContain('ready from the account setup side');
    expect(response).not.toContain('Work email:');
    expect(response).not.toContain('I’ve noted');
    expect(response).not.toContain('*Done*');
    expect(response).not.toContain('*Still pending*');
  });

  it('formats partial onboarding setup as human progress without retry prompt', () => {
    const response = buildContinueOnboardingSetupResponse(
      makeOnboardingStatusResult({
        finalized: false,
        onboardingIntake: {
          requestedSlackChannels: ['engineering-team-1'],
        },
        employee: {
          id: 'cc9e59fa-2e04-4317-b2ab-35438461b888',
          fullName: 'Test Auto Onboarding Two',
          workEmail: 'test.two@caw.tech',
          status: 'preboarding',
        },
        setupItems: [
          makeOnboardingSetupItem({
            taskStatus: 'completed',
            grantStatus: 'active',
          }),
          makeOnboardingSetupItem({
            system: {
              key: 'slack',
              name: 'Slack',
            },
            resource: {
              key: 'workspace_membership',
              name: 'Workspace Membership',
              resourceType: 'workspace',
            },
            taskStatus: 'pending',
            grantStatus: 'pending',
          }),
        ],
      }),
    );

    expect(response).toContain(
      'I started onboarding Test Auto Onboarding Two, and the account setup is still moving.',
    );
    expect(response).toContain(
      'I created the company email. The Slack workspace invite is still pending.',
    );
    expect(response).toContain(
      "I haven't added them to #engineering-team-1 yet.",
    );
    expect(response).toContain(
      'I can start that after the Slack invite is completed and they join the workspace.',
    );
    expect(response).not.toContain('Once they accept the Slack invite');
    expect(response).toContain('Slack invite is still pending');
    expect(response).toContain('employee is not active');
    expect(response).not.toContain('Would you like me to retry');
    expect(response).not.toContain('#C082B4DK080');
    expect(response).not.toContain('*Onboarding request created*');
    expect(response).not.toContain('ready from the account setup side');
    expect(response).not.toContain('Work email:');
    expect(response).not.toContain('I’ve noted');
    expect(response).not.toContain('*Onboarding in progress*');
    expect(response).not.toContain('*Done*');
    expect(response).not.toContain('*Still pending*');
  });

  it('keeps completed critical setup human even when finalization is still false', () => {
    const response = buildContinueOnboardingSetupResponse(
      makeOnboardingStatusResult({
        finalized: false,
        onboardingIntake: {
          requestedSlackChannels: ['engineering-team-1'],
        },
        employee: {
          id: 'cc9e59fa-2e04-4317-b2ab-35438461b888',
          fullName: 'Test Auto Onboarding Two',
          workEmail: 'test.two@caw.tech',
          status: 'active',
        },
        setupItems: [
          makeOnboardingSetupItem(),
          makeOnboardingSetupItem({
            system: {
              key: 'slack',
              name: 'Slack',
            },
            resource: {
              key: 'workspace_membership',
              name: 'Workspace Membership',
              resourceType: 'workspace',
            },
          }),
        ],
      }),
    );

    expect(response).toContain('Done, Test Auto Onboarding Two is set up.');
    expect(response).toContain(
      'I created the company email and sent the Slack workspace invite.',
    );
    expect(response).toContain('Their work email is test.two@caw.tech.');
    expect(response).toContain(
      "I haven't added them to #engineering-team-1 yet.",
    );
    expect(response).toContain(
      'Once they accept the Slack invite and join the workspace, I can start that channel request.',
    );
    expect(response).not.toContain('*Onboarding in progress*');
    expect(response).not.toContain('ready from the account setup side');
    expect(response).not.toContain('Work email:');
    expect(response).not.toContain('I’ve noted');
    expect(response).not.toContain('*Done*');
    expect(response).not.toContain('*Still pending*');
    expect(response).not.toContain('backend has not marked');
  });

  it('formats recoverable onboarding setup failure without claiming completion', () => {
    const response = buildContinueOnboardingSetupResponse(
      makeOnboardingStatusResult({
        finalized: false,
        employee: {
          fullName: 'Riya Sharma',
          workEmail: 'riya.sharma@caw.tech',
          status: 'preboarding',
        },
        summary: {
          total: 2,
          completed: 1,
          pending: 0,
          failed: 1,
        },
        setupItems: [
          makeOnboardingSetupItem(),
          makeOnboardingSetupItem({
            system: {
              key: 'slack',
              name: 'Slack',
            },
            resource: {
              key: 'workspace_membership',
              name: 'Workspace Membership',
              resourceType: 'workspace',
            },
            taskStatus: 'failed',
            taskErrorMessage:
              'Slack browser invite did not submit the workspace invite.',
            grantStatus: null,
          }),
        ],
        executionErrors: [
          {
            accessTaskId: '3155feeb-f028-48a9-bce5-2b6274a839c2',
            message:
              'Slack browser invite did not submit the workspace invite.',
          },
        ],
      }),
    );

    expect(response).not.toContain('*Onboarding needs attention*');
    expect(response).toContain(
      'I retried onboarding setup for Riya Sharma, but Slack still needs attention.',
    );
    expect(response).toContain(
      'Google Workspace is done. Slack invite still failed, so the employee is not active yet.',
    );
    expect(response).toContain('Their work email is riya.sharma@caw.tech.');
    expect(response).toContain(
      'I can retry after the Slack invite issue is fixed.',
    );
    expect(response).toContain('employee is not active');
    expect(response).not.toContain('*Onboarding complete*');
    expect(response).not.toContain('*Critical setup:*');
    expect(response).not.toContain('*Needs attention:*');
    expect(response).not.toContain('Work email:');
    expect(response).not.toContain('I’ve noted');
    expect(response).not.toContain('3155feeb');
  });
});

describe('buildListPendingOnboardingSetupsResponse', () => {
  it('formats one pending setup as a contextual confirmation', () => {
    const response = buildListPendingOnboardingSetupsResponse({
      pendingSetups: [
        {
          onboardingIntake: {
            id: '08eebdd5-c91d-4ef0-8927-89346898ca19',
            name: 'Kartik Bansal Demo',
            doj: '2026-06-30',
            designation: 'Backend Engineer',
          },
          employee: {
            id: 'cc9e59fa-2e04-4317-b2ab-35438461b888',
            fullName: 'Kartik Bansal Demo',
            workEmail: 'kartik.demo@caw.tech',
          },
          pendingCriticalSetup: ['Slack workspace membership'],
        },
      ],
      count: 1,
    });

    expect(response).toContain('*Pending onboarding setup found*');
    expect(response).toContain('Kartik Bansal Demo');
    expect(response).toContain('kartik.demo@caw.tech');
    expect(response).toContain('pending Slack workspace membership');
    expect(response).toContain('Should I continue this onboarding setup now?');
    expect(response).not.toContain('08eebdd5');
    expect(response).not.toContain('task id');
  });

  it('formats multiple pending setups as choices', () => {
    const response = buildListPendingOnboardingSetupsResponse({
      pendingSetups: [
        {
          onboardingIntake: {
            name: 'Kartik Bansal Demo',
            doj: '2026-06-30',
            designation: 'Backend Engineer',
          },
          employee: null,
          pendingCriticalSetup: ['Slack workspace membership'],
        },
        {
          onboardingIntake: {
            name: 'Demo Employee',
            doj: '2026-07-01',
            designation: 'Backend Engineer',
          },
          employee: null,
          pendingCriticalSetup: [
            'Google Workspace company email',
            'Slack workspace membership',
          ],
        },
      ],
      count: 2,
    });

    expect(response).toContain('*Pending onboarding setups*');
    expect(response).toContain('Kartik Bansal Demo');
    expect(response).toContain('Demo Employee');
    expect(response).toContain('Which onboarding setup should I continue?');
    expect(response).not.toContain('*Next action*');
  });

  it('formats no pending setup clearly', () => {
    const response = buildListPendingOnboardingSetupsResponse({
      pendingSetups: [],
      count: 0,
    });

    expect(response).toContain(
      'I don’t see any approved onboarding setup waiting',
    );
    expect(response).toContain('send their name or company email');
    expect(response).not.toContain('task id');
  });
});

describe('buildListOnboardingWorkQueueResponse', () => {
  it('includes setup-complete onboarding as ready to finalize', () => {
    const response = buildListOnboardingWorkQueueResponse({
      items: [
        {
          category: 'ready_to_finalize',
          validationErrors: [],
          onboardingIntake: {
            name: 'Kartik Bansal Demo',
            doj: '2026-06-30',
            designation: 'Backend Engineer',
          },
          employee: {
            fullName: 'Kartik Bansal Demo',
            workEmail: 'kartik.demo@caw.tech',
          },
        },
      ],
      count: 1,
    });

    expect(response).toContain('*Pending onboardings*');
    expect(response).toContain('Kartik Bansal Demo - kartik.demo@caw.tech');
    expect(response).toContain('setup complete, ready to finalize');
    expect(response).not.toContain('task id');
    expect(response).not.toContain('*Next action*');
  });

  it('shows validation errors for needs-correction intake', () => {
    const response = buildListOnboardingWorkQueueResponse({
      items: [
        {
          category: 'needs_correction',
          validationErrors: ['designation is not approved for FTE employees'],
          onboardingIntake: {
            name: 'Kartik Bansal Demo',
            doj: '2026-06-30',
            designation: 'VP of Engineering',
          },
          employee: null,
        },
      ],
      count: 1,
    });

    expect(response).toContain(
      'needs correction - designation is not approved',
    );
    expect(response).toContain('VP of Engineering');
  });
});

describe('buildFinalizeOnboardingByEmployeeResponse', () => {
  it('formats finalized onboarding and notes invalid duplicates without blocking', () => {
    const response = buildFinalizeOnboardingByEmployeeResponse({
      employee: {
        fullName: 'Kartik Bansal Demo',
        workEmail: 'kartik.demo@caw.tech',
        status: 'active',
      },
      duplicateWarnings: [
        {
          name: 'Kartik Bansal Demo',
          designation: 'VP of Engineering',
          status: 'validation_failed',
        },
      ],
    });

    expect(response).not.toContain('*Onboarding finalized*');
    expect(response).toContain('Done, Kartik Bansal Demo is set up.');
    expect(response).toContain('Their work email is kartik.demo@caw.tech.');
    expect(response).not.toContain('Final employee status: Active');
    expect(response).toContain('older invalid or inactive onboarding records');
    expect(response).not.toContain('validation_failed');
    expect(response).not.toContain('task id');
  });
});

describe('buildOnboardingIntakeStatusChangeResponse', () => {
  it('formats cancelled or superseded duplicate intake updates', () => {
    const response = buildOnboardingIntakeStatusChangeResponse({
      onboardingIntake: {
        name: 'Kartik Bansal Demo',
        designation: 'VP of Engineering',
        status: 'superseded',
      },
    });

    expect(response).toContain('*Onboarding intake updated*');
    expect(response).toContain('VP of Engineering');
    expect(response).toContain('Status: Superseded');
    expect(response).toContain('no longer part of the active onboarding flow');
  });
});

describe('buildCreateOffboardingIntakeResponse', () => {
  it('formats offboarding intake creation with active access preview', () => {
    const response = buildCreateOffboardingIntakeResponse({
      offboardingIntake: {
        id: '7c644f93-056a-40bf-815a-9512e050aab5',
        status: 'waiting_for_review',
      },
      employee: {
        id: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
        fullName: 'Akhay Khan',
        workEmail: 'akhay.khan@caw.tech',
        status: 'preboarding',
        designation: 'Backend Engineer',
      },
      activeAccessPreview: [
        {
          grantId: 'b9f77a45-c8bc-44b2-9605-3f39ad4f99a3',
          system: {
            key: 'google_workspace',
            name: 'Google Workspace',
          },
          resource: {
            key: 'company_email',
            name: 'Company Email',
          },
          role: {
            key: 'user',
            name: 'User',
          },
          status: 'active',
        },
        {
          grantId: 'dbbf1511-322c-43f1-a1dd-d98cf31ccbe8',
          system: {
            key: 'slack',
            name: 'Slack',
          },
          resource: {
            key: 'general',
            name: '#general',
          },
          role: {
            key: 'member',
            name: 'Member',
          },
          status: 'active',
        },
      ],
      activeAccessCount: 2,
      employeeLifecycleCase: 'preboarding_cancellation',
      message:
        'This employee is still preboarding. This will cancel onboarding and revoke any access already provisioned.',
      nextAction: 'approval_required',
    });

    expect(response).toContain('*Preboarding cancellation intake created*');
    expect(response).toContain('Employee: Akhay Khan');
    expect(response).toContain('Work email: akhay.khan@caw.tech');
    expect(response).toContain('Current employee status: preboarding');
    expect(response).toContain('Designation: Backend Engineer');
    expect(response).toContain('- Google Workspace / Company Email / User');
    expect(response).toContain('- Slack / #general / Member');
    expect(response).toContain(
      'This employee is still preboarding. This will cancel onboarding and revoke any access already provisioned.',
    );
    expect(response).toContain(
      'Offboarding status: Waiting for admin approval',
    );
    expect(response).toContain('No access has been revoked yet.');
    expect(response).toContain(
      'An authorized admin can approve it. I won’t revoke access until then.',
    );
    expect(response).not.toContain('\nStatus: preboarding');
    expect(response).not.toContain('Used');
    expect(response).not.toContain('Delegated');
    expect(response).not.toContain('Changed');
  });

  it('formats offboarding intake creation when there is no active access', () => {
    const response = buildCreateOffboardingIntakeResponse({
      offboardingIntake: {
        id: '7c644f93-056a-40bf-815a-9512e050aab5',
        status: 'waiting_for_review',
      },
      employee: {
        id: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
        fullName: 'No Access User',
        workEmail: 'no.access@caw.tech',
        status: 'active',
        designation: null,
      },
      activeAccessPreview: [],
      activeAccessCount: 0,
      employeeLifecycleCase: 'active_offboarding',
      message:
        'This will start offboarding and revoke active access after approval.',
      nextAction: 'approval_required',
    });

    expect(response).toContain('Active access found: None');
    expect(response).toContain('Designation: Unknown');
    expect(response).toContain(
      'This will start offboarding and revoke active access after approval.',
    );
    expect(response).toContain('No access has been revoked yet.');
  });

  it('formats already offboarded employees as no change', () => {
    const response = buildCreateOffboardingIntakeResponse({
      offboardingIntake: null,
      employee: {
        id: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
        fullName: 'Akhay Khan',
        workEmail: 'akhay.khan@caw.tech',
        status: 'offboarded',
        designation: 'Backend Engineer',
      },
      activeAccessPreview: [],
      activeAccessCount: 0,
      employeeLifecycleCase: 'already_offboarded',
      message: 'No change. Employee is already offboarded.',
      nextAction: 'no_change',
    });

    expect(response).toContain('*No change*');
    expect(response).toContain('Employee: Akhay Khan');
    expect(response).toContain('Current employee status: offboarded');
    expect(response).toContain('No change. Employee is already offboarded.');
    expect(response).toContain(
      'I don’t need to start a new offboarding workflow.',
    );
    expect(response).not.toContain(
      'Offboarding status: Waiting for admin approval',
    );
  });

  it('formats existing approved offboarding with natural revoke confirmation instead of exact command', () => {
    const response = buildCreateOffboardingIntakeResponse({
      offboardingIntake: {
        id: '7c644f93-056a-40bf-815a-9512e050aab5',
        status: 'in_progress',
      },
      employee: {
        id: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
        fullName: 'Demo2 Employee',
        workEmail: 'demo2.employee@caw.tech',
        status: 'offboarding',
        designation: 'Backend Engineer',
      },
      activeAccessPreview: [],
      activeAccessCount: 0,
      employeeLifecycleCase: 'already_offboarding',
      message:
        'Offboarding is already in progress. Here is the current status.',
      nextAction: 'view_existing_status',
      offboardingStatus: {
        offboardingIntake: {
          id: '7c644f93-056a-40bf-815a-9512e050aab5',
          status: 'in_progress',
        },
        employee: {
          id: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
          fullName: 'Demo2 Employee',
          workEmail: 'demo2.employee@caw.tech',
        },
        summary: {
          total: 2,
          completed: 0,
          pending: 2,
          failed: 0,
        },
        revokeItems: [
          {
            system: {
              key: 'slack',
              name: 'Slack',
            },
            resource: {
              key: 'workspace_membership',
              name: 'Workspace Membership',
            },
            role: {
              key: 'member',
              name: 'Member',
            },
            grantStatus: 'revocation_pending',
            taskStatus: 'pending',
            accessTaskId: '4c6ca262-c0a3-47ec-aaf6-310e6409a2d6',
          },
          {
            system: {
              key: 'google_workspace',
              name: 'Google Workspace',
            },
            resource: {
              key: 'company_email',
              name: 'Company Email',
            },
            role: {
              key: 'user',
              name: 'User',
            },
            grantStatus: 'revocation_pending',
            taskStatus: 'pending',
            accessTaskId: '9d43b481-c1df-4e9a-8843-c3455978c514',
          },
        ],
        canFinalize: false,
        workflowState: 'approved',
        employeeLifecycleCase: 'already_offboarding',
      },
    });

    expect(response).toContain('*Offboarding already in progress*');
    expect(response).toContain('Employee: Demo2 Employee');
    expect(response).toContain('Pending revoke tasks:');
    expect(response).toContain('- Slack Workspace Membership');
    expect(response).toContain('- Google Workspace Company Email');
    expect(response).toContain(
      'Can you confirm this is the right employee before I revoke access for demo2.employee@caw.tech?',
    );
    expect(response).not.toContain('explicit command');
    expect(response).not.toContain('run revoke tasks');
    expect(response).not.toContain('Used:');
    expect(response).not.toContain('Changed:');
    expect(response).not.toContain('Delegated:');
  });
});

describe('buildDecideOffboardingIntakeResponse', () => {
  it('formats approval as a short human Slack reply', () => {
    const response = buildDecideOffboardingIntakeResponse({
      offboardingIntake: {
        id: '7c644f93-056a-40bf-815a-9512e050aab5',
        status: 'in_progress',
      },
      decision: {
        decision: 'approved',
      },
      employee: {
        id: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
        fullName: 'Devansh Testar',
        workEmail: 'devansh.testar@caw.tech',
      },
      revokeItems: [
        {
          system: {
            key: 'slack',
            name: 'Slack',
          },
          resource: {
            key: 'workspace_membership',
            name: 'Slack Workspace Membership',
            resourceType: 'workspace',
          },
          role: {
            key: 'member',
            name: 'Member',
          },
        },
        {
          system: {
            key: 'google_workspace',
            name: 'Google Workspace',
          },
          resource: {
            key: 'company_email',
            name: 'Company Email Account',
            resourceType: 'account',
          },
          role: {
            key: 'user',
            name: 'User',
          },
        },
      ],
    });

    expect(response).toContain('I’ve got approval to offboard Devansh Testar.');
    expect(response).toContain('Here’s what I’m ready to remove:');
    expect(response).toContain('- Slack Slack Workspace Membership');
    expect(response).toContain('- Google Workspace Company Email Account');
    expect(response).toContain('I haven’t revoked anything yet.');
    expect(response).toContain(
      'Can you confirm this is the right employee before I revoke access for devansh.testar@caw.tech?',
    );
    expect(response).not.toContain('*Offboarding approved*');
    expect(response).not.toContain('Revoke tasks ready');
    expect(response).not.toContain('Status: offboarding');
    expect(response).not.toContain('Designation:');
  });
});

describe('buildFinalizeOffboardingResponse', () => {
  it('formats successful final offboarding with human revoke outcomes', () => {
    const response = buildFinalizeOffboardingResponse({
      offboardingIntake: {
        id: '7c644f93-056a-40bf-815a-9512e050aab5',
        status: 'completed',
      },
      employee: {
        id: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
        fullName: 'Akhay Khan',
        workEmail: 'akhay.khan@caw.tech',
        status: 'offboarded',
      },
      summary: {
        total: 3,
        completed: 3,
        pending: 0,
        failed: 0,
      },
      revokeItems: [
        {
          id: 'f71e8da2-2f0b-49a4-9f13-402185bb9895',
          system: {
            key: 'slack',
            name: 'Slack',
          },
          resource: {
            key: 'workspace_membership',
            name: 'Workspace Membership',
            resourceType: 'workspace',
          },
          role: {
            key: 'member',
            name: 'Member',
          },
          grantStatus: 'revoked',
          taskStatus: 'completed',
          accessTaskId: '3155feeb-f028-48a9-bce5-2b6274a839c2',
        },
        {
          id: 'b835c6d8-a697-4a79-a4dd-10c66ccfe3f4',
          system: {
            key: 'google_workspace',
            name: 'Google Workspace',
          },
          resource: {
            key: 'company_email',
            name: 'Company Email',
            resourceType: 'account',
          },
          role: {
            key: 'user',
            name: 'User',
          },
          grantStatus: 'revoked',
          taskStatus: 'completed',
          accessTaskId: '69f645cf-7967-4bd4-8614-eb9cc43fdc5b',
        },
        {
          id: 'b7a71f5d-f640-4d77-bbeb-892cde74df53',
          system: {
            key: 'slack',
            name: 'Slack',
          },
          resource: {
            key: 'general',
            name: '#general',
            resourceType: 'channel',
          },
          role: {
            key: 'member',
            name: 'Member',
          },
          grantStatus: 'revoked',
          taskStatus: 'skipped',
          accessTaskId: '92cf40b7-c46e-4e78-a622-03817d6fbe21',
        },
      ],
      canFinalize: true,
      employeeLifecycleCase: 'active_offboarding',
    });

    expect(response).toContain('Done, Akhay Khan is offboarded.');
    expect(response).toContain(
      'I suspended their company email, deactivated their Slack workspace access, and removed the remaining access covered by this offboarding.',
    );
    expect(response).toContain('Their work email was akhay.khan@caw.tech.');
    expect(response).not.toContain('*Offboarding complete*');
    expect(response).not.toContain('Final employee status:');
    expect(response).not.toContain('*Access revoked:*');
    expect(response).not.toContain('Needs attention');
    expect(response).not.toContain('Used');
    expect(response).not.toContain('Delegated');
    expect(response).not.toContain('Changed');
    expect(response).not.toContain('3155feeb-f028-48a9-bce5-2b6274a839c2');
  });

  it('formats completed preboarding cancellation distinctly', () => {
    const response = buildFinalizeOffboardingResponse({
      offboardingIntake: {
        id: '7c644f93-056a-40bf-815a-9512e050aab5',
        status: 'completed',
      },
      employee: {
        id: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
        fullName: 'Akhay Khan',
        workEmail: 'akhay.khan@caw.tech',
        status: 'offboarded',
      },
      summary: {
        total: 1,
        completed: 1,
        pending: 0,
        failed: 0,
      },
      revokeItems: [
        {
          id: 'b835c6d8-a697-4a79-a4dd-10c66ccfe3f4',
          system: {
            key: 'google_workspace',
            name: 'Google Workspace',
          },
          resource: {
            key: 'company_email',
            name: 'Company Email',
            resourceType: 'account',
          },
          role: {
            key: 'user',
            name: 'User',
          },
          grantStatus: 'revoked',
          taskStatus: 'completed',
          accessTaskId: '69f645cf-7967-4bd4-8614-eb9cc43fdc5b',
        },
      ],
      canFinalize: true,
      employeeLifecycleCase: 'preboarding_cancellation',
    });

    expect(response).toContain('Done, I cancelled onboarding for Akhay Khan.');
    expect(response).toContain(
      'I revoked the access that had already been provisioned.',
    );
    expect(response).toContain('Their work email was akhay.khan@caw.tech.');
    expect(response).not.toContain('Final employee status:');
    expect(response).not.toContain('*Offboarding complete*');
  });

  it('formats incomplete offboarding without claiming completion', () => {
    const response = buildFinalizeOffboardingResponse({
      offboardingIntake: {
        id: '7c644f93-056a-40bf-815a-9512e050aab5',
        status: 'in_progress',
      },
      employee: {
        id: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
        fullName: 'Akhay Khan',
        workEmail: 'akhay.khan@caw.tech',
        status: 'offboarding',
      },
      summary: {
        total: 2,
        completed: 1,
        pending: 0,
        failed: 1,
      },
      revokeItems: [
        {
          id: 'f71e8da2-2f0b-49a4-9f13-402185bb9895',
          system: {
            key: 'google_workspace',
            name: 'Google Workspace',
          },
          resource: {
            key: 'company_email',
            name: 'Company Email',
            resourceType: 'account',
          },
          role: {
            key: 'user',
            name: 'User',
          },
          grantStatus: 'revoked',
          taskStatus: 'completed',
          accessTaskId: '69f645cf-7967-4bd4-8614-eb9cc43fdc5b',
        },
        {
          id: 'b835c6d8-a697-4a79-a4dd-10c66ccfe3f4',
          system: {
            key: 'slack',
            name: 'Slack',
          },
          resource: {
            key: 'workspace_membership',
            name: 'Workspace Membership',
            resourceType: 'workspace',
          },
          role: {
            key: 'member',
            name: 'Member',
          },
          grantStatus: 'active',
          taskStatus: 'failed',
          accessTaskId: '3155feeb-f028-48a9-bce5-2b6274a839c2',
        },
      ],
      canFinalize: false,
    });

    expect(response).toContain('Akhay Khan is not fully offboarded yet.');
    expect(response).toContain('I suspended their company email.');
    expect(response).toContain('Their work email is akhay.khan@caw.tech.');
    expect(response).toContain('Still needs attention:');
    expect(response).toContain('- Slack Workspace Membership - failed');
    expect(response).toContain('I can retry after the issue is fixed.');
    expect(response).not.toContain('*Offboarding complete*');
    expect(response).not.toContain('Final employee status:');
  });
});

describe('buildAutoProcessOffboardingResponse', () => {
  it('formats finalized lifecycle offboarding through final status', () => {
    const response = buildAutoProcessOffboardingResponse({
      finalized: true,
      finalStatus: {
        offboardingIntake: {
          status: 'completed',
        },
        employee: {
          fullName: 'Riya Sharma',
          workEmail: 'riya.sharma@caw.tech',
          status: 'offboarded',
        },
        revokeItems: [
          {
            system: { key: 'slack', name: 'Slack' },
            resource: {
              key: 'workspace_membership',
              name: 'Workspace Membership',
              resourceType: 'workspace',
            },
            role: { key: 'member', name: 'Member' },
            grantStatus: 'revoked',
            taskStatus: 'completed',
          },
        ],
        summary: {
          total: 1,
          completed: 1,
          pending: 0,
          failed: 0,
        },
        canFinalize: true,
        workflowState: 'finalized',
        employeeLifecycleCase: 'active_offboarding',
      },
    });

    expect(response).toContain('Done, Riya Sharma is offboarded.');
    expect(response).toContain('I deactivated their Slack workspace access.');
    expect(response).toContain('Their work email was riya.sharma@caw.tech.');
    expect(response).not.toContain('*Offboarding complete*');
    expect(response).not.toContain('*Revoke status:*');
    expect(response).not.toContain('Waiting for admin approval');
  });

  it('formats failed lifecycle offboarding without claiming completion', () => {
    const response = buildAutoProcessOffboardingResponse({
      finalized: false,
      employee: {
        fullName: 'Riya Sharma',
        workEmail: 'riya.sharma@caw.tech',
        status: 'offboarding',
      },
      finalStatus: {
        employee: {
          fullName: 'Riya Sharma',
          workEmail: 'riya.sharma@caw.tech',
          status: 'offboarding',
        },
        revokeItems: [
          {
            system: { key: 'google_workspace', name: 'Google Workspace' },
            resource: {
              key: 'company_email',
              name: 'Company Email',
              resourceType: 'account',
            },
            role: { key: 'user', name: 'User' },
            grantStatus: 'revoked',
            taskStatus: 'completed',
          },
          {
            system: { key: 'slack', name: 'Slack' },
            resource: {
              key: 'workspace_membership',
              name: 'Workspace Membership',
              resourceType: 'workspace',
            },
            role: { key: 'member', name: 'Member' },
            grantStatus: 'active',
            taskStatus: 'failed',
          },
        ],
        summary: {
          total: 2,
          completed: 1,
          pending: 0,
          failed: 1,
        },
        canFinalize: false,
        workflowState: 'failed',
      },
      executionErrors: [
        {
          accessTaskId: '3155feeb-f028-48a9-bce5-2b6274a839c2',
          message: 'Slack workspace revoke failed',
        },
      ],
    });

    expect(response).toContain(
      'I started offboarding Riya Sharma, but Slack workspace deactivation still needs attention.',
    );
    expect(response).toContain('I suspended their company email.');
    expect(response).toContain('Still needs attention:');
    expect(response).toContain('- Slack Workspace Membership - failed');
    expect(response).toContain('Their work email is riya.sharma@caw.tech.');
    expect(response).not.toContain('Done, Riya Sharma is offboarded.');
    expect(response).not.toContain('*Offboarding in progress*');
    expect(response).not.toContain('*Revoke status:*');
  });
});

describe('buildAutoProcessOffboardingFromSlackMessageResponse', () => {
  it('delegates processed Offboarding Alert results to the lifecycle response', () => {
    const response = buildAutoProcessOffboardingFromSlackMessageResponse({
      kind: 'offboarding_alert_processed',
      result: {
        finalized: true,
        finalStatus: {
          employee: {
            fullName: 'Riya Sharma',
            workEmail: 'riya.sharma@caw.tech',
            status: 'offboarded',
          },
          revokeItems: [
            {
              system: { key: 'google_workspace', name: 'Google Workspace' },
              resource: {
                key: 'company_email',
                name: 'Company Email',
                resourceType: 'account',
              },
              role: { key: 'user', name: 'User' },
              grantStatus: 'revoked',
              taskStatus: 'completed',
            },
          ],
          summary: {
            total: 1,
            completed: 1,
            pending: 0,
            failed: 0,
          },
          canFinalize: true,
          workflowState: 'finalized',
        },
      },
    });

    expect(response).toContain('Done, Riya Sharma is offboarded.');
    expect(response).toContain('I suspended their company email.');
    expect(response).not.toContain('*Offboarding complete*');
  });

  it('formats Offboarding Alert validation errors as a correction message', () => {
    const response = buildAutoProcessOffboardingFromSlackMessageResponse({
      kind: 'offboarding_alert_validation_error',
      parsed: {
        fields: {
          name: 'Riya Sharma',
          workEmail: null,
          lastWorkingDay: '07/31/2026',
        },
        missingFields: ['Work Email'],
        parseErrors: ['Last Working Day must use YYYY-MM-DD format.'],
      },
    });

    expect(response).toContain(
      "I couldn't process this Offboarding Alert yet.",
    );
    expect(response).toContain('Missing: Work Email');
    expect(response).toContain('Last Working Day must use YYYY-MM-DD format.');
    expect(response).toContain('Offboarding Alert');
    expect(response).toContain('Work Email: riya.sharma@caw.tech');
  });

  it('formats Offboarding Alert name mismatches without revoking access', () => {
    const response = buildAutoProcessOffboardingFromSlackMessageResponse({
      kind: 'offboarding_alert_name_mismatch',
      parsed: {
        fields: {
          name: 'Riya Sharma',
          workEmail: 'riya.sharma@caw.tech',
          lastWorkingDay: '2026-07-31',
        },
      },
      resolution: {
        employee: {
          fullName: 'Priya Sharma',
          workEmail: 'riya.sharma@caw.tech',
        },
      },
    });

    expect(response).toContain(
      'I found the work email, but the name does not match the employee record.',
    );
    expect(response).toContain('Alert name: Riya Sharma');
    expect(response).toContain('Employee record: Priya Sharma');
    expect(response).toContain('Please resend the Offboarding Alert');
  });
});

describe('buildSearchAccessGrantsResponse', () => {
  it('formats inactive Slack access without hiding revoked grants', () => {
    const response = buildSearchAccessGrantsResponse(
      {
        grants: [
          {
            grantId: '7c644f93-056a-40bf-815a-9512e050aab5',
            employee: {
              id: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
              fullName: 'akhay khan',
              workEmail: 'akhay.khan@caw.tech',
              status: 'offboarded',
            },
            system: {
              key: 'slack',
              name: 'Slack',
            },
            resource: {
              key: 'workspace_membership',
              name: 'Workspace Membership',
              resourceType: 'workspace',
            },
            role: {
              key: 'member',
              name: 'Member',
            },
            status: 'revoked',
            externalAccountId: null,
            grantedAt: null,
            revokedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      },
      {
        systemKey: 'slack',
        mode: 'inactive',
      },
    );

    expect(response).toContain('*Inactive Slack access*');
    expect(response).toContain('*Employees found:*');
    expect(response).toContain('- akhay khan - akhay.khan@caw.tech');
    expect(response).toContain('Employee status: Offboarded');
    expect(response).toContain('Slack Workspace Membership: Revoked');
    expect(response).toContain('Revoked during offboarding');
    expect(response).not.toContain('7c644f93-056a-40bf-815a-9512e050aab5');
    expect(response).not.toContain('Used');
    expect(response).not.toContain('Delegated');
    expect(response).not.toContain('Changed');
  });

  it('formats access history results', () => {
    const response = buildSearchAccessGrantsResponse(
      {
        grants: [
          {
            employee: {
              fullName: 'Akhay Khan',
              workEmail: 'akhay.khan@caw.tech',
            },
            system: {
              key: 'google_workspace',
              name: 'Google Workspace',
            },
            resource: {
              key: 'company_email',
              name: 'Company Email',
            },
            role: {
              key: 'user',
              name: 'User',
            },
            status: 'active',
          },
          {
            employee: {
              fullName: 'Akhay Khan',
              workEmail: 'akhay.khan@caw.tech',
            },
            system: {
              key: 'slack',
              name: 'Slack',
            },
            resource: {
              key: 'workspace_membership',
              name: 'Workspace Membership',
            },
            role: {
              key: 'member',
              name: 'Member',
            },
            status: 'revoked',
          },
        ],
      },
      {
        employeeQuery: 'akhay.khan@caw.tech',
        mode: 'history',
      },
    );

    expect(response).toContain('*Access history*');
    expect(response).toContain(
      '- Akhay Khan - akhay.khan@caw.tech - Google Workspace Company Email User - Active',
    );
    expect(response).toContain(
      '- Akhay Khan - akhay.khan@caw.tech - Slack Workspace Membership Member - Revoked',
    );
  });
});

describe('diagnostics response builders', () => {
  it('formats config health without secret values', () => {
    const response = buildConfigHealthResponse({
      GOOGLE_WORKSPACE_ENABLED: true,
      SLACK_CONNECTOR_ENABLED: true,
      EMAIL_ENABLED: false,
      APPROVAL_POLICY_ENABLED: true,
      sections: [
        {
          name: 'Google Workspace',
          enabled: true,
          requiredConfig: [
            { key: 'GOOGLE_WORKSPACE_DOMAIN', status: 'present' },
            { key: 'GOOGLE_WORKSPACE_PRIVATE_KEY', status: 'present' },
          ],
        },
        {
          name: 'Slack channel connector',
          enabled: true,
          requiredConfig: [{ key: 'SLACK_BOT_TOKEN', status: 'missing' }],
        },
      ],
    });

    expect(response).toContain('*Config health*');
    expect(response).toContain('Google Workspace: Enabled');
    expect(response).toContain('- Google Workspace: Ready');
    expect(response).toContain(
      '- Slack channel connector: Missing SLACK_BOT_TOKEN',
    );
    expect(response).not.toContain('xoxb');
    expect(response).not.toContain('postgresql://');
    expect(response).not.toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('formats connector health safely', () => {
    const response = buildConnectorHealthResponse({
      connectors: [
        {
          name: 'Slack channel connector',
          enabled: true,
          mode: 'real',
          status: 'not_configured',
          missingConfig: ['SLACK_BOT_TOKEN'],
        },
      ],
    });

    expect(response).toContain('*Connector health*');
    expect(response).toContain(
      '- Slack channel connector (real): Not Configured - missing SLACK_BOT_TOKEN',
    );
    expect(response).not.toContain('xoxb');
  });

  it('formats recent failed tasks with sanitized error summaries', () => {
    const response = buildRecentFailedAccessTasksResponse({
      failedAccessTasks: [
        {
          accessTaskId: '3155feeb-f028-48a9-bce5-2b6274a839c2',
          accessRequestId: '24a5f12b-6a0f-4b3f-a540-38a3c10f0879',
          employeeName: 'Akhay Khan',
          employeeWorkEmail: 'akhay.khan@caw.tech',
          operation: 'revoke',
          system: 'Slack',
          resource: 'Workspace Membership',
          role: 'Member',
          connector: 'slack',
          status: 'failed',
          errorSummary: 'Slack token is missing a required scope.',
          connectorResultSummary: null,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
      ],
    });

    expect(response).toContain('*Recent failed access tasks*');
    expect(response).toContain(
      '- Akhay Khan - akhay.khan@caw.tech - Slack Workspace Membership revoke: Failed - Slack token is missing a required scope.',
    );
    expect(response).not.toContain('3155feeb-f028-48a9-bce5-2b6274a839c2');
    expect(response).not.toContain('xoxb');
    expect(response).not.toContain('via slack');
  });

  it('formats task status diagnostics', () => {
    const response = buildTaskStatusDiagnosticsResponse({
      tasks: [
        {
          employeeName: 'Test Auto Onboarding',
          employeeWorkEmail: 'test.onboarding@caw.tech',
          operation: 'grant',
          system: 'Slack',
          resource: 'Workspace Membership',
          role: 'Member',
          connector: 'slack',
          status: 'completed',
        },
      ],
    });

    expect(response).toContain('*Task status*');
    expect(response).toContain(
      '- Test Auto Onboarding - test.onboarding@caw.tech - Slack Workspace Membership: Completed',
    );
    expect(response).not.toContain('via slack');
  });
});

describe('buildAccessDetailReportResponse', () => {
  it('formats explicit audit details with ids and sanitized connector summary', () => {
    const response = buildAccessDetailReportResponse({
      reportType: 'offboarding_audit',
      employees: [
        {
          id: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
          fullName: 'Akhay Khan',
          workEmail: 'akhay.khan@caw.tech',
          status: 'offboarded',
        },
      ],
      accessRequests: [
        {
          id: '24a5f12b-6a0f-4b3f-a540-38a3c10f0879',
          action: 'revoke',
          status: 'completed',
          requestedByExternalUserId: 'slack:U123',
          createdAt: '2026-06-25T10:00:00.000Z',
          updatedAt: '2026-06-25T10:02:00.000Z',
          system: {
            key: 'slack',
            name: 'Slack',
          },
          resource: {
            key: 'workspace_membership',
            name: 'Workspace Membership',
            resourceType: 'workspace',
          },
          role: {
            key: 'member',
            name: 'Member',
          },
        },
      ],
      approvals: [
        {
          id: '0b342fab-f759-4683-a4b7-9c352127c9ea',
          accessRequestId: '24a5f12b-6a0f-4b3f-a540-38a3c10f0879',
          approverExternalUserId: 'slack:U_APPROVER',
          decision: 'approved',
          source: 'offboarding_intake',
          createdAt: '2026-06-25T10:01:00.000Z',
        },
      ],
      accessTasks: [
        {
          id: '3155feeb-f028-48a9-bce5-2b6274a839c2',
          accessRequestId: '24a5f12b-6a0f-4b3f-a540-38a3c10f0879',
          operation: 'revoke',
          status: 'completed',
          connector: 'slack',
          attemptCount: 1,
          connectorResultSummary: {
            provider: 'slack',
            operation: 'workspace_revoke',
            revoked: true,
          },
          errorMessage: null,
          createdAt: '2026-06-25T10:01:00.000Z',
          updatedAt: '2026-06-25T10:02:00.000Z',
        },
      ],
      accessGrants: [
        {
          id: '7c644f93-056a-40bf-815a-9512e050aab5',
          employeeId: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
          status: 'revoked',
          externalAccountId: 'U123',
          grantedAt: '2026-06-20T10:00:00.000Z',
          revokedAt: '2026-06-25T10:02:00.000Z',
          system: {
            key: 'slack',
            name: 'Slack',
          },
          resource: {
            key: 'workspace_membership',
            name: 'Workspace Membership',
            resourceType: 'workspace',
          },
          role: {
            key: 'member',
            name: 'Member',
          },
        },
      ],
      offboardingIntakes: [
        {
          id: 'fd8048e9-c7cc-4bca-bb70-e5f7e5e8520e',
          employeeId: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
          status: 'completed',
          requestedByExternalUserId: 'slack:U123',
          createdAt: '2026-06-25T09:58:00.000Z',
          completedAt: '2026-06-25T10:03:00.000Z',
        },
      ],
      offboardingApprovals: [
        {
          id: '7c817f10-7df4-4931-a97d-759bde89b2ef',
          offboardingIntakeId: 'fd8048e9-c7cc-4bca-bb70-e5f7e5e8520e',
          approverExternalUserId: 'slack:U_APPROVER',
          decision: 'approved',
          source: 'slack',
          createdAt: '2026-06-25T10:00:00.000Z',
        },
      ],
      auditEvents: [
        {
          id: '4754f86f-20eb-43f8-9725-49bd0fb72a58',
          eventType: 'access_task.completed',
          entityType: 'access_task',
          entityId: '3155feeb-f028-48a9-bce5-2b6274a839c2',
          actorExternalUserId: 'system',
          createdAt: '2026-06-25T10:02:00.000Z',
        },
      ],
    });

    expect(response).toContain('*Offboarding audit*');
    expect(response).toContain('24a5f12b-6a0f-4b3f-a540-38a3c10f0879');
    expect(response).toContain('3155feeb-f028-48a9-bce5-2b6274a839c2');
    expect(response).toContain(
      'connector result: provider=slack, operation=workspace_revoke, revoked=true',
    );
    expect(response).toContain('access_task.completed');
    expect(response).not.toContain('token');
    expect(response).not.toContain('password');
    expect(response).not.toContain('cookie');
    expect(response).not.toContain('browser profile');
  });
});

function makeOnboardingStatusResult(overrides: Record<string, unknown> = {}) {
  return {
    onboardingIntake: {
      id: '08eebdd5-c91d-4ef0-8927-89346898ca19',
      status: 'ready_for_provisioning',
    },
    employee: {
      id: 'cc9e59fa-2e04-4317-b2ab-35438461b888',
      fullName: 'Riya Sharma',
      workEmail: 'riya.sharma@caw.tech',
      status: 'preboarding',
    },
    summary: {
      total: 3,
      completed: 1,
      pending: 2,
      failed: 0,
    },
    setupItems: [
      makeOnboardingSetupItem(),
      makeOnboardingSetupItem({
        system: {
          key: 'slack',
          name: 'Slack',
        },
        resource: {
          key: 'workspace_membership',
          name: 'Workspace Membership',
          resourceType: 'workspace',
        },
        taskStatus: 'pending',
        grantStatus: null,
      }),
      makeOnboardingSetupItem({
        system: {
          key: 'slack',
          name: 'Slack',
        },
        resource: {
          key: 'general',
          name: '#general',
          resourceType: 'channel',
        },
        taskStatus: 'pending_dependency',
        grantStatus: null,
      }),
    ],
    canFinalize: false,
    executionErrors: [],
    ...overrides,
  };
}

function makeOnboardingSetupItem(overrides: Record<string, unknown> = {}) {
  return {
    accessRequestId: '7a49574e-287c-4d2b-9583-14a4a425df5d',
    accessTaskId: 'fb65e3ec-9c15-44ce-92f9-b318c741be38',
    system: {
      key: 'google_workspace',
      name: 'Google Workspace',
    },
    resource: {
      key: 'company_email',
      name: 'Company Email',
      resourceType: 'account',
    },
    role: {
      key: 'user',
      name: 'User',
    },
    requestStatus: 'completed',
    taskStatus: 'completed',
    taskErrorMessage: null,
    grantStatus: 'active',
    required: true,
    ...overrides,
  };
}

function makeOffboardingAlertText(): { rawText: string } {
  return {
    rawText: [
      'Offboarding Alert',
      'Name: Riya Sharma',
      'Work Email: riya.sharma@caw.tech',
      'Last Working Day: 2026-07-31',
    ].join('\n'),
  };
}

function makeOffboardingAlertClient() {
  return {
    resolveEmployee: vi.fn(),
    autoProcessOffboarding: vi.fn(),
  };
}

function makeResolvedEmployee(overrides: Record<string, unknown> = {}) {
  const employee = {
    employeeId: 'employee_riya',
    fullName: 'Riya Sharma',
    workEmail: 'riya.sharma@caw.tech',
    status: 'active',
    designation: 'Backend Engineer',
    department: 'Engineering',
    ...overrides,
  };

  return {
    status: 'resolved' as const,
    query: 'riya.sharma@caw.tech',
    purpose: 'offboarding' as const,
    employee,
    matches: [employee],
  };
}

function makeAutoProcessedOffboardingResult() {
  return {
    offboardingIntake: {
      id: 'fd8048e9-c7cc-4bca-bb70-e5f7e5e8520e',
      status: 'completed',
    },
    employee: {
      id: 'employee_riya',
      fullName: 'Riya Sharma',
      workEmail: 'riya.sharma@caw.tech',
      status: 'offboarded',
    },
    activeAccessPreview: [],
    activeAccessCount: 0,
    employeeLifecycleCase: 'active_offboarding',
    message: 'Offboarding complete.',
    nextAction: 'view_existing_status',
    authorityDecision: null,
    executedTasks: [],
    executionErrors: [],
    finalStatus: {
      employee: {
        fullName: 'Riya Sharma',
        workEmail: 'riya.sharma@caw.tech',
        status: 'offboarded',
      },
      revokeItems: [],
      summary: {
        total: 0,
        completed: 0,
        pending: 0,
        failed: 0,
      },
      canFinalize: true,
      workflowState: 'finalized',
    },
    finalized: true,
  };
}
