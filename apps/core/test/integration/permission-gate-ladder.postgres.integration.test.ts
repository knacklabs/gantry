import fs from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { computePermissionEffectHash } from '@core/domain/permission-effect-key.js';
import { PermissionLane } from '@core/domain/permission-lane.js';
import { resolveWorkspaceFolderPath } from '@core/platform/workspace-folder.js';
import { resolvePermissionIpcDecision } from '@core/runtime/ipc-permission-classifier-decision.js';
import { classifierVerdictCacheKey } from '@core/runtime/permission-judge-outage.js';
import type { PermissionMode } from '@core/shared/permission-mode.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'default';
const FOLDER = 'main_agent';
const TARGET_JID = 'tg:gate-ladder';

maybeDescribe(
  'host permission ladder over the stored verdict cache (Postgres)',
  () => {
    let runtime: PostgresIntegrationRuntime;
    let workspaceRoot: string;

    beforeAll(async () => {
      runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'gate_ladder',
      });
      workspaceRoot = resolveWorkspaceFolderPath(FOLDER);
      fs.mkdirSync(workspaceRoot, { recursive: true });
    }, 60_000);

    afterAll(async () => {
      if (runtime) await runtime.cleanup();
    });

    function gate(input: {
      routes: () => Record<string, unknown>;
      judge?: ReturnType<typeof vi.fn>;
    }) {
      const judge =
        input.judge ??
        vi.fn(async () => ({
          risk_level: 'low' as const,
          risk_category: 'filesystem' as const,
          reason: 'A routine workspace change.',
          latencyMs: 1,
        }));
      const requestPermissionApproval = vi.fn(async () => ({
        kind: 'decision' as const,
        decision: {
          approved: false,
          mode: 'cancel' as const,
          decidedBy: 'person',
        },
      }));
      const decide = (toolName: string, toolInput: Record<string, unknown>) =>
        resolvePermissionIpcDecision({
          request: {
            requestId: `gate-${Math.random()}`,
            appId: APP_ID,
            targetJid: TARGET_JID,
            sourceAgentFolder: FOLDER,
            toolName,
            toolInput,
          },
          sourceAgentFolder: FOLDER,
          deps: {
            conversationRoutes: input.routes,
            requestPermissionApproval,
            classifierConsult: judge,
            publishRuntimeEvent: vi.fn(async () => undefined),
            getPermissionDecisionMemoryRepository: () =>
              runtime.repositories.permissionDecisionMemory,
            // No permission mode is set anywhere.
            getPermissionRuntimeSettings: () => ({
              agents: { [FOLDER]: {} },
              permissions: { autoMode: {}, trustedRoots: [workspaceRoot] },
              memory: { llm: { models: { extractor: 'sonnet' } } },
            }),
          } as never,
        });
      return { decide, judge, requestPermissionApproval };
    }

    const route = (permissionMode?: PermissionMode) => ({
      [TARGET_JID]: {
        name: 'Gate ladder',
        folder: FOLDER,
        trigger: '',
        added_at: new Date(0).toISOString(),
        ...(permissionMode ? { agentConfig: { permissionMode } } : {}),
      },
    });

    it('lets the judge decide when no mode is set, reuses its stored verdict only in the same lane, and refuses once the route is gone even with that stored allow', async () => {
      let routes: Record<string, unknown> = route();
      const chat = gate({ routes: () => routes });
      const command = { command: 'mkdir build-cache-lane' };

      await expect(chat.decide('RunCommand', command)).resolves.toMatchObject({
        approved: true,
        decidedBy: 'auto_classifier',
      });
      await expect(chat.decide('RunCommand', command)).resolves.toMatchObject({
        approved: true,
        decidedBy: 'cached_classifier_verdict',
      });
      expect(chat.judge).toHaveBeenCalledOnce();
      expect(chat.requestPermissionApproval).not.toHaveBeenCalled();

      const effectHash = computePermissionEffectHash({
        request: {
          requestId: 'hash',
          appId: APP_ID,
          targetJid: TARGET_JID,
          sourceAgentFolder: FOLDER,
          toolName: 'RunCommand',
          toolInput: command,
        },
        workspaceRoot,
      })!;
      await expect(
        runtime.repositories.permissionDecisionMemory.getClassifierVerdict({
          appId: APP_ID,
          agentFolder: FOLDER,
          effectHash: classifierVerdictCacheKey({
            effectHash,
            lane: PermissionLane.InteractiveAuto,
          }),
        }),
      ).resolves.toMatchObject({ decision: 'allow' });

      // The same action under auto_strict never reads the interactive verdict.
      routes = route('auto_strict');
      const strict = gate({ routes: () => routes });
      await expect(
        strict.decide('RunCommand', command),
      ).resolves.not.toMatchObject({ decidedBy: 'cached_classifier_verdict' });

      routes = {};
      const gone = gate({ routes: () => routes });
      await expect(gone.decide('RunCommand', command)).resolves.toMatchObject({
        approved: false,
        decidedBy: 'route',
      });
      expect(gone.judge).not.toHaveBeenCalled();
      expect(gone.requestPermissionApproval).not.toHaveBeenCalled();
    });

    it('asks a person for a hard rule and an admin action even when a stored verdict and the judge would allow them', async () => {
      for (const [toolName, toolInput] of [
        ['RunCommand', { command: 'rm -rf build-ladder' }],
        ['mcp__gantry__service_restart', { reason: 'apply settings' }],
      ] as const) {
        const effectHash = computePermissionEffectHash({
          request: {
            requestId: 'seed',
            appId: APP_ID,
            targetJid: TARGET_JID,
            sourceAgentFolder: FOLDER,
            toolName,
            toolInput,
          },
          workspaceRoot,
        })!;
        await runtime.repositories.permissionDecisionMemory.putClassifierVerdict(
          {
            appId: APP_ID,
            agentFolder: FOLDER,
            effectHash: classifierVerdictCacheKey({
              effectHash,
              lane: PermissionLane.InteractiveAuto,
            }),
            decision: 'allow',
            reason: 'A stale stored allow.',
            risk_level: 'low',
            effectSchemaVersion: 3,
            railVersion: 2,
            provenance: 'classifier',
            nowIso: new Date().toISOString(),
          },
        );
        const ladder = gate({ routes: () => route() });

        await expect(ladder.decide(toolName, toolInput)).resolves.toMatchObject(
          {
            approved: false,
            decidedBy: 'person',
          },
        );
        expect(ladder.judge).not.toHaveBeenCalled();
        expect(ladder.requestPermissionApproval).toHaveBeenCalledOnce();
        expect(
          ladder.requestPermissionApproval.mock.calls[0]![0],
        ).toMatchObject({ decisionOptions: ['allow_once', 'cancel'] });
      }
    });
  },
);
