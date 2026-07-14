import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const listReadyProvidersMock = vi.hoisted(() =>
  vi.fn<() => Promise<ReadonlySet<string>>>(async () => {
    throw new Error('storage unavailable in tests');
  }),
);

vi.mock('@core/cli/credentials.js', () => ({
  listReadyModelCredentialProviders: listReadyProvidersMock,
}));

import { runModelCommand } from '@core/cli/model.js';
import { resolveModelSelectionForWorkload } from '@core/shared/model-catalog.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-model-cli-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

afterEach(() => {
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('model CLI command', () => {
  it('lists the supported model catalog', async () => {
    const runtimeHome = makeRuntimeHome();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runModelCommand(runtimeHome, ['list'])).resolves.toBe(0);

    const output = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('Available model aliases');
    // The Context column sits between Route and Cache; Cost follows Cache.
    expect(output).toContain(
      'Alias | Model | Response family | Route | Context | Cache | Cost (in/out per 1M) | Status',
    );
    // Curated prices render in the new Cost column.
    expect(output).toMatch(
      /groq \| Groq Llama 3\.3 70B[^\n]*\| \$0\.59\/\$0\.79 \|/,
    );
    expect(output).toContain('opus-4.8 | Opus 4.8');
    expect(output).toContain('Opus 4.8');
    expect(output).toContain('kimi-2.6 | Kimi K2.6');
    expect(output).toContain('glm-5.2 | GLM 5.2');
    // Curated windows render in the new Context column (Gemini Pro = 1.0M,
    // Groq Llama = 131K).
    expect(output).toMatch(/gemini \| Gemini 2\.5 Pro \|[^\n]*\| 1\.0M \|/);
    expect(output).toMatch(/groq \| Groq Llama 3\.3 70B[^\n]*\| 131K \|/);
    expect(output).toContain(
      'Model families (provider auto-selected by configured key)',
    );
    expect(output).toContain('gpt-oss | GPT-OSS 120B | groq-oss > cerebras');
  });

  it('sets and resets chat and job defaults by alias', async () => {
    const runtimeHome = makeRuntimeHome();
    const preflightProvider = vi.fn(async () => ({
      ok: true,
      status: 'pass' as const,
      message: 'ok',
    }));

    await expect(
      runModelCommand(runtimeHome, ['set', 'chat', 'sonnet'], {
        preflightProvider,
      }),
    ).resolves.toBe(0);
    await expect(
      runModelCommand(runtimeHome, ['set', 'jobs', 'kimi 2.6'], {
        preflightProvider,
      }),
    ).resolves.toBe(0);

    let settings = loadRuntimeSettings(runtimeHome);
    expect(settings.agent.defaultModel).toBe('sonnet');
    expect(settings.agent.oneTimeJobDefaultModel).toBe('kimi-2.6');
    expect(settings.agent.recurringJobDefaultModel).toBe('kimi-2.6');

    await expect(
      runModelCommand(runtimeHome, ['reset', 'jobs'], { preflightProvider }),
    ).resolves.toBe(0);
    settings = loadRuntimeSettings(runtimeHome);
    expect(settings.agent.oneTimeJobDefaultModel).toBe('');
    expect(settings.agent.recurringJobDefaultModel).toBe('');
  });

  it('sets an agent chat override without changing global chat default', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.agent.defaultModel = 'sonnet';
    settings.agents.helper = {
      name: 'Helper',
      folder: 'helper',
      persona: 'developer',
      model: 'sonnet',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    saveRuntimeSettings(runtimeHome, settings);
    const preflightProvider = vi.fn(async () => ({
      ok: true,
      status: 'pass' as const,
      message: 'ok',
    }));

    await expect(
      runModelCommand(
        runtimeHome,
        ['set', 'chat', 'gpt', '--agent', 'helper'],
        {
          preflightProvider,
        },
      ),
    ).resolves.toBe(0);

    const updated = loadRuntimeSettings(runtimeHome);
    expect(updated.agent.defaultModel).toBe('sonnet');
    expect(updated.agents.helper?.model).toBe('gpt');
    expect(preflightProvider).toHaveBeenCalledWith(
      runtimeHome,
      'openai',
      expect.any(Object),
      'gpt',
    );
  });

  it('preflights the storage-configured family member with the service stopped', async () => {
    const runtimeHome = makeRuntimeHome();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    listReadyProvidersMock.mockResolvedValueOnce(new Set(['cerebras']));
    const preflightProvider = vi.fn(async () => ({
      ok: true,
      status: 'pass' as const,
      message: 'ok',
    }));

    await expect(
      runModelCommand(runtimeHome, ['set', 'chat', 'gpt-oss'], {
        preflightProvider,
      }),
    ).resolves.toBe(0);

    // Storage says only cerebras is configured, so the runtime would select
    // the cerebras member — preflight must check that provider, not groq.
    expect(preflightProvider).toHaveBeenCalledWith(
      runtimeHome,
      'cerebras',
      expect.any(Object),
      expect.any(String),
    );
    expect(preflightProvider).not.toHaveBeenCalledWith(
      runtimeHome,
      'groq',
      expect.anything(),
      expect.anything(),
    );
    logSpy.mockRestore();
  });

  it('accepts a model family alias for set chat and stores it verbatim', async () => {
    const runtimeHome = makeRuntimeHome();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const preflightProvider = vi.fn(async () => ({
      ok: true,
      status: 'pass' as const,
      message: 'ok',
    }));

    await expect(
      runModelCommand(runtimeHome, ['set', 'chat', 'gpt-oss'], {
        preflightProvider,
      }),
    ).resolves.toBe(0);
    expect(loadRuntimeSettings(runtimeHome).agent.defaultModel).toBe('gpt-oss');
    // The family's selected member must be preflighted with a concrete
    // catalog alias — the family name itself would fail the preflight
    // resolver and block valid family selections.
    const preflightCall = preflightProvider.mock.calls.at(0) as unknown[];
    expect(preflightCall?.[1]).toBe('groq');
    const preflightAlias = preflightCall?.[3] as string;
    expect(preflightAlias).not.toBe('gpt-oss');
    expect(resolveModelSelectionForWorkload(preflightAlias, 'chat').ok).toBe(
      true,
    );

    await expect(
      runModelCommand(runtimeHome, ['set', 'jobs', 'llama-70b'], {
        preflightProvider,
      }),
    ).resolves.toBe(0);
    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.agent.oneTimeJobDefaultModel).toBe('llama-70b');
    expect(settings.agent.recurringJobDefaultModel).toBe('llama-70b');
    logSpy.mockRestore();
  });

  it('shows family-aware why for an alias/family argument (no badges offline)', async () => {
    const runtimeHome = makeRuntimeHome();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      runModelCommand(runtimeHome, ['why', 'gpt-oss']),
    ).resolves.toBe(0);
    const output = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('Why model family gpt-oss');
    // Offline (no control key): the configured/needs-key line is omitted.
    expect(output).not.toContain('credential:');
    logSpy.mockRestore();
  });

  it('preflights OpenRouter aliases before direct CLI writes', async () => {
    const runtimeHome = makeRuntimeHome();
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const preflightProvider = vi.fn(async () => ({
      ok: false,
      status: 'fail' as const,
      message: 'missing OpenRouter token',
    }));

    await expect(
      runModelCommand(runtimeHome, ['set', 'chat', 'kimi'], {
        preflightProvider,
      }),
    ).resolves.toBe(1);
    let settings = loadRuntimeSettings(runtimeHome);
    expect(settings.agent.defaultModel).not.toBe('kimi');

    settings.agent.defaultModel = 'kimi';
    settings.agent.oneTimeJobDefaultModel = 'sonnet';
    settings.agent.recurringJobDefaultModel = 'sonnet';
    saveRuntimeSettings(runtimeHome, settings);

    await expect(
      runModelCommand(runtimeHome, ['set', 'jobs', 'inherit'], {
        preflightProvider,
      }),
    ).resolves.toBe(1);
    settings = loadRuntimeSettings(runtimeHome);
    expect(settings.agent.oneTimeJobDefaultModel).toBe('sonnet');
    expect(settings.agent.recurringJobDefaultModel).toBe('sonnet');
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain(
      'Provider preflight failed: missing OpenRouter token',
    );
  });

  it('preflights DeepAgents providers before direct CLI writes', async () => {
    const runtimeHome = makeRuntimeHome();
    const preflightProvider = vi.fn(async () => ({
      ok: true,
      status: 'pass' as const,
      message: 'ok',
    }));

    await expect(
      runModelCommand(runtimeHome, ['set', 'chat', 'gpt'], {
        preflightProvider,
      }),
    ).resolves.toBe(0);

    expect(loadRuntimeSettings(runtimeHome).agent.defaultModel).toBe('gpt');
    expect(preflightProvider).toHaveBeenCalledWith(
      runtimeHome,
      'openai',
      expect.any(Object),
      'gpt',
    );
  });

  it('preflights Anthropic aliases before direct CLI writes', async () => {
    const runtimeHome = makeRuntimeHome();
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const preflightProvider = vi.fn(async () => ({
      ok: false,
      status: 'fail' as const,
      message: 'missing Anthropic token',
    }));

    await expect(
      runModelCommand(runtimeHome, ['set', 'chat', 'sonnet'], {
        preflightProvider,
      }),
    ).resolves.toBe(1);

    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.agent.defaultModel).not.toBe('sonnet');
    expect(preflightProvider).toHaveBeenCalledWith(
      runtimeHome,
      'anthropic',
      expect.any(Object),
      'sonnet',
    );
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain(
      'Provider preflight failed: missing Anthropic token',
    );
  });

  it('applies provider-managed memory defaults only after credential preflight', async () => {
    const runtimeHome = makeRuntimeHome();
    const preflightProvider = vi.fn(async () => ({
      ok: true,
      status: 'pass' as const,
      message: 'ok',
    }));
    const settings = loadRuntimeSettings(runtimeHome);
    settings.agent.defaultModel = 'kimi';
    saveRuntimeSettings(runtimeHome, settings);

    await expect(
      runModelCommand(runtimeHome, ['reset', 'memory'], {
        preflightProvider,
      }),
    ).resolves.toBe(0);
    expect(preflightProvider).toHaveBeenCalledWith(
      runtimeHome,
      'openrouter',
      expect.any(Object),
      undefined,
    );

    const updated = loadRuntimeSettings(runtimeHome);
    expect(updated.agent.defaultModel).toBe('kimi');
    expect(updated.agent.oneTimeJobDefaultModel).toBe('');
    expect(updated.agent.recurringJobDefaultModel).toBe('');
    expect(updated.memory.llm.models).toEqual({
      extractor: 'kimi',
      dreaming: 'kimi',
      consolidation: 'kimi',
    });
  });

  it('does not expose public memory tuning writes', async () => {
    const runtimeHome = makeRuntimeHome();
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(
      runModelCommand(runtimeHome, ['set', 'memory', 'kimi']),
    ).resolves.toBe(1);

    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain(
      'gantry model set chat',
    );
  });

  it('rejects unsupported aliases and provider model IDs', async () => {
    const runtimeHome = makeRuntimeHome();
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(
      runModelCommand(runtimeHome, ['set', 'chat', 'unknown-model']),
    ).resolves.toBe(1);
    await expect(
      runModelCommand(runtimeHome, ['set', 'chat', 'moonshotai/kimi-k2.6']),
    ).resolves.toBe(1);

    const output = errorSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('Unknown model "unknown-model"');
    expect(output).toContain('Provider model ID "moonshotai/kimi-k2.6"');
  });

  it('fails doctor when OpenRouter defaults are set without broker credentials', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.agent.defaultModel = 'kimi';
    settings.credentialBroker.mode = 'none';
    saveRuntimeSettings(runtimeHome, settings);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runModelCommand(runtimeHome, ['doctor'])).resolves.toBe(1);

    const output = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('OpenRouter credentials: fail');
    expect(output).toContain('Status: fail');
  });

  it('fails doctor when Anthropic defaults are set without broker credentials', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.credentialBroker.mode = 'none';
    saveRuntimeSettings(runtimeHome, settings);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runModelCommand(runtimeHome, ['doctor'])).resolves.toBe(1);

    const output = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('Anthropic credentials: fail');
    expect(output).toContain('Status: fail');
  });

  it('fails doctor when any configured model alias is invalid', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.agent.defaultModel = 'unknown-model';
    saveRuntimeSettings(runtimeHome, settings);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runModelCommand(runtimeHome, ['doctor'])).resolves.toBe(1);

    const output = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('chat: invalid');
    expect(output).toContain('model aliases: fail');
    expect(output).toContain('Unknown model "unknown-model"');
    expect(output).toContain('Status: fail');
  });

  it('fails memory reset when provider credential preflight fails', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.agent.defaultModel = 'kimi';
    saveRuntimeSettings(runtimeHome, settings);
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(
      runModelCommand(runtimeHome, ['reset', 'memory'], {
        preflightProvider: async () => ({
          ok: false,
          status: 'fail',
          message: 'missing OpenRouter token',
        }),
      }),
    ).resolves.toBe(1);

    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain(
      'Provider preflight failed: missing OpenRouter token',
    );
  });

  it('renders status without throwing when chat is a DeepAgents model', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.agent.defaultModel = 'gpt';
    saveRuntimeSettings(runtimeHome, settings);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runModelCommand(runtimeHome, ['status'])).resolves.toBe(0);

    const output = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('Model status');
    expect(output).toContain('provider: openai (OpenAI)');
    logSpy.mockRestore();
  });
});
