import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelCredentialService } from '@core/application/model-credentials/model-credential-service.js';
import type { AppId } from '@core/domain/app/app.js';
import {
  createDefaultRuntimeSettings,
  ensureConfiguredConversationBinding,
} from '@core/config/settings/runtime-settings.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
} from '../harness/postgres-integration-runtime.js';

const terminal = vi.hoisted(() => ({
  note: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: terminal.note,
  isCancel: () => false,
  select: async (input: { message: string }) => {
    expect(input.message, JSON.stringify(terminal.warn.mock.calls)).toBe(
      'Setup complete. What should Gantry do now?',
    );
    return 'next';
  },
  log: {
    ...terminal,
    info: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Owner: setup-probes-the-same-credentials-twice.
// Real setup and doctor own the decision; only provider HTTP and terminal input
// are replaced. Existing setup tests stub doctor and cannot detect a second probe.
(hasPostgresIntegrationDatabase ? describe : describe.skip)(
  'setup checks credentials once and reuses doctor results',
  () => {
    it.each([false, true])(
      'finishes verification with its saved live-check skip choice = %s',
      async (skipLiveCheck) => {
        const encryptionKey = Buffer.from(
          '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f',
          'hex',
        ).toString('base64');
        vi.stubEnv('SECRET_ENCRYPTION_KEY', encryptionKey);
        vi.stubEnv(
          'GANTRY_DATABASE_URL',
          process.env.GANTRY_TEST_DATABASE_URL!,
        );
        const runtime = await createPostgresIntegrationRuntime({
          schemaPrefix: 'setup_verification',
        });
        await runtime.service.pool.query(
          'CREATE EXTENSION IF NOT EXISTS pg_trgm',
        );
        const runtimeHome = fs.mkdtempSync(
          path.join(os.tmpdir(), 'gantry-setup-verification-'),
        );
        try {
          vi.stubEnv('GANTRY_HOME', runtimeHome);
          fs.writeFileSync(
            path.join(runtimeHome, '.env'),
            `GANTRY_DATABASE_URL=${process.env.GANTRY_TEST_DATABASE_URL}\nSECRET_ENCRYPTION_KEY=${encryptionKey}\nTELEGRAM_BOT_TOKEN=123456:test-token\n`,
          );
          const settings = createDefaultRuntimeSettings();
          settings.providers.telegram.enabled = true;
          settings.storage.postgres.schema = runtime.schemaName;
          settings.agent.defaultModel = 'opus';
          settings.memory.enabled = false;
          settings.runtime.sandbox.provider = 'direct';
          const binding = ensureConfiguredConversationBinding(settings, {
            agentId: 'setup_verification',
            agentName: 'Setup',
            agentFolder: 'setup_verification',
            jid: 'tg:setup-verification',
            displayName: 'Setup',
            trigger: '@Setup',
            requiresTrigger: false,
            approverIds: ['123'],
          });
          settings.providerAccounts[
            binding.providerConnectionId
          ].runtimeSecretRefs.bot_token = 'env:TELEGRAM_BOT_TOKEN';
          fs.writeFileSync(
            path.join(runtimeHome, 'settings.yaml'),
            renderRuntimeSettingsYaml(settings),
          );
          await new ModelCredentialService(
            runtime.repositories.modelCredentials,
          ).set({
            appId: 'default' as AppId,
            providerId: 'anthropic',
            authMode: 'api_key',
            payload: { apiKey: 'test-provider-key' },
          });
          await runtime.ops.setConversationRoute('tg:setup-verification', {
            name: 'Setup',
            folder: 'setup_verification',
            trigger: '@Setup',
            added_at: '2026-10-02T00:00:00.000Z',
            requiresTrigger: false,
          });
          const { createInitialState, writeOnboardingState } =
            await import('@core/cli/onboarding-state.js');
          const state = createInitialState(runtimeHome);
          state.currentStep = 'verify';
          state.data.credentialLiveSkipProviderIds = skipLiveCheck
            ? ['anthropic']
            : [];
          writeOnboardingState(runtimeHome, state);
          // Give doctor an installed runtime entry without depending on a repo build.
          const cliDir = path.join(runtimeHome, 'package', 'cli');
          fs.mkdirSync(cliDir, { recursive: true });
          fs.writeFileSync(path.join(runtimeHome, 'package', 'index.js'), '');
          const modelRequests: string[] = [];
          vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string | URL | Request) => {
              const url = String(input);
              if (url.startsWith('https://api.anthropic.com/')) {
                modelRequests.push(url);
                return Response.json({ data: [] });
              }
              if (url.startsWith('https://api.telegram.org/')) {
                return Response.json({
                  ok: true,
                  result: { id: 123456, is_bot: true, username: 'setup_bot' },
                });
              }
              throw new Error(`Unexpected provider request: ${url}`);
            }),
          );
          const { runSetupFlow } = await import('@core/cli/setup-flow.js');
          const result = await runSetupFlow({
            runtimeHome,
            importMetaUrl: pathToFileURL(path.join(cliDir, 'index.js')).href,
          });
          expect(result.status, JSON.stringify(terminal.note.mock.calls)).toBe(
            'completed',
          );
          expect(modelRequests).toHaveLength(skipLiveCheck ? 0 : 1);
          expect(terminal.success).toHaveBeenCalledWith(
            'Active model credentials found for selected defaults: anthropic.\nVerification passed.',
          );
          expect(terminal.warn).not.toHaveBeenCalled();
        } finally {
          await runtime.cleanup();
          fs.rmSync(runtimeHome, { recursive: true, force: true });
        }
      },
    );
  },
);
