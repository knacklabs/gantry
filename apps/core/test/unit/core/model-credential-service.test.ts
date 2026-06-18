import { describe, expect, it, vi } from 'vitest';

import {
  fingerprintCredential,
  fingerprintCredentialPayload,
  ModelCredentialService,
} from '@core/application/model-credentials/model-credential-service.js';
import type { AppId } from '@core/domain/app/app.js';
import type {
  ModelCredential,
  ModelCredentialMetadata,
  ModelCredentialProvider,
} from '@core/domain/model-credentials/model-credentials.js';
import type { ModelCredentialRepository } from '@core/domain/ports/repositories.js';
import {
  getModelProviderDefinition,
  type ModelCredentialModeDefinition,
} from '@core/shared/model-provider-registry.js';

const appId = 'default' as AppId;

class InMemoryModelCredentialRepository implements ModelCredentialRepository {
  private readonly rows = new Map<string, ModelCredential>();

  async getModelCredential(input: {
    appId: ModelCredential['appId'];
    providerId: ModelCredentialProvider;
  }): Promise<ModelCredential | null> {
    return this.rows.get(`${input.appId}:${input.providerId}`) ?? null;
  }

  async listModelCredentials(input: {
    appId: ModelCredentialMetadata['appId'];
  }): Promise<ModelCredentialMetadata[]> {
    return [...this.rows.values()]
      .filter((row) => row.appId === input.appId)
      .map(({ payload: _payload, ...metadata }) => metadata);
  }

  async upsertModelCredential(input: {
    appId: ModelCredentialMetadata['appId'];
    providerId: ModelCredentialProvider;
    authMode: string;
    schemaVersion: number;
    payload: Record<string, string>;
    fingerprint: string;
    fieldFingerprints: Array<{ field: string; fingerprint: string }>;
    actor?: string;
    now?: string;
  }): Promise<ModelCredentialMetadata> {
    const now = input.now ?? new Date().toISOString();
    const key = `${input.appId}:${input.providerId}`;
    const existing = this.rows.get(key);
    const row: ModelCredential = {
      id: `model-credential:${key}` as never,
      appId: input.appId,
      providerId: input.providerId,
      authMode: input.authMode,
      status: 'active',
      schemaVersion: input.schemaVersion,
      payload: input.payload,
      fingerprint: input.fingerprint,
      fieldFingerprints: input.fieldFingerprints,
      ...(existing?.createdBy ? { createdBy: existing.createdBy } : {}),
      ...(input.actor ? { updatedBy: input.actor } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (!existing && input.actor) row.createdBy = input.actor;
    this.rows.set(key, row);
    const { payload: _payload, ...metadata } = row;
    return metadata;
  }

  async disableModelCredential(input: {
    appId: ModelCredentialMetadata['appId'];
    providerId: ModelCredentialProvider;
    actor?: string;
    now?: string;
  }): Promise<ModelCredentialMetadata | null> {
    const key = `${input.appId}:${input.providerId}`;
    const existing = this.rows.get(key);
    if (!existing) return null;
    const row: ModelCredential = {
      ...existing,
      status: 'disabled',
      ...(input.actor ? { updatedBy: input.actor } : {}),
      updatedAt: input.now ?? new Date().toISOString(),
    };
    this.rows.set(key, row);
    const { payload: _payload, ...metadata } = row;
    return metadata;
  }
}

describe('ModelCredentialService', () => {
  it('stores redacted metadata and returns active secret only while enabled', async () => {
    const audit = vi.fn(async () => undefined);
    const service = new ModelCredentialService(
      new InMemoryModelCredentialRepository(),
      audit,
    );

    const created = await service.set({
      appId,
      providerId: 'Anthropic',
      authMode: 'api_key',
      payload: { apiKey: '  sk-ant-test  ' },
      actor: 'owner',
    });

    expect(created).toMatchObject({
      providerId: 'anthropic',
      authMode: 'api_key',
      status: 'active',
      fingerprint: fingerprintCredentialPayload({ apiKey: 'sk-ant-test' }),
      fieldFingerprints: [
        { field: 'apiKey', fingerprint: fingerprintCredential('sk-ant-test') },
      ],
    });
    expect(
      await service.getActiveCredential({ appId, providerId: 'anthropic' }),
    ).toMatchObject({ payload: { apiKey: 'sk-ant-test' } });

    const listed = await service.list({ appId });
    expect(listed.find((row) => row.providerId === 'anthropic')).toMatchObject({
      configured: true,
      authMode: 'api_key',
      status: 'active',
      health: 'ready',
      fingerprint: created.fingerprint,
      credentialModes: expect.arrayContaining([
        expect.objectContaining({
          id: 'api_key',
          gatewayAuthStrategy: 'header',
          fields: [
            expect.objectContaining({
              name: 'apiKey',
              secret: true,
              required: true,
            }),
          ],
        }),
      ]),
    });
    expect(listed.find((row) => row.providerId === 'openrouter')).toMatchObject(
      {
        configured: false,
        status: 'disabled',
        health: 'missing',
        fingerprint: null,
      },
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        appId,
        actor: 'owner',
        eventType: 'credential.model.updated',
        payload: expect.objectContaining({
          providerId: 'anthropic',
          fingerprint: created.fingerprint,
        }),
      }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('sk-ant-test');

    await service.disable({ appId, providerId: 'anthropic', actor: 'owner' });
    expect(
      await service.getActiveCredential({ appId, providerId: 'anthropic' }),
    ).toBeNull();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'credential.model.disabled',
        payload: expect.objectContaining({
          providerId: 'anthropic',
          fingerprint: created.fingerprint,
        }),
      }),
    );
  });

  it('reports only active providers via getConfiguredModelProviders', async () => {
    const service = new ModelCredentialService(
      new InMemoryModelCredentialRepository(),
    );
    await service.set({
      appId,
      providerId: 'groq',
      authMode: 'api_key',
      payload: { apiKey: 'gsk-test' },
    });
    await service.set({
      appId,
      providerId: 'cerebras',
      authMode: 'api_key',
      payload: { apiKey: 'csk-test' },
    });
    await service.disable({ appId, providerId: 'cerebras' });

    const configured = await service.getConfiguredModelProviders({ appId });
    expect(configured.has('groq')).toBe(true);
    // Disabled credentials do not count as configured.
    expect(configured.has('cerebras')).toBe(false);
    expect(configured.has('together')).toBe(false);
  });

  it('rejects unsupported providers and empty values', async () => {
    const service = new ModelCredentialService(
      new InMemoryModelCredentialRepository(),
    );

    await expect(
      service.set({
        appId,
        providerId: 'bogus',
        payload: { apiKey: 'secret' },
      }),
    ).rejects.toThrow('Model credential provider must be one of');
    await expect(
      service.set({
        appId,
        providerId: 'anthropic',
        authMode: 'api_key',
        payload: { apiKey: '   ' },
      }),
    ).rejects.toThrow(
      'Credential field apiKey is required for anthropic api_key.',
    );
    await expect(
      service.set({
        appId,
        providerId: 'bedrock',
        authMode: 'bedrock_api_key',
        payload: { region: 'us-east-1.example.com', apiKey: 'secret' },
      }),
    ).rejects.toThrow(
      'Credential field region is invalid for bedrock bedrock_api_key.',
    );
    await expect(
      service.set({
        appId,
        providerId: 'vertex',
        authMode: 'service_account',
        payload: {
          region: 'global',
          projectId: 'gantry-test',
          serviceAccountJson: '{}',
        },
      }),
    ).rejects.toThrow(
      'Credential field serviceAccountJson is invalid for vertex service_account.',
    );
  });

  it('rotates only supplied fields in the existing auth mode', async () => {
    const service = new ModelCredentialService(
      new InMemoryModelCredentialRepository(),
    );
    await service.set({
      appId,
      providerId: 'anthropic',
      authMode: 'api_key',
      payload: { apiKey: 'sk-ant-old' },
    });

    const rotated = await service.rotate({
      appId,
      providerId: 'anthropic',
      payload: { apiKey: 'sk-ant-new' },
      actor: 'owner',
    });

    expect(rotated).toMatchObject({
      providerId: 'anthropic',
      authMode: 'api_key',
      status: 'active',
      fieldFingerprints: [
        { field: 'apiKey', fingerprint: fingerprintCredential('sk-ant-new') },
      ],
    });
    await expect(
      service.rotate({
        appId,
        providerId: 'anthropic',
        payload: {},
      }),
    ).rejects.toThrow('Credential payload must include at least one field.');
    await expect(
      service.rotate({
        appId,
        providerId: 'anthropic',
        payload: { bogus: 'value' },
      }),
    ).rejects.toThrow(
      'Credential field bogus is not supported for anthropic api_key.',
    );
  });

  it('keeps omitted structured fields during partial rotation', async () => {
    const provider = getModelProviderDefinition('anthropic')!;
    const originalModes = provider.credentialModes;
    const structuredMode: ModelCredentialModeDefinition = {
      ...originalModes[0]!,
      fields: [
        ...originalModes[0]!.fields,
        {
          name: 'endpoint',
          label: 'Anthropic endpoint',
          secret: false,
          required: true,
        },
      ],
    };
    (
      provider as { credentialModes: readonly ModelCredentialModeDefinition[] }
    ).credentialModes = [structuredMode];
    try {
      const service = new ModelCredentialService(
        new InMemoryModelCredentialRepository(),
      );
      await service.set({
        appId,
        providerId: 'anthropic',
        payload: {
          apiKey: 'sk-ant-old',
          endpoint: 'https://api.anthropic.com',
        },
      });

      const rotated = await service.rotate({
        appId,
        providerId: 'anthropic',
        payload: { apiKey: 'sk-ant-new' },
      });
      const active = await service.getActiveCredential({
        appId,
        providerId: 'anthropic',
      });
      const listed = await service.list({ appId });

      expect(active?.payload).toEqual({
        apiKey: 'sk-ant-new',
        endpoint: 'https://api.anthropic.com',
      });
      expect(
        rotated.fieldFingerprints.map((item) => item.field).sort(),
      ).toEqual(['apiKey', 'endpoint']);
      expect(
        listed.find((row) => row.providerId === 'anthropic')?.configuredFields,
      ).toEqual(['apiKey', 'endpoint']);
    } finally {
      (
        provider as {
          credentialModes: readonly ModelCredentialModeDefinition[];
        }
      ).credentialModes = originalModes;
    }
  });

  it('rejects rotation for missing or disabled credentials', async () => {
    const service = new ModelCredentialService(
      new InMemoryModelCredentialRepository(),
    );

    await expect(
      service.rotate({
        appId,
        providerId: 'anthropic',
        payload: { apiKey: 'sk-ant-new' },
      }),
    ).rejects.toThrow('No anthropic model credential is configured.');

    await service.set({
      appId,
      providerId: 'anthropic',
      authMode: 'api_key',
      payload: { apiKey: 'sk-ant-old' },
    });
    await service.disable({ appId, providerId: 'anthropic' });

    await expect(
      service.rotate({
        appId,
        providerId: 'anthropic',
        payload: { apiKey: 'sk-ant-new' },
      }),
    ).rejects.toThrow('Cannot rotate disabled anthropic model credential.');
  });
});
