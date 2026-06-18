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
  'DeepAgents cannot use Claude OAuth/subscription credentials. Choose Anthropic SDK or configure Claude API-key Model Access.';
const SETUP_COPY =
  'Setup required: configure OpenAI Model Access before using gpt with DeepAgents.';
const UNSUPPORTED_MODE_COPY =
  'unsupported-credential-mode: DeepAgents does not support credential mode "access_key" for Amazon Bedrock Model Access.';
const GATEWAY_TOKEN_COPY =
  'Gantry Model Gateway projection for GPT-5.5 must use a run-scoped gateway token.';

describe('validateDeepAgentCredentialProjection (A3 fail-closed)', () => {
  it('passes for a gantry-brokered api_key projection', () => {
    expect(() =>
      validateDeepAgentCredentialProjection({
        entry: catalogEntry('gpt'),
        projection: projection(),
      }),
    ).not.toThrow();
  });

  it.each([
    ['bedrock-oss', 'bedrock_api_key'],
    ['vertex', 'service_account'],
  ])('passes for %s with its supported %s credential mode', (alias, mode) => {
    expect(() =>
      validateDeepAgentCredentialProjection({
        entry: catalogEntry(alias),
        projection: projection({
          brokerAuthMode: mode,
          env: {
            OPENAI_BASE_URL: `http://127.0.0.1:4567/${alias}`,
            OPENAI_API_KEY: 'gtw_t',
          },
        }),
      }),
    ).not.toThrow();
  });

  it('rejects Bedrock access_key mode on the OpenAI-compatible DeepAgents lane', () => {
    expect(() =>
      validateDeepAgentCredentialProjection({
        entry: catalogEntry('bedrock-oss'),
        projection: projection({
          brokerAuthMode: 'access_key',
          env: {
            OPENAI_BASE_URL: 'http://127.0.0.1:4567/bedrock',
            OPENAI_API_KEY: 'gtw_t',
          },
        }),
      }),
    ).toThrow(UNSUPPORTED_MODE_COPY);
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
    // Defense in depth: even on a DeepAgents-routed model (gpt), a claude OAuth
    // credential mode must be rejected — it can only ever project to the SDK lane.
    expect(() =>
      validateDeepAgentCredentialProjection({
        entry: catalogEntry('gpt'),
        projection: projection({
          brokerAuthMode: 'claude_code_oauth',
        }),
      }),
    ).toThrow(OAUTH_COPY);
  });

  it('rejects an auth mode outside the route supported set with generic unsupported copy', () => {
    expect(() =>
      validateDeepAgentCredentialProjection({
        entry: catalogEntry('gpt'),
        projection: projection({ brokerAuthMode: 'some_unsupported_mode' }),
      }),
    ).toThrow(
      'unsupported-credential-mode: DeepAgents does not support credential mode "some_unsupported_mode" for OpenAI Model Access.',
    );
  });

  it('rejects non-gateway OpenAI API keys in the model credential env', () => {
    expect(() =>
      validateDeepAgentCredentialProjection({
        entry: catalogEntry('gpt'),
        projection: projection({
          env: {
            OPENAI_BASE_URL: 'http://127.0.0.1:4567/openai',
            OPENAI_API_KEY: 'sk-raw-provider-key',
          },
        }),
      }),
    ).toThrow(GATEWAY_TOKEN_COPY);
  });

  it('rejects raw Claude OAuth provider tokens in the model credential env', () => {
    expect(() =>
      validateDeepAgentCredentialProjection({
        entry: catalogEntry('gpt'),
        projection: projection({
          env: {
            OPENAI_BASE_URL: 'http://127.0.0.1:4567/openai',
            OPENAI_API_KEY: 'gtw_t',
            [['CLAUDE', 'CODE', 'OAUTH', 'TOKEN'].join('_')]: 'raw-oauth-token',
          },
        }),
      }),
    ).toThrow(OAUTH_COPY);
  });
});
