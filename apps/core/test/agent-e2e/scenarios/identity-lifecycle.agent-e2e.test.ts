// User-facing identity lifecycle through the packaged runtime's public APIs.
// One scenario proves the relationship, not individual implementation units:
// resolve -> memory -> preview -> merge -> resolve -> unmerge -> isolation.

import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { AgentE2EApiClient } from '../harness/api-client.js';
import { startEvidenceRun, type EvidenceRun } from '../harness/evidence.js';
import {
  startRuntimeHarness,
  type RuntimeHarness,
} from '../harness/runtime-harness.js';

const hasDb = Boolean(process.env.GANTRY_TEST_DATABASE_URL?.trim());
const maybeDescribe = hasDb ? describe : describe.skip;
const TIMEOUT_MS = 300_000;

interface IdentityResolution {
  status: 'resolved' | 'created' | 'unresolved';
  personId: string | null;
  memoryHydrationEligible: boolean;
  matchedAlias?: { externalUserId: string };
  createdAlias?: { externalUserId: string };
}

interface Person {
  personId: string;
  status: 'active' | 'disabled' | 'archived';
  aliases?: Array<{ externalUserId: string; personId: string }>;
  memoryCounts?: { personal: number; active: number };
}

interface MemoryItem {
  id: string;
  personId?: string;
  key: string;
}

interface MergePreview {
  summary: 'Merge preview only. No data changed.';
  sourcePersonId: string;
  targetPersonId: string;
  memoryRowsToMove: number;
  fingerprint: string;
}

interface MergeResult {
  summary: 'Person merge completed. Personal memory and aliases now belong to the target person.';
  sourcePersonId: string;
  targetPersonId: string;
  auditId: string;
  applied: boolean;
}

interface UnmergeResult {
  summary: 'Person unmerge completed. The archived person and merge-owned data were restored.';
  auditId: string;
  sourcePersonId: string;
  targetPersonId: string;
  memoryRowsRestored: number;
  restoredPerson: Person;
}

maybeDescribe('agent-e2e identity lifecycle (public API)', () => {
  let harness: RuntimeHarness | undefined;
  let evidence: EvidenceRun | undefined;
  let sawFailure = false;

  afterAll(async () => {
    if (evidence && harness) {
      if (sawFailure) {
        evidence.evidence.redactedFailure = harness.logs().slice(-6000);
      }
      evidence.write(
        process.env.AGENT_E2E_EVIDENCE_DIR ??
          path.join(os.tmpdir(), 'gantry-agent-e2e-evidence'),
      );
    }
    await harness?.teardown({ failed: sawFailure });
  });

  it(
    'merges and restores two people without crossing app or scope boundaries',
    { timeout: TIMEOUT_MS },
    async () => {
      try {
        harness = await startRuntimeHarness({
          scopes: [
            'identity:resolve',
            'people:read',
            'people:admin',
            'memory:read',
            'memory:admin',
          ],
          additionalControlKeys: [
            {
              kid: 'identity-resolve-only',
              scopes: ['identity:resolve'],
            },
          ],
        });
        const admin = new AgentE2EApiClient(harness.baseUrl, harness.apiKey);
        const resolver = new AgentE2EApiClient(
          harness.baseUrl,
          harness.controlApiKeys['identity-resolve-only']!,
        );
        evidence = startEvidenceRun({
          scenario: 'identity-lifecycle',
          secrets: harness.secrets,
        });

        const resolve = async (
          api: AgentE2EApiClient,
          externalUserId: string,
          createIfMissing: boolean,
        ) =>
          await api.request<IdentityResolution>(
            'POST',
            '/v1/identity/resolve',
            {
              body: {
                provider: 'app',
                providerAccountId: 'control:identity-e2e',
                externalUserId,
                displayName: externalUserId,
                evidenceType: 'web_user',
                createIfMissing,
              },
            },
          );

        evidence.phase('resolve-identities');
        const targetExternalId = 'identity-e2e-target';
        const sourceExternalId = 'identity-e2e-source';
        const targetCreated = await resolve(admin, targetExternalId, true);
        const sourceCreated = await resolve(admin, sourceExternalId, true);
        expect(targetCreated.status).toBe(200);
        expect(sourceCreated.status).toBe(200);
        expect(targetCreated.body.status).toBe('created');
        expect(sourceCreated.body.status).toBe('created');
        expect(targetCreated.body.personId).toBeTruthy();
        expect(sourceCreated.body.personId).toBeTruthy();
        expect(targetCreated.body.personId).not.toBe(
          sourceCreated.body.personId,
        );
        const targetPersonId = targetCreated.body.personId!;
        const sourcePersonId = sourceCreated.body.personId!;

        const targetResolvedAgain = await resolve(
          admin,
          targetExternalId,
          true,
        );
        expect(targetResolvedAgain.status).toBe(200);
        expect(targetResolvedAgain.body).toMatchObject({
          status: 'resolved',
          personId: targetPersonId,
        });

        const redacted = await resolve(resolver, targetExternalId, true);
        expect(redacted.status).toBe(200);
        expect(redacted.body.personId).toBe(targetPersonId);
        expect(redacted.body.matchedAlias).toBeUndefined();
        expect(redacted.body.createdAlias).toBeUndefined();
        expect(JSON.stringify(redacted.body)).not.toContain(targetExternalId);

        const refusedCreate = await resolve(
          resolver,
          'identity-e2e-resolve-only-missing',
          true,
        );
        expect(refusedCreate.status).toBe(200);
        expect(refusedCreate.body).toMatchObject({
          status: 'unresolved',
          personId: null,
        });

        const people = await admin.request<{ people: Person[] }>(
          'GET',
          '/v1/people',
        );
        expect(people.status).toBe(200);
        expect(people.body.people.map((person) => person.personId)).toEqual(
          expect.arrayContaining([targetPersonId, sourcePersonId]),
        );

        evidence.phase('save-personal-memory');
        const saveMemory = async (personId: string, key: string) =>
          await admin.request<{ memory: MemoryItem }>('POST', '/v1/memory', {
            body: {
              agentId: 'agent:main_agent',
              personId,
              subjectType: 'user',
              kind: 'fact',
              key,
              value: `value-for-${key}`,
              source: 'agent-e2e',
              confidence: 1,
            },
          });
        const targetMemory = await saveMemory(
          targetPersonId,
          'identity-e2e-target-memory',
        );
        const sourceMemory = await saveMemory(
          sourcePersonId,
          'identity-e2e-source-memory',
        );
        expect(targetMemory.status).toBe(201);
        expect(sourceMemory.status).toBe(201);
        expect(targetMemory.body.memory.personId).toBe(targetPersonId);
        expect(sourceMemory.body.memory.personId).toBe(sourcePersonId);

        evidence.phase('preview-merge');
        const preview = await admin.request<MergePreview>(
          'POST',
          `/v1/people/${encodeURIComponent(targetPersonId)}/merge:preview`,
          { body: { sourcePersonId } },
        );
        expect(preview.status, JSON.stringify(preview.body)).toBe(200);
        expect(preview.body).toMatchObject({
          summary: 'Merge preview only. No data changed.',
          sourcePersonId,
          targetPersonId,
          memoryRowsToMove: 1,
        });
        expect(preview.body.fingerprint).toMatch(/^sha256:/);

        const sourceAfterPreview = await admin.request<{ person: Person }>(
          'GET',
          `/v1/people/${encodeURIComponent(sourcePersonId)}`,
        );
        expect(sourceAfterPreview.status).toBe(200);
        expect(sourceAfterPreview.body.person.status).toBe('active');
        const sourceMemoryAfterPreview = await admin.request<{
          memories: MemoryItem[];
        }>(
          'GET',
          `/v1/memory?agentId=agent%3Amain_agent&personId=${encodeURIComponent(sourcePersonId)}`,
        );
        expect(sourceMemoryAfterPreview.status).toBe(200);
        expect(
          sourceMemoryAfterPreview.body.memories.map((memory) => memory.id),
        ).toContain(sourceMemory.body.memory.id);

        evidence.phase('apply-merge');
        const merged = await admin.request<MergeResult>(
          'POST',
          `/v1/people/${encodeURIComponent(targetPersonId)}/merge`,
          {
            body: {
              sourcePersonId,
              fingerprint: preview.body.fingerprint,
              idempotencyKey: 'identity-e2e-merge',
            },
          },
        );
        expect(merged.status, JSON.stringify(merged.body)).toBe(200);
        expect(merged.body).toMatchObject({
          summary:
            'Person merge completed. Personal memory and aliases now belong to the target person.',
          sourcePersonId,
          targetPersonId,
          applied: true,
        });
        evidence.evidence.auditIds.push(merged.body.auditId);

        const oldAliasAfterMerge = await resolve(
          admin,
          sourceExternalId,
          false,
        );
        expect(oldAliasAfterMerge.status).toBe(200);
        expect(oldAliasAfterMerge.body.personId).toBe(targetPersonId);
        const targetMemoriesAfterMerge = await admin.request<{
          memories: MemoryItem[];
        }>(
          'GET',
          `/v1/memory?agentId=agent%3Amain_agent&personId=${encodeURIComponent(targetPersonId)}`,
        );
        expect(targetMemoriesAfterMerge.status).toBe(200);
        expect(
          targetMemoriesAfterMerge.body.memories.map((memory) => memory.id),
        ).toEqual(
          expect.arrayContaining([
            targetMemory.body.memory.id,
            sourceMemory.body.memory.id,
          ]),
        );

        evidence.phase('unmerge');
        const unmerged = await admin.request<UnmergeResult>(
          'POST',
          `/v1/people/${encodeURIComponent(targetPersonId)}/unmerge`,
          {
            body: {
              auditId: merged.body.auditId,
              fingerprint: preview.body.fingerprint,
            },
          },
        );
        expect(unmerged.status, JSON.stringify(unmerged.body)).toBe(200);
        expect(unmerged.body).toMatchObject({
          summary:
            'Person unmerge completed. The archived person and merge-owned data were restored.',
          auditId: merged.body.auditId,
          sourcePersonId,
          targetPersonId,
          memoryRowsRestored: 1,
          restoredPerson: { personId: sourcePersonId, status: 'active' },
        });

        const oldAliasAfterUnmerge = await resolve(
          admin,
          sourceExternalId,
          false,
        );
        expect(oldAliasAfterUnmerge.status).toBe(200);
        expect(oldAliasAfterUnmerge.body.personId).toBe(sourcePersonId);
        const sourceMemoriesAfterUnmerge = await admin.request<{
          memories: MemoryItem[];
        }>(
          'GET',
          `/v1/memory?agentId=agent%3Amain_agent&personId=${encodeURIComponent(sourcePersonId)}`,
        );
        expect(sourceMemoriesAfterUnmerge.status).toBe(200);
        expect(
          sourceMemoriesAfterUnmerge.body.memories.map((memory) => memory.id),
        ).toContain(sourceMemory.body.memory.id);

        evidence.phase('verify-isolation-and-events');
        const crossApp = await admin.request(
          'GET',
          `/v1/people/${encodeURIComponent(sourcePersonId)}?appId=other-app`,
        );
        expect(crossApp.status).toBe(403);

        const database = new Client({ connectionString: harness.databaseUrl });
        await database.connect();
        try {
          const events = await database.query<{ event_type: string }>(
            `SELECT event_type
               FROM "gantry"."runtime_events"
              WHERE app_id = $1
                AND event_type = ANY($2::text[])
              ORDER BY event_id`,
            [
              'default',
              ['identity.resolved', 'identity.merged', 'identity.unmerged'],
            ],
          );
          expect(events.rows.map((event) => event.event_type)).toEqual(
            expect.arrayContaining([
              'identity.resolved',
              'identity.merged',
              'identity.unmerged',
            ]),
          );
        } finally {
          await database.end();
        }
        evidence.finishPhases();
      } catch (error) {
        sawFailure = true;
        throw error;
      }
    },
  );
});
