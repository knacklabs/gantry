import { describe, expect, it } from 'vitest';

import {
  requiredModelCredentialProviders,
  type RequiredModelCredentialProvidersSettings,
} from '@core/application/model-resolution/required-model-credential-providers.js';

function baseSettings(): RequiredModelCredentialProvidersSettings {
  return {
    agent: {
      defaultModel: 'opus',
      oneTimeJobDefaultModel: 'opus',
      recurringJobDefaultModel: 'opus',
    },
    memory: { enabled: false },
  };
}

describe('requiredModelCredentialProviders', () => {
  it('returns the provider required by the chat/job default aliases', () => {
    const providers = requiredModelCredentialProviders(baseSettings());
    // `opus` resolves to the anthropic provider for every workload slot.
    expect(providers).toEqual(['anthropic']);
  });

  it('requires the member a family alias would select', () => {
    const settings = baseSettings();
    settings.agent.defaultModel = 'gpt-oss';
    // No configured providers: the runtime falls back to the first member,
    // so its provider must be required rather than nothing.
    expect(requiredModelCredentialProviders(settings)).toContain('groq');
    // With a configured non-first member, that member's provider is required.
    expect(
      requiredModelCredentialProviders(settings, {
        configuredProviderIds: new Set(['cerebras']),
      }),
    ).toContain('cerebras');
  });

  it('includes per-agent and conversation-install model override providers', () => {
    const settings = baseSettings();
    settings.agents = {
      helper: { model: 'gpt', oneTimeJobDefaultModel: 'kimi' },
      empty: {},
    };
    settings.conversations = {
      ops: {
        installedAgents: {
          helper: { status: 'active', model: 'groq' },
        },
      },
    };
    expect(requiredModelCredentialProviders(settings)).toEqual([
      'anthropic',
      'groq',
      'openai',
      'openrouter',
    ]);
  });

  it('excludes disabled conversation-install model overrides', () => {
    const settings = baseSettings();
    settings.conversations = {
      ops: {
        installedAgents: {
          active: { status: 'active', model: 'groq' },
          disabled: { status: 'disabled', model: 'gpt' },
        },
      },
    };

    expect(requiredModelCredentialProviders(settings)).toEqual([
      'anthropic',
      'groq',
    ]);
  });

  it('falls back to the setup default alias when defaultModel is empty', () => {
    const settings = baseSettings();
    settings.agent.defaultModel = '';
    settings.agent.oneTimeJobDefaultModel = '';
    settings.agent.recurringJobDefaultModel = '';
    expect(requiredModelCredentialProviders(settings)).toEqual(['anthropic']);
  });

  it('omits memory model/embedding providers when memory detail is redacted', () => {
    // The Control API public settings view exposes only memory.enabled; without
    // llm/embeddings detail only chat/job providers can be required.
    const settings = baseSettings();
    settings.memory = { enabled: true };
    expect(requiredModelCredentialProviders(settings)).toEqual(['anthropic']);
  });

  it('includes memory embedding providers when memory detail is present', () => {
    const settings: RequiredModelCredentialProvidersSettings = {
      agent: {
        defaultModel: 'opus',
        oneTimeJobDefaultModel: 'opus',
        recurringJobDefaultModel: 'opus',
      },
      memory: {
        enabled: true,
        embeddings: { enabled: true, provider: 'openai' },
        dreaming: { embeddings: { enabled: false, provider: 'openai' } },
        llm: {
          models: {
            extractor: 'opus',
            dreaming: 'opus',
            consolidation: 'opus',
          },
        },
      },
    };
    expect(requiredModelCredentialProviders(settings)).toEqual([
      'anthropic',
      'openai',
    ]);
  });
});
