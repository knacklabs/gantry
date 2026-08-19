import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseRuntimeSettings } from '@core/config/settings/runtime-settings-parser.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';

const runtimeHomes: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('authentication settings', () => {
  it('keeps active and candidate OIDC settings distinct through YAML', () => {
    const settings = parseRuntimeSettings(`
authentication:
  mode: hosted
  canonical_origin: https://gantry.example.com
  active_oidc:
    issuer: https://issuer.example.com/
    client_id: active-client
    client_secret_ref: env:ACTIVE_SECRET
    company_domain: example.com
    provider_label: Google
  candidate_oidc:
    issuer: https://candidate.example.com
    client_id: candidate-client
    client_secret_ref: env:CANDIDATE_SECRET
    company_domain: example.com
    provider_label: Google
`);

    expect(settings.authentication.activeOidc?.issuer).toBe(
      'https://issuer.example.com',
    );
    expect(settings.authentication.candidateOidc?.clientId).toBe(
      'candidate-client',
    );
    expect(settings.runtime.deploymentMode).toBe('workstation');
    expect(renderRuntimeSettingsYaml(settings)).toContain('candidate_oidc:');
  });

  it('projects provider labels but never client IDs or secret references', async () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-auth-'));
    runtimeHomes.push(runtimeHome);
    vi.resetModules();
    vi.stubEnv('GANTRY_HOME', runtimeHome);
    const runtimeSettings =
      await import('@core/config/settings/runtime-settings.js');
    const settings = runtimeSettings.ensureRuntimeSettings(runtimeHome);
    settings.authentication = parseRuntimeSettings(`
authentication:
  mode: hosted
  canonical_origin: https://gantry.example.com
  active_oidc:
    issuer: https://issuer.example.com
    client_id: private-client-id
    client_secret_ref: env:PRIVATE_CLIENT_SECRET
    company_domain: example.com
    provider_label: Example SSO
`).authentication;
    runtimeSettings.saveRuntimeSettings(runtimeHome, settings);
    const config = await import('@core/config/index.js');

    const projection = config.getPublicRuntimeSettings().authentication;
    expect(projection).toEqual({
      mode: 'hosted',
      canonicalOrigin: 'https://gantry.example.com',
      activeProviderLabel: 'Example SSO',
      candidateConfigured: false,
    });
    expect(JSON.stringify(projection)).not.toContain('private-client-id');
    expect(JSON.stringify(projection)).not.toContain('PRIVATE_CLIENT_SECRET');
  });
});
