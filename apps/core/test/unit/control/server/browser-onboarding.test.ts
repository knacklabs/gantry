import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { channelSetupManifestFor } from '@core/channels/control-provider-catalog.js';
import { isBrowserOnboardingPath } from '@core/control/server/routes/browser-onboarding.js';
import { onboardingChallengeText } from '@core/control/server/routes/browser-onboarding-challenge.js';
import { AGENT_HARNESSES } from '@core/shared/agent-engine.js';
import { isOnboardingChallengeMessage } from '@core/adapters/storage/postgres/repositories/onboarding-verification-correlation.postgres.js';
import { requestHasBody } from '@core/control/server/routes/browser-model-providers.js';

const repoRoot = path.resolve(
  new URL('../../../../../..', import.meta.url).pathname,
);
const source = [
  'browser-onboarding.ts',
  'browser-onboarding-auth.ts',
  'browser-onboarding-challenge.ts',
  'browser-onboarding-setup.ts',
  'browser-onboarding-status.ts',
  'browser-onboarding-verification.ts',
  'browser-onboarding-verification-create.ts',
]
  .map((file) =>
    fs.readFileSync(
      path.join(repoRoot, 'apps/core/src/control/server/routes', file),
      'utf8',
    ),
  )
  .join('\n');
const dispatchSource = fs.readFileSync(
  path.join(repoRoot, 'apps/core/src/control/server/browser-route-dispatch.ts'),
  'utf8',
);
const openApiSource = fs.readFileSync(
  path.join(repoRoot, 'apps/core/src/control/server/openapi.ts'),
  'utf8',
);
const modelRouteSource = fs.readFileSync(
  path.join(
    repoRoot,
    'apps/core/src/control/server/routes/browser-model-providers.ts',
  ),
  'utf8',
);
const modelServiceSource = fs.readFileSync(
  path.join(
    repoRoot,
    'apps/core/src/application/model-credentials/model-credential-service.ts',
  ),
  'utf8',
);
const channelSource = fs.readFileSync(
  path.join(
    repoRoot,
    'apps/core/src/control/server/routes/browser-channel-accounts.ts',
  ),
  'utf8',
);

describe('browser onboarding route', () => {
  it('matches only the onboarding status endpoint', () => {
    expect(isBrowserOnboardingPath('/ui/api/onboarding/status')).toBe(true);
    expect(isBrowserOnboardingPath('/ui/api/onboarding/verifications')).toBe(
      true,
    );
    expect(isBrowserOnboardingPath('/ui/api/onboarding/channel-manifest')).toBe(
      true,
    );
    expect(
      isBrowserOnboardingPath(
        '/ui/api/onboarding/verifications/onboarding-verification:one',
      ),
    ).toBe(true);
    expect(isBrowserOnboardingPath('/ui/api/onboarding')).toBe(false);
  });

  it('does not mistake the runtime seed agent for an onboarded employee', () => {
    expect(source).toContain('DEFAULT_AGENT_ID');
    expect(source).toMatch(
      /const onboardingAgents = agents\.filter\(\s*\(agent\) => agent\.id !== DEFAULT_AGENT_ID,?\s*\);/,
    );
    expect(source).toContain('firstRun: onboardingAgents.length === 0');
  });

  it('requires a real conversation installation before issuing a challenge', () => {
    expect(source).toContain('isAgentEnabledInConversation({');
    expect(source).toContain(
      'Install this employee in the selected conversation before verifying it.',
    );
    expect(source).toContain('listConversationApprovers(');
    expect(source).toContain(
      'Assign a verified approver before preparing the test message.',
    );
  });

  it('uses durable setup, install, and approver records for resume', () => {
    expect(source).toContain('onboardingSetupsPostgres');
    expect(source).toContain('const setupAgentIds = new Set(');
    expect(source).toContain('listConversationInstalls(');
    expect(source).toContain('listConversationApprovers(');
    expect(source).toContain('assignmentReady: Boolean(install && approver)');
    expect(source).toContain(
      "if (verificationStatus === 'completed') return null;",
    );
    expect(source).toContain('const activeVerification = [');
    expect(source).toContain("'inbound_received'");
  });

  it('generates challenge codes at the server trust boundary', () => {
    expect(source).toContain(
      "const challenge = `GY-${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`;",
    );
    expect(source).not.toContain('payload.challenge');
    expect(source).toContain('function onboardingChallengeText(');
    expect(source).toContain('challengeText: onboardingChallengeText(');
    expect(onboardingChallengeText('Atlas Ops', 'GY-4K7P')).toBe(
      '@atlas-ops are you there? · GY-4K7P',
    );
  });

  it('avoids onboarding writes for ordinary inbound messages', () => {
    expect(isOnboardingChallengeMessage('hello Atlas')).toBe(false);
    expect(
      isOnboardingChallengeMessage('@atlas are you there? · GY-4K7P'),
    ).toBe(true);
  });

  it('treats an explicit zero content length as an empty verification request', () => {
    expect(requestHasBody({ 'content-length': '0' })).toBe(false);
    expect(requestHasBody({ 'content-length': '2' })).toBe(true);
    expect(requestHasBody({ 'transfer-encoding': 'chunked' })).toBe(true);
  });

  it('binds verification creation and message correlation to a provider account', () => {
    expect(source).toContain(
      'providerAccountId: conversation.providerAccountId',
    );
    const repository = fs.readFileSync(
      path.join(
        repoRoot,
        'apps/core/src/adapters/storage/postgres/repositories/onboarding-verification-correlation.postgres.ts',
      ),
      'utf8',
    );
    expect(repository).toContain(
      'onboardingVerificationsPostgres.providerAccountId',
    );
    expect(repository).toContain('"onboarding_inbound"."created_at" <=');
    expect(repository).toContain('message.replyToMessageId');
    expect(source).toContain('if (!isUniqueViolation(error)) throw error;');
  });

  it('enforces the complete same-origin onboarding boundary and documents browser auth', () => {
    expect(source).toContain('requireBrowserMutationSession({');
    expect(source).toContain('isCanonicalBrowserOrigin(');
    expect(source).toContain('isRecentlyReauthenticated(');
    expect(dispatchSource).toContain('browserRequestHasBearer(input.req)');
    expect(dispatchSource).toContain(
      "'Bearer credentials are not accepted for browser routes.'",
    );
    expect(dispatchSource).toContain('setNoStore(input.res)');
    expect(openApiSource).toContain("operation['x-gantry-browser-auth']");
    expect(openApiSource).toContain('automaticMutationReplay: false');
    expect(openApiSource).toContain("cache: 'no-store'");
  });

  it('validates candidates before persistence and preserves a healthy credential on failure', () => {
    const validationIndex = modelServiceSource.indexOf(
      'const validation = await input.validate',
    );
    const persistenceIndex = modelServiceSource.indexOf(
      "if (!validation.ok || validation.status !== 'pass') return { validation };",
    );
    const setIndex = modelServiceSource.indexOf('credential: await this.set({');

    expect(validationIndex).toBeGreaterThan(-1);
    expect(persistenceIndex).toBeGreaterThan(validationIndex);
    expect(setIndex).toBeGreaterThan(persistenceIndex);
    expect(modelRouteSource).toContain('service.validateAndSet({');
  });

  it('uses a canonical provider model when onboarding validates first credentials', () => {
    expect(modelRouteSource).toContain('listModelCatalogEntries()');
    expect(modelRouteSource).toContain('entry.modelRoute.id === providerId &&');
    expect(modelRouteSource).toContain(
      'chatAlias: model.entry.recommendedAlias',
    );
    expect(modelRouteSource).toContain('modelAlias?: string;');
  });

  it(
    'accepts only auto anthropic' +
      '_sdk and deepagents with compatible providers',
    () => {
      const harness = fs.readFileSync(
        path.join(repoRoot, 'apps/core/src/shared/agent-engine.ts'),
        'utf8',
      );

      expect(harness).toContain('export const AGENT_HARNESSES = [');
      expect(AGENT_HARNESSES).toHaveLength(3);
      expect(new Set(AGENT_HARNESSES).size).toBe(3);
      expect(modelRouteSource).toContain('isAgentHarness(body.agentHarness)');
      expect(modelRouteSource).toContain('resolveModelSelectionForWorkload(');
      expect(modelRouteSource).toContain('resolveExecutionRoute({');
    },
  );

  it('keeps channel credentials runtime owned across direct reference and policy disabled modes', () => {
    expect(channelSource).toContain('gantryRuntimeSecretRef(name)');
    expect(channelSource).toContain(
      'normalizeRuntimeSecretRefString(credential)',
    );
    expect(channelSource).toContain(
      "'RUNTIME_SECRET_REFERENCE_POLICY_DISABLED'",
    );
    expect(channelSource).toContain(
      "'Browser requests cannot claim an existing Gantry secret reference.'",
    );
    expect(channelSource).not.toContain('capabilitySecretRefs');
  });

  it('does not complete discovery when no supported conversations are returned', () => {
    expect(channelSource).toContain('if (conversations.length === 0)');
    expect(channelSource).toContain("'NO_SUPPORTED_CONVERSATIONS'");
    expect(channelSource).toMatch(
      /if \(conversations\.length === 0\)[\s\S]*?'NO_SUPPORTED_CONVERSATIONS'[\s\S]*?return true;[\s\S]*?sendJson\(res, 200, \{\s*conversations:/,
    );
  });

  it('selects supported providers deterministically and leaves Teams setup only', () => {
    const catalog = fs.readFileSync(
      path.join(repoRoot, 'apps/core/src/channels/control-provider-catalog.ts'),
      'utf8',
    );
    const webSelection = fs.readFileSync(
      path.join(
        repoRoot,
        'apps/web/src/features/channel-accounts/channel-account-queries.ts',
      ),
      'utf8',
    );

    expect(catalog).toContain("for (const id of ['teams', 'whatsapp'])");
    expect(catalog).toContain("capabilityFlags: ['placeholder']");
    expect(channelSource).toContain("? 'setup_only'");
    expect(webSelection).toContain(
      ".filter((provider) => provider.status === 'available')",
    );
    expect(webSelection).toContain(
      "available.find((provider) => provider.id === 'slack')",
    );
    expect(webSelection).toContain(
      '.sort((left, right) => left.id.localeCompare(right.id))',
    );
  });

  it('serves an administrator-authorized channel manifest without credentials', () => {
    expect(source).toContain("'/ui/api/onboarding/channel-manifest'");
    expect(source).toContain('channelSetupManifestFor(');
    expect(source).toContain("'agents:admin'");
    expect(source).not.toContain('runtimeSecretRefs');
  });

  it('returns a URL-encoded canonical setup manifest only for supported channels', () => {
    const setup = channelSetupManifestFor('slack', ' Atlas  Smith ');
    expect(setup).toBeDefined();
    const url = new URL(setup!.createUrl);
    expect(url.origin).toBe('https://api.slack.com');
    expect(url.searchParams.get('new_app')).toBe('1');
    expect(
      JSON.parse(url.searchParams.get('manifest_json') ?? '{}'),
    ).toMatchObject({
      display_information: { name: 'Atlas Smith' },
      settings: { socket_mode_enabled: true },
    });
    expect(channelSetupManifestFor('discord', 'Atlas')).toBeUndefined();
  });
});
