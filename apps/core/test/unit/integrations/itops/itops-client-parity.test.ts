import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ItOpsClient,
  type ItOpsClientConfig,
} from '@core/integrations/itops/itops-client.js';

describe('ItOpsClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: ItOpsClient;

  beforeEach(() => {
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    client = new ItOpsClient({
      itopsApiBaseUrl: 'http://127.0.0.1:4000',
      itopsApiTimeoutMs: 15_000,
      itopsApiRetryAttempts: 0,
      itopsApiRetryDelayMs: 0,
      itopsApiKey: 'api-key',
    } satisfies ItOpsClientConfig);
  });

  it('lists employees with pagination filters', async () => {
    const result = {
      employees: [],
      page: 2,
      pageSize: 10,
      total: 12,
      hasNextPage: false,
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.listEmployees({
        status: 'active',
        page: 2,
        pageSize: 10,
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/employees?status=active&page=2&pageSize=10',
      ),
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('searches all employee statuses through the paginated employee endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          employees: [
            {
              id: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
              fullName: 'Akhay Khan',
              workEmail: 'akhay.khan@caw.tech',
              status: 'offboarded',
            },
          ],
          page: 1,
          pageSize: 20,
          total: 1,
          hasNextPage: false,
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    );

    await expect(client.searchEmployees({ query: 'akhay' })).resolves.toEqual([
      expect.objectContaining({
        fullName: 'Akhay Khan',
        status: 'offboarded',
      }),
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/employees?query=akhay&status=all&pageSize=20',
      ),
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('lists employee email status records', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.listEmployeeEmails({
        employeeId: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
      }),
    ).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/employees/8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe/emails',
      ),
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('gets one email status record', async () => {
    const emailMessage = {
      id: '6918c459-68a4-4604-9135-624f4f858ecb',
      status: 'sent',
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(emailMessage), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.getEmailMessage({
        emailMessageId: '6918c459-68a4-4604-9135-624f4f858ecb',
      }),
    ).resolves.toEqual(emailMessage);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/email-messages/6918c459-68a4-4604-9135-624f4f858ecb',
      ),
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('resolves an employee identity', async () => {
    const result = {
      status: 'needs_confirmation',
      query: 'akhay',
      purpose: 'offboarding',
      employee: {
        employeeId: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
        fullName: 'Akhay Khan',
        workEmail: 'akhay.khan@caw.tech',
        status: 'active',
        designation: 'Backend Engineer',
        department: 'Engineering',
      },
      matches: [],
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.resolveEmployee({
        query: 'akhay',
        purpose: 'offboarding',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4000/employees/resolve'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          query: 'akhay',
          purpose: 'offboarding',
        }),
      }),
    );
  });

  it('creates a generic access request', async () => {
    const accessRequest = {
      id: '0a6f04d5-b890-42c7-99e8-e10be81b6ffe',
      action: 'revoke',
      status: 'waiting_for_approval',
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(accessRequest), {
        status: 201,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.createAccessRequest({
        employeeId: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
        systemKey: 'slack',
        resourceKey: 'workspace_membership',
        roleKey: 'member',
        action: 'revoke',
        reason: 'Remove Slack access',
        requestedByExternalUserId: 'slack:U123',
      }),
    ).resolves.toEqual(accessRequest);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4000/access-requests'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          employeeId: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
          systemKey: 'slack',
          resourceKey: 'workspace_membership',
          roleKey: 'member',
          action: 'revoke',
          reason: 'Remove Slack access',
          requestedByExternalUserId: 'slack:U123',
          requestedFrom: 'gantry',
        }),
      }),
    );
  });

  it('creates an offboarding intake', async () => {
    const result = {
      offboardingIntake: {
        id: '7c644f93-056a-40bf-815a-9512e050aab5',
      },
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 201,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.createOffboardingIntake({
        employeeId: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
        lastWorkingDay: '2026-06-30',
        reason: 'Resignation',
        requestedByExternalUserId: 'slack:U123',
        notes: 'Offboarding requested from Slack',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4000/offboarding-intakes'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          employeeId: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
          lastWorkingDay: '2026-06-30',
          reason: 'Resignation',
          requestedByExternalUserId: 'slack:U123',
          notes: 'Offboarding requested from Slack',
        }),
      }),
    );
  });

  it('auto-processes offboarding', async () => {
    const result = {
      offboardingIntake: {
        id: '7c644f93-056a-40bf-815a-9512e050aab5',
        status: 'completed',
      },
      finalized: true,
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 201,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.autoProcessOffboarding({
        employeeId: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
        lastWorkingDay: '2026-06-30',
        reason: 'Resignation',
        requestedByExternalUserId: 'slack:U123',
        notes: 'Offboarding requested from Slack',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4000/offboarding-intakes/auto-process'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          employeeId: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
          lastWorkingDay: '2026-06-30',
          reason: 'Resignation',
          requestedByExternalUserId: 'slack:U123',
          notes: 'Offboarding requested from Slack',
        }),
      }),
    );
  });

  it('searches access grants with filters', async () => {
    const result = {
      grants: [
        {
          grantId: '7c644f93-056a-40bf-815a-9512e050aab5',
          employee: {
            id: '8cb51d78-a325-46e1-94f1-8b2bc7bc4ffe',
            fullName: 'Akhay Khan',
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
            riskLevel: 'medium',
          },
          status: 'revoked',
          externalAccountId: null,
          grantedAt: null,
          revokedAt: '2026-06-25T00:00:00.000Z',
          createdAt: '2026-06-20T00:00:00.000Z',
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
      ],
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.searchAccessGrants({
        employeeQuery: 'akhay.khan@caw.tech',
        systemKey: 'slack',
        mode: 'inactive',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/employees/access-grants/search?employeeQuery=akhay.khan%40caw.tech&systemKey=slack&mode=inactive',
      ),
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('gets an access detail report', async () => {
    const result = {
      reportType: 'offboarding_audit',
      employees: [],
      accessRequests: [],
      approvals: [],
      accessTasks: [],
      accessGrants: [],
      offboardingIntakes: [],
      offboardingApprovals: [],
      auditEvents: [],
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.getAccessDetailReport({
        employeeQuery: 'akhay.khan@caw.tech',
        reportType: 'offboarding_audit',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/employees/access-detail-report?employeeQuery=akhay.khan%40caw.tech&reportType=offboarding_audit',
      ),
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('gets an offboarding intake', async () => {
    const result = {
      offboardingIntake: {
        id: '7c644f93-056a-40bf-815a-9512e050aab5',
      },
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.getOffboardingIntake({
        offboardingIntakeId: '7c644f93-056a-40bf-815a-9512e050aab5',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/offboarding-intakes/7c644f93-056a-40bf-815a-9512e050aab5',
      ),
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('decides an offboarding intake', async () => {
    const result = {
      offboardingIntake: {
        id: '7c644f93-056a-40bf-815a-9512e050aab5',
      },
      decision: {
        decision: 'approved',
      },
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 201,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.decideOffboardingIntake({
        offboardingIntakeId: '7c644f93-056a-40bf-815a-9512e050aab5',
        decision: 'approved',
        approverExternalUserId: 'slack:U_APPROVER',
        comment: 'Approved offboarding',
        source: 'slack',
        gantryConversationId: 'conversation-1',
        gantryRuntimeEventId: 'event-1',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/offboarding-intakes/7c644f93-056a-40bf-815a-9512e050aab5/decision',
      ),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          decision: 'approved',
          approverExternalUserId: 'slack:U_APPROVER',
          comment: 'Approved offboarding',
          source: 'slack',
          gantryConversationId: 'conversation-1',
          gantryRuntimeEventId: 'event-1',
        }),
      }),
    );
  });

  it('gets offboarding status', async () => {
    const result = {
      summary: {
        total: 1,
        completed: 0,
        pending: 1,
        failed: 0,
      },
      canFinalize: false,
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.getOffboardingStatus({
        offboardingIntakeId: '7c644f93-056a-40bf-815a-9512e050aab5',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/offboarding-intakes/7c644f93-056a-40bf-815a-9512e050aab5/status',
      ),
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('gets onboarding status', async () => {
    const result = {
      summary: {
        total: 1,
        completed: 1,
        pending: 0,
        failed: 0,
      },
      canFinalize: true,
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.getOnboardingStatus({
        onboardingIntakeId: '08eebdd5-c91d-4ef0-8927-89346898ca19',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/onboarding-intakes/08eebdd5-c91d-4ef0-8927-89346898ca19/status',
      ),
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('lists onboarding intakes', async () => {
    const result = {
      onboardingIntakes: [
        {
          id: '08eebdd5-c91d-4ef0-8927-89346898ca19',
          name: 'melon eusk',
          status: 'waiting_for_review',
        },
      ],
      count: 1,
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.listOnboardingIntakes({
        status: 'pending_review',
        limit: 10,
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/onboarding-intakes?status=pending_review&limit=10',
      ),
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('lists pending onboarding setups', async () => {
    const result = {
      pendingSetups: [],
      count: 0,
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.listPendingOnboardingSetups({
        limit: 10,
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/onboarding-intakes/pending-setups?limit=10',
      ),
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('lists onboarding work queue', async () => {
    const result = {
      items: [],
      count: 0,
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.listOnboardingWorkQueue({
        limit: 10,
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4000/onboarding-intakes/work-queue?limit=10'),
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('resolves onboarding intake by natural fields', async () => {
    const result = {
      onboardingIntake: {
        id: '08eebdd5-c91d-4ef0-8927-89346898ca19',
        name: 'Kartik Bansal Demo',
        status: 'approved',
      },
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.resolveOnboardingIntake({
        name: 'Kartik Bansal Demo',
        designation: 'Backend Engineer',
        doj: '2026-06-30',
        status: 'open',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4000/onboarding-intakes/resolve'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Kartik Bansal Demo',
          designation: 'Backend Engineer',
          doj: '2026-06-30',
          status: 'open',
        }),
      }),
    );
  });

  it('finalizes onboarding', async () => {
    const result = {
      onboardingIntake: {
        id: '08eebdd5-c91d-4ef0-8927-89346898ca19',
        status: 'completed',
      },
      employee: {
        status: 'active',
      },
      canFinalize: true,
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.finalizeOnboarding({
        onboardingIntakeId: '08eebdd5-c91d-4ef0-8927-89346898ca19',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/onboarding-intakes/08eebdd5-c91d-4ef0-8927-89346898ca19/finalize',
      ),
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('finalizes onboarding by employee', async () => {
    const result = {
      employee: {
        status: 'active',
      },
      duplicateWarnings: [],
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.finalizeOnboardingByEmployee({
        workEmail: 'kartik.demo@caw.tech',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4000/onboarding-intakes/finalize-by-employee'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          workEmail: 'kartik.demo@caw.tech',
        }),
      }),
    );
  });

  it('cancels onboarding intake by natural fields', async () => {
    const result = {
      onboardingIntake: {
        status: 'cancelled',
      },
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.cancelOnboardingIntake({
        name: 'Kartik Bansal Demo',
        designation: 'VP of Engineering',
        actorExternalUserId: 'slack:U_ADMIN',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4000/onboarding-intakes/cancel'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Kartik Bansal Demo',
          designation: 'VP of Engineering',
          actorExternalUserId: 'slack:U_ADMIN',
        }),
      }),
    );
  });

  it('supersedes onboarding intake by natural fields', async () => {
    const result = {
      onboardingIntake: {
        status: 'superseded',
      },
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.supersedeOnboardingIntake({
        name: 'Kartik Bansal Demo',
        designation: 'VP of Engineering',
        actorExternalUserId: 'slack:U_ADMIN',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4000/onboarding-intakes/supersede'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Kartik Bansal Demo',
          designation: 'VP of Engineering',
          actorExternalUserId: 'slack:U_ADMIN',
        }),
      }),
    );
  });

  it('continues onboarding setup', async () => {
    const result = {
      onboardingIntake: {
        id: '08eebdd5-c91d-4ef0-8927-89346898ca19',
        status: 'completed',
      },
      employee: {
        status: 'active',
      },
      finalized: true,
      executedTasks: [],
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.continueOnboardingSetup({
        onboardingIntakeId: '08eebdd5-c91d-4ef0-8927-89346898ca19',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/onboarding-intakes/08eebdd5-c91d-4ef0-8927-89346898ca19/continue-setup',
      ),
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('auto-processes onboarding from a Slack message', async () => {
    const result = {
      onboardingIntake: {
        id: '08eebdd5-c91d-4ef0-8927-89346898ca19',
        status: 'completed',
      },
      valid: true,
      nextAction: 'setup_complete',
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 201,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.autoProcessOnboardingFromSlackMessage({
        rawText: 'New Joiner Alert\nName: Riya Sharma',
        senderSlackUserId: 'U123',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4000/onboarding-intakes/slack/auto-process'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          rawText: 'New Joiner Alert\nName: Riya Sharma',
          senderSlackUserId: 'U123',
        }),
      }),
    );
  });

  it('finalizes offboarding', async () => {
    const result = {
      offboardingIntake: {
        id: '7c644f93-056a-40bf-815a-9512e050aab5',
        status: 'completed',
      },
      canFinalize: true,
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.finalizeOffboarding({
        offboardingIntakeId: '7c644f93-056a-40bf-815a-9512e050aab5',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/offboarding-intakes/7c644f93-056a-40bf-815a-9512e050aab5/finalize',
      ),
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('gets connector health diagnostics with actor authorization', async () => {
    const result = {
      connectors: [
        {
          name: 'Slack channel connector',
          enabled: true,
          mode: 'real',
          status: 'ready',
          missingConfig: [],
        },
      ],
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.getConnectorHealth({
        actorExternalUserId: 'slack:U_ADMIN',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/diagnostics/connector-health?actorExternalUserId=slack%3AU_ADMIN',
      ),
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('gets task status diagnostics by employee', async () => {
    const result = {
      tasks: [],
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      client.getTaskStatusByEmployee({
        actorExternalUserId: 'slack:U_ADMIN',
        employeeQuery: 'akhay.khan@caw.tech',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4000/diagnostics/task-status?actorExternalUserId=slack%3AU_ADMIN&employeeQuery=akhay.khan%40caw.tech',
      ),
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });
});
