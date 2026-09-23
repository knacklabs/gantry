import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/config/env/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  envValueDynamic: (key: string) =>
    ({
      MOTOR_CLAIM_EVIDENCE_AGENT_FOLDER: 'mia_test',
      MOTOR_INSURANCE_SERVICE_URL: 'http://127.0.0.1:14319',
    })[
      key as 'MOTOR_CLAIM_EVIDENCE_AGENT_FOLDER' | 'MOTOR_INSURANCE_SERVICE_URL'
    ] ?? '',
}));

import { attachmentOpenTaskHandlers } from '@core/jobs/ipc-attachment-open-handler.js';
import { taskIpcResponsePath } from '@core/jobs/ipc-shared.js';
import {
  createIpcAuthEnvelope,
  revokeIpcResponseSigningKey,
} from '@core/runtime/ipc-auth.js';

const folder = 'mia_test';
const taskId = 'evidence-copy-test';
const responsePath = taskIpcResponsePath(folder, taskId);
let responseKeyId: string | undefined;
let temporaryDirectory: string | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(responsePath, { force: true });
  if (responseKeyId) revokeIpcResponseSigningKey(responseKeyId, folder);
  if (temporaryDirectory)
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('claim evidence storage IPC', () => {
  it('copies original PDF bytes from the authorized attachment without exposing base64 to the agent', async () => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'claim-evidence-'),
    );
    const original = Buffer.from('%PDF-1.7\nClaim CLM-1234\n');
    const materializedPath = path.join(temporaryDirectory, 'estimate.pdf');
    fs.writeFileSync(materializedPath, original);
    responseKeyId = createIpcAuthEnvelope(folder).responseKeyId;
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          evidence: {
            evidenceId: 'EVD-1234',
            extractionStatus: 'extracted_unverified',
          },
          replayed: false,
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    await attachmentOpenTaskHandlers.claim_evidence_store!({
      data: {
        type: 'claim_evidence_store',
        taskId,
        appId: 'app-1',
        providerAccountId: 'slack-account',
        chatJid: 'sl:C1',
        targetJid: 'sl:C1',
        responseKeyId,
        payload: {
          attachmentId: 'attachment-1',
          claimId: 'CLM-1234',
          documentType: 'repair_estimate',
          mimeType: 'application/pdf',
          extractedText: '',
          extractedFields: {},
        },
      },
      sourceAgentFolder: folder,
      sourceAgentFolderJids: ['sl:C1'],
      conversationBindings: {},
      deps: {
        openAttachment: async () => ({
          status: 'opened',
          materializedPath,
          fileName: 'estimate.pdf',
          content: 'Claim CLM-1234',
        }),
      } as never,
    });
    const sent = JSON.parse(fetcher.mock.calls[0]![1].body as string);
    expect(Buffer.from(sent.dataBase64, 'base64')).toEqual(original);
    expect(sent.extractedText).toBe('Claim CLM-1234');
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
    expect(response).toMatchObject({
      ok: true,
      data: { evidenceId: 'EVD-1234' },
    });
    expect(JSON.stringify(response)).not.toContain(sent.dataBase64);
  });
});
