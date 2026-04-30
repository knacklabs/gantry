import { describe, expect, it } from 'vitest';

import {
  filterTrustedOnecliEnv,
  ONECLI_FORBIDDEN_SECRET_ENV_KEYS,
} from '@core/adapters/credentials/onecli/env-policy.js';

describe('OneCLI env policy', () => {
  it('keeps only broker-safe model env keys', () => {
    expect(
      filterTrustedOnecliEnv({
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
        ANTHROPIC_MODEL: 'claude-haiku-4-5',
        ANTHROPIC_API_KEY: 'placeholder',
        CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
        HTTPS_PROXY: 'http://127.0.0.1:10255',
        NODE_USE_ENV_PROXY: '1',
      }),
    ).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
        ANTHROPIC_MODEL: 'claude-haiku-4-5',
        ANTHROPIC_API_KEY: 'placeholder',
        CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
        HTTPS_PROXY: 'http://127.0.0.1:10255/',
        NODE_USE_ENV_PROXY: '1',
      },
      droppedKeys: [],
    });
  });

  it('drops empty, non-string, and unknown env keys', () => {
    expect(
      filterTrustedOnecliEnv({
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
        EMPTY_ALLOWED_KEY: '',
        ANTHROPIC_MODEL: '',
        CUSTOM_FLAG: 'value',
        NODE_EXTRA_CA_CERTS: '/tmp/onecli-gateway-ca.pem',
        NUMBER_VALUE: 1,
      }),
    ).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
      },
      droppedKeys: [
        'EMPTY_ALLOWED_KEY',
        'ANTHROPIC_MODEL',
        'CUSTOM_FLAG',
        'NODE_EXTRA_CA_CERTS',
        'NUMBER_VALUE',
      ],
    });
  });

  it('rejects database URLs and deployment encryption secrets from broker env', () => {
    for (const key of ONECLI_FORBIDDEN_SECRET_ENV_KEYS) {
      expect(() =>
        filterTrustedOnecliEnv({
          ANTHROPIC_BASE_URL: 'https://broker.example.com',
          [key]: 'secret',
        }),
      ).toThrow(`forbidden raw credential env key: ${key}`);
    }
  });

  it('rejects secret-looking and unknown proxy or certificate env keys by pattern', () => {
    for (const key of [
      'CUSTOM_API_KEY',
      'CUSTOM_TOKEN',
      'CUSTOM_DATABASE_URL',
      'CUSTOM_PROXY',
      'CUSTOM_CA_CERT',
    ]) {
      expect(() =>
        filterTrustedOnecliEnv({
          ANTHROPIC_BASE_URL: 'https://broker.example.com',
          [key]: 'secret',
        }),
      ).toThrow(`forbidden raw credential env key: ${key}`);
    }
  });

  it('rejects real provider keys', () => {
    expect(() =>
      filterTrustedOnecliEnv({
        ANTHROPIC_API_KEY: 'sk-ant-secret',
      }),
    ).toThrow('forbidden raw credential env key: ANTHROPIC_API_KEY');

    expect(() =>
      filterTrustedOnecliEnv({
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret',
      }),
    ).toThrow('forbidden raw credential env key: CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('allows only local model proxy env and rejects tool proxy controls', () => {
    expect(
      filterTrustedOnecliEnv({
        HTTPS_PROXY: 'http://localhost:10255',
        HTTP_PROXY: 'http://127.0.0.1:10255',
        https_proxy: 'http://[::1]:10255',
        http_proxy:
          'http://x:aoc_104f2fa6600ede448b527c267a13d6a0db0dad62b3f9ca087446cc8e15acd697@host.docker.internal:10255',
        NODE_USE_ENV_PROXY: 'true',
        GIT_TERMINAL_PROMPT: '0',
        GIT_HTTP_PROXY_AUTHMETHOD: 'basic',
      }),
    ).toEqual({
      env: {
        HTTPS_PROXY: 'http://localhost:10255/',
        HTTP_PROXY: 'http://127.0.0.1:10255/',
        https_proxy: 'http://[::1]:10255/',
        http_proxy:
          'http://x:aoc_104f2fa6600ede448b527c267a13d6a0db0dad62b3f9ca087446cc8e15acd697@127.0.0.1:10255/',
        NODE_USE_ENV_PROXY: 'true',
      },
      droppedKeys: ['GIT_TERMINAL_PROMPT', 'GIT_HTTP_PROXY_AUTHMETHOD'],
    });
  });

  it('rejects secret-bearing values in allowed URL env keys', () => {
    for (const value of [
      'https://user:pass@broker.example.com/anthropic',
      'https://broker.example.com/anthropic?token=raw',
      'https://broker.example.com/anthropic#token',
      'http://broker.example.com/anthropic',
    ]) {
      expect(() =>
        filterTrustedOnecliEnv({
          ANTHROPIC_BASE_URL: value,
        }),
      ).toThrow(
        'forbidden raw credential env value for key: ANTHROPIC_BASE_URL',
      );
    }
  });

  it('rejects secret-shaped values in allowed model env keys', () => {
    const secretLikeValues = [
      'sk-ant-raw-provider-token',
      'm=sk-ant-AAAAAAAA',
      '+eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',
      '/Bearer abcdefghijklmnopqrstuvwxyz123456',
      'github_pat_11AAAAAAAA0abcdefghijklmnopqrstuvwxyz',
      'ASIAABCDEFGHIJKLMNOP',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'Bearer abcdefghijklmnopqrstuvwxyz123456',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',
      '-----BEGIN PRIVATE KEY-----',
    ];
    for (const key of [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    ]) {
      for (const value of secretLikeValues) {
        expect(() =>
          filterTrustedOnecliEnv({
            ANTHROPIC_BASE_URL: 'https://broker.example.com',
            [key]: value,
          }),
        ).toThrow(`forbidden raw credential env value for key: ${key}`);
      }
    }
  });

  it('rejects non-local or credential-bearing model proxy values', () => {
    for (const value of [
      'https://x:aoc_123@127.0.0.1:10255',
      'http://x:aoc_123@127.0.0.1:10256',
      'http://user:aoc_123@127.0.0.1:10255',
      'http://x:not-aoc@127.0.0.1:10255',
      'http://x:aoc_123@proxy.example.com:10255',
      'http://proxy.example.com:8080',
      'http://x:aoc_123@127.0.0.1:10255/path',
      'http://x:aoc_123@127.0.0.1:10255/?token=sk-ant-raw-provider-token',
      'http://x:aoc_123@127.0.0.1:10255/#token',
    ]) {
      expect(() =>
        filterTrustedOnecliEnv({
          HTTPS_PROXY: value,
        }),
      ).toThrow('forbidden raw credential env value for key: HTTPS_PROXY');
    }

    expect(() =>
      filterTrustedOnecliEnv({
        NODE_USE_ENV_PROXY: 'maybe',
      }),
    ).toThrow('forbidden raw credential env value for key: NODE_USE_ENV_PROXY');
  });
});
