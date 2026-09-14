import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  onboardingProviders,
  requiredCredentialFieldErrors,
} from './onboarding-model-setup';

const providers = [
  'vertex',
  'openrouter',
  'anthropic',
  'openai',
  'bedrock',
  'groq',
].map((providerId) => ({
  providerId,
  label: providerId,
  configured: false,
  health: 'missing' as const,
  authMode: null,
  configuredFields: [],
  required: false,
  requiredBy: [],
  supportedWorkloads: [],
  updatedAt: null,
  credentialModes: [],
}));

it('keeps onboarding provider selection constrained and ordered', () => {
  expect(onboardingProviders(providers).map((item) => item.providerId)).toEqual(
    ['anthropic', 'bedrock', 'openai', 'openrouter', 'vertex'],
  );
});

it('reports only missing required credential fields', () => {
  const mode = {
    id: 'bedrock_api_key',
    label: 'Bedrock API key',
    helpText: '',
    fields: [
      { name: 'region', label: 'AWS region', required: true, secret: false },
      { name: 'profile', label: 'AWS profile', required: false, secret: false },
      {
        name: 'apiKey',
        label: 'Bedrock API key',
        required: true,
        secret: true,
      },
    ],
  };

  expect(requiredCredentialFieldErrors(mode, { region: 'ap-south-1' })).toEqual(
    { apiKey: 'Bedrock API key is required.' },
  );
});

it('requires an authentication mode before collecting credentials', () => {
  expect(requiredCredentialFieldErrors(undefined, {})).toEqual({
    authMode: 'Choose an authentication method.',
  });
});

it('forces a fresh model catalog request before unlocking model selection', () => {
  const component = readFileSync(
    new URL('./onboarding-model-setup.tsx', import.meta.url),
    'utf8',
  );

  expect(component).toContain(
    'await queryClient.fetchQuery({ ...agentModelsQuery, staleTime: 0 })',
  );
  expect(component).toContain("'Loading available models…'");
  expect(component).toContain(
    'const modelLocked = !credentialValidated || loadingModels;',
  );
});

it('keeps models locked until compatible credentials validate and clears successful drafts', () => {
  const component = readFileSync(
    new URL('./onboarding-model-setup.tsx', import.meta.url),
    'utf8',
  );

  expect(component).toContain(
    'const modelLocked = !credentialValidated || loadingModels;',
  );
  expect(component).toContain("agentHarness: 'auto'");
  expect(component).toContain("method: 'POST'");
  expect(component).toContain('/verify`');
  expect(component).toContain('setValues({});');
  expect(component).toContain('onCredentialValidated(true);');
  expect(component).toContain('Configuration validated');
});

it('renders the V2 Iconify provider marks instead of monograms', () => {
  const component = readFileSync(
    new URL('./onboarding-model-setup.tsx', import.meta.url),
    'utf8',
  );

  expect(component).toContain('@iconify-icons/simple-icons/anthropic');
  expect(component).toContain('@iconify-icons/simple-icons/amazonwebservices');
  expect(component).toContain('@iconify-icons/simple-icons/openai');
  expect(component).toContain('@iconify-icons/simple-icons/openrouter');
  expect(component).toContain('@iconify-icons/simple-icons/googlecloud');
  expect(component).toContain('className="onboarding-provider-mark"');
});
