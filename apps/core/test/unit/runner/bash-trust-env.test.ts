import { describe, expect, it } from 'vitest';

import { applyBashTrustEnv } from '../../../src/adapters/llm/anthropic-claude-agent/runner/bash-trust-env.js';

const CA_PATH = '/tmp/gantry/onecli-ca.pem';
const TRUST_PREFIX = [
  'GODEBUG=netdns=go',
  `SSL_CERT_FILE='${CA_PATH}'`,
  `REQUESTS_CA_BUNDLE='${CA_PATH}'`,
  `CURL_CA_BUNDLE='${CA_PATH}'`,
  `GIT_SSL_CAINFO='${CA_PATH}'`,
  `PIP_CERT='${CA_PATH}'`,
  `AWS_CA_BUNDLE='${CA_PATH}'`,
  `CARGO_HTTP_CAINFO='${CA_PATH}'`,
  `DENO_CERT='${CA_PATH}'`,
].join(' ');

describe('applyBashTrustEnv', () => {
  it('prefixes approved Bash commands with neutral CA trust aliases', () => {
    const updated = applyBashTrustEnv(
      'Bash',
      { command: 'gog sheets get budget' },
      {
        NODE_EXTRA_CA_CERTS: CA_PATH,
        HTTP_PROXY: 'http://proxy-with-token.example',
      },
    );

    expect(updated).toEqual({
      command: `${TRUST_PREFIX} gog sheets get budget`,
    });
    expect(updated).not.toHaveProperty('HTTP_PROXY');
  });

  it('supports the legacy cmd field used by runner permission tests', () => {
    const updated = applyBashTrustEnv(
      'Bash',
      { cmd: 'npm test --runInBand', apiToken: 'redacted-by-loggers' },
      { NODE_EXTRA_CA_CERTS: CA_PATH },
    );

    expect(updated).toEqual({
      cmd: `${TRUST_PREFIX} npm test --runInBand`,
      apiToken: 'redacted-by-loggers',
    });
  });

  it('leaves non-Bash tools unchanged and adds Go DNS resolver mode without CA input', () => {
    const nonBashInput = { command: 'gog sheets get budget' };
    const missingCaInput = { command: 'gog sheets get budget' };

    expect(
      applyBashTrustEnv('WebFetch', nonBashInput, {
        NODE_EXTRA_CA_CERTS: CA_PATH,
      }),
    ).toBe(nonBashInput);
    expect(applyBashTrustEnv('Bash', missingCaInput, {})).toEqual({
      command: 'GODEBUG=netdns=go gog sheets get budget',
    });
  });

  it('shell-quotes CA paths before prefixing the command', () => {
    const updated = applyBashTrustEnv(
      'Bash',
      { command: 'curl https://example.test' },
      { NODE_EXTRA_CA_CERTS: "/tmp/gantry/gateway ca's.pem" },
    );

    expect(updated).toEqual({
      command:
        'GODEBUG=netdns=go ' +
        "SSL_CERT_FILE='/tmp/gantry/gateway ca'\\''s.pem' " +
        "REQUESTS_CA_BUNDLE='/tmp/gantry/gateway ca'\\''s.pem' " +
        "CURL_CA_BUNDLE='/tmp/gantry/gateway ca'\\''s.pem' " +
        "GIT_SSL_CAINFO='/tmp/gantry/gateway ca'\\''s.pem' " +
        "PIP_CERT='/tmp/gantry/gateway ca'\\''s.pem' " +
        "AWS_CA_BUNDLE='/tmp/gantry/gateway ca'\\''s.pem' " +
        "CARGO_HTTP_CAINFO='/tmp/gantry/gateway ca'\\''s.pem' " +
        "DENO_CERT='/tmp/gantry/gateway ca'\\''s.pem' " +
        'curl https://example.test',
    });
  });
});
