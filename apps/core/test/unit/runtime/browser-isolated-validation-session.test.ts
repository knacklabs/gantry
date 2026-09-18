import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBrowserConnection: vi.fn(),
  installBrowserContextNetworkPolicy: vi.fn(),
  observePage: vi.fn(),
  scheduleConnectionIdleClose: vi.fn(),
}));

vi.mock('@core/adapters/browser/browser-direct-session.js', () => ({
  getBrowserConnection: mocks.getBrowserConnection,
  observePage: mocks.observePage,
  scheduleConnectionIdleClose: mocks.scheduleConnectionIdleClose,
}));
vi.mock('@core/runtime/browser-network-policy.js', () => ({
  installBrowserContextNetworkPolicy: mocks.installBrowserContextNetworkPolicy,
}));

import {
  validationAllowedOrigins,
  withIsolatedValidationBrowserSession,
} from '@core/runtime/browser-isolated-validation-session.js';

describe('isolated recipe-validation browser session', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs each case in a fresh context and always closes it', async () => {
    const contexts = [createContext(), createContext()];
    const newContext = vi
      .fn()
      .mockResolvedValueOnce(contexts[0])
      .mockResolvedValueOnce(contexts[1]);
    mocks.getBrowserConnection.mockResolvedValue({
      browser: { newContext },
    });

    for (const expected of contexts) {
      await expect(
        withIsolatedValidationBrowserSession({
          profileName: 'recipe-validation',
          port: 9222,
          allowedOrigins: ['https://tenders.example.gov'],
          timeoutMs: 1_000,
          execute: async ({ context, page }) => ({ context, page }),
        }),
      ).resolves.toEqual({ context: expected, page: expected.page });
      expect(expected.close).toHaveBeenCalledOnce();
    }

    expect(newContext).toHaveBeenCalledTimes(2);
    expect(newContext).toHaveBeenNthCalledWith(1, {
      acceptDownloads: true,
      serviceWorkers: 'block',
    });
    expect(contexts[0]).not.toBe(contexts[1]);
    expect(mocks.installBrowserContextNetworkPolicy).toHaveBeenCalledWith({
      context: contexts[0],
      allowedHosts: [],
      allowedOrigins: ['https://tenders.example.gov'],
    });
  });

  it('closes the fresh context when execution fails', async () => {
    const context = createContext();
    mocks.getBrowserConnection.mockResolvedValue({
      browser: { newContext: vi.fn(async () => context) },
    });

    await expect(
      withIsolatedValidationBrowserSession({
        profileName: 'recipe-validation',
        port: 9222,
        allowedOrigins: ['https://tenders.example.gov'],
        timeoutMs: 1_000,
        execute: async () => {
          throw new Error('case failed');
        },
      }),
    ).rejects.toThrow('case failed');
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('requires exact credential-free HTTP origins', () => {
    expect(
      validationAllowedOrigins([
        'https://TENDERS.example.gov',
        'https://tenders.example.gov',
      ]),
    ).toEqual(['https://tenders.example.gov']);
    expect(
      validationAllowedOrigins([
        'http://example.gov:8080',
        'https://example.gov:8443',
      ]),
    ).toEqual(['http://example.gov:8080', 'https://example.gov:8443']);
    expect(() => validationAllowedOrigins([])).toThrow('at least one');
    expect(() =>
      validationAllowedOrigins(['https://example.gov/path']),
    ).toThrow('Invalid validation origin');
  });
});

function createContext() {
  const page = {};
  return {
    page,
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
}
