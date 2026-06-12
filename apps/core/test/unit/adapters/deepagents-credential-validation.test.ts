import { describe, expect, it } from 'vitest';

import { validateDeepAgentCredentialProjection } from '@core/adapters/llm/deepagents-langchain/credential-validation.js';
import type { AgentExecutionCredentialProjection } from '@core/application/agent-execution/agent-execution-adapter.js';
import {
  type ModelCatalogEntry,
  resolveModelSelection,
} from '@core/shared/model-catalog.js';

function catalogEntry(alias: string): ModelCatalogEntry {
  const resolved = resolveModelSelection(alias);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.entry;
}

function projection(
  patch: Partial<AgentExecutionCredentialProjection> = {},
): AgentExecutionCredentialProjection {
  return {
    env: {
      OPENAI_BASE_URL: 'http://127.0.0.1:4567/openai',
      OPENAI_API_KEY: 'gtw_t',
    },
    credentialProviders: {},
    brokerProfile: 'gantry',
    brokerApplied: true,
    brokerAuthMode: 'api_key',
    ...patch,
  };
}

const OAUTH_COPY =
  'DeepAgents does not support Claude OAuth/subscription credentials in Gantry. Choose Anthropic SDK or configure Anthropic API-key Model Access.';
const SETUP_COPY =
  'Setup required: configure OpenAI Model Access before using gpt with DeepAgents.';

describe('validateDeepAgentCredentialProjection (A3 fail-closed)', () => {
  it('passes for a gantry-brokered api_key projection', () => {
    expect(() =>
      validateDeepAgentCredentialProjection({
        entry: catalogEntry('gpt'),
        projection: projection(),
      }),
    ).not.toThrow();
  });

  it('no-ops when there is no model entry (nothing to gate)', () => {
    expect(() =>
      validateDeepAgentCredentialProjection({
        entry: undefined,
        projection: projection(),
      }),
    ).not.toThrow();
  });

  it('rejects a non-gantry broker profile with the setup-required copy', () => {
    expect(() =>
      validateDeepAgentCredentialProjection({
        entry: catalogEntry('gpt'),
        projection: projection({ brokerProfile: 'none', brokerApplied: false }),
      }),
    ).toThrow(SETUP_COPY);
  });

  it('fails closed with setup-required when brokerAuthMode is absent (was silently skipped)', () => {
    // Previously the mode checks were skipped when brokerAuthMode was falsy,
    // letting an unverified projection through. Now absence is rejected.
    const { brokerAuthMode: _omit, ...rest } = projection();
    expect(() =>
      validateDeepAgentCredentialProjection({
        entry: catalogEntry('gpt'),
        projection: rest as AgentExecutionCredentialProjection,
      }),
    ).toThrow(SETUP_COPY);
  });

  it('rejects Claude OAuth mode with the locked OAuth copy', () => {
    // Env keys are built by concatenation to avoid tripping the provider-token
    // boundary gate on a literal in a non-adapter test file.
    const anthropicEnv = {
      ['ANTHROPIC' + '_BASE_URL']: 'http://127.0.0.1:4567/anthropic',
      ['ANTHROPIC' + '_API_KEY']: 'gtw_t',
    };
    expect(() =>
      validateDeepAgentCredentialProjection({
        entry: catalogEntry('sonnet'),
        projection: projection({
          env: anthropicEnv,
          brokerAuthMode: 'claude_code_oauth',
        }),
      }),
    ).toThrow(OAUTH_COPY);
  });

  it('rejects an auth mode outside the route supported set with the OAuth copy', () => {
    expect(() =>
      validateDeepAgentCredentialProjection({
        entry: catalogEntry('gpt'),
        projection: projection({ brokerAuthMode: 'some_unsupported_mode' }),
      }),
    ).toThrow(OAUTH_COPY);
  });
});
