import { describe, expect, it, vi } from 'vitest';

import {
  HOST_CAPABILITY_TEMPLATE_PROPOSALS_ACTIVE,
  compileAndRecordHostCapabilityTemplateMismatch,
} from '@core/jobs/ipc-capability-run-handler.js';
import { semanticCapabilityInputSchema } from '@core/shared/semantic-capabilities.js';

const executablePath = '/usr/local/bin/gog';

function localCliTool(commandTemplates = [`${executablePath} sheets get *`]) {
  return {
    id: 'tool:google.sheets.read',
    appId: 'app:test',
    name: 'google.sheets.read',
    kind: 'local_cli',
    provider: 'gantry',
    displayName: 'Google Sheets read',
    category: 'productivity',
    risk: 'low',
    selectable: true,
    status: 'active',
    adapterRef: 'local-cli/gog',
    inputSchema: semanticCapabilityInputSchema({
      capabilityId: 'google.sheets.read',
      displayName: 'Google Sheets read',
      category: 'Google Sheets',
      risk: 'read',
      can: 'Read reviewed spreadsheet ranges.',
      cannot: 'Write spreadsheets or access unrelated services.',
      credentialSource: 'local_cli',
      implementationBindings: [
        {
          kind: 'local_cli',
          executablePath,
          executableVersion: '1.0.0',
          executableHash: 'sha256:gog',
          commandTemplates,
        },
      ],
    }),
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
  };
}

describe('host capability template mismatch flow', () => {
  it('records the compiler output and returns a fix-proposal blocker', async () => {
    const claimPending = vi.fn(async (input: Record<string, unknown>) => ({
      created: true,
      proposal: {
        ...input,
        status: 'pending',
        createdAt: input.now,
        updatedAt: input.now,
      },
    }));

    const result = await compileAndRecordHostCapabilityTemplateMismatch({
      appId: 'app:test',
      agentId: 'agent:main',
      requestedBy: 'main_agent',
      capabilityId: 'google.sheets.read',
      observedArgs: [
        'sheets',
        'get',
        'sheet-1',
        'Leads!A:B',
        '--account',
        'owner@example.com',
      ],
      jobId: 'job-1',
      conversationJid: 'tg:owner',
      toolRepository: {
        listTools: vi.fn(async () => [localCliTool()]),
      } as never,
      proposalRepository: { claimPending } as never,
      now: '2026-08-14T00:00:00.000Z',
    });

    expect(result.action).toEqual({
      kind: 'fix_proposal',
      proposalId: expect.stringMatching(/^capability-amendment-/),
    });
    expect(result.review?.wideningKind).toBe('expanded');
    expect(claimPending).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityId: 'google.sheets.read',
        proposedTemplates: [
          `${executablePath} sheets get * *`,
          `${executablePath} sheets get * * --account *`,
        ],
        observedArgv: [
          executablePath,
          'sheets',
          'get',
          'sheet-1',
          'Leads!A:B',
          '--account',
          '<redacted>',
        ],
      }),
    );
  });

  it('falls to instruction without recording an ineligible mismatch', async () => {
    const claimPending = vi.fn();
    const result = await compileAndRecordHostCapabilityTemplateMismatch({
      appId: 'app:test',
      agentId: 'agent:main',
      requestedBy: 'main_agent',
      capabilityId: 'google.sheets.read',
      observedArgs: ['sheets', 'get', 'range-a', 'extra'],
      toolRepository: {
        listTools: vi.fn(async () => [
          localCliTool([`${executablePath} sheets get range-*`]),
        ]),
      } as never,
      proposalRepository: { claimPending } as never,
      now: '2026-08-14T00:00:00.000Z',
    });

    expect(result.action.kind).toBe('instruction');
    expect(claimPending).not.toHaveBeenCalled();
  });

  it('activates the production proposal lane after durable intent recovery exists', () => {
    expect(HOST_CAPABILITY_TEMPLATE_PROPOSALS_ACTIVE).toBe(true);
  });
});
