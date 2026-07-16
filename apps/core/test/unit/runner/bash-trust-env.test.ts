import { describe, expect, it } from 'vitest';

import { applyBashTrustEnv } from '../../../src/adapters/llm/anthropic-claude-agent/runner/bash-trust-env.js';

const CA_PATH = '/tmp/gantry/model_gateway-ca.pem';
const TOOL_PROXY_URL = 'http://127.0.0.1:18080/';
const TRUST_PREFIX = [
  'GODEBUG=netdns=go',
  `HTTP_PROXY='${TOOL_PROXY_URL}'`,
  `HTTPS_PROXY='${TOOL_PROXY_URL}'`,
  `http_proxy='${TOOL_PROXY_URL}'`,
  `https_proxy='${TOOL_PROXY_URL}'`,
  "NODE_USE_ENV_PROXY='1'",
  "NO_PROXY='127.0.0.1,localhost,::1'",
  "no_proxy='127.0.0.1,localhost,::1'",
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
      { command: 'acme records get budget' },
      {
        HTTP_PROXY: TOOL_PROXY_URL,
        HTTPS_PROXY: TOOL_PROXY_URL,
        http_proxy: TOOL_PROXY_URL,
        https_proxy: TOOL_PROXY_URL,
        NODE_USE_ENV_PROXY: '1',
        NO_PROXY: '127.0.0.1,localhost,::1',
        no_proxy: '127.0.0.1,localhost,::1',
        SSL_CERT_FILE: CA_PATH,
        REQUESTS_CA_BUNDLE: CA_PATH,
        CURL_CA_BUNDLE: CA_PATH,
        GIT_SSL_CAINFO: CA_PATH,
        PIP_CERT: CA_PATH,
        AWS_CA_BUNDLE: CA_PATH,
        CARGO_HTTP_CAINFO: CA_PATH,
        DENO_CERT: CA_PATH,
      },
    );

    expect(updated).toEqual({
      command: `${TRUST_PREFIX} acme records get budget`,
    });
    expect(updated).not.toHaveProperty('HTTP_PROXY');
  });

  it('supports the legacy cmd field used by runner permission tests', () => {
    const updated = applyBashTrustEnv(
      'Bash',
      { cmd: 'npm test --runInBand', apiToken: 'redacted-by-loggers' },
      { REQUESTS_CA_BUNDLE: CA_PATH },
    );

    expect(updated).toEqual({
      cmd: `${['GODEBUG=netdns=go', `REQUESTS_CA_BUNDLE='${CA_PATH}'`].join(
        ' ',
      )} npm test --runInBand`,
      apiToken: 'redacted-by-loggers',
    });
  });

  it('also prefixes RunCommand because it is enforced through SDK Bash', () => {
    const updated = applyBashTrustEnv(
      'RunCommand',
      { command: '/opt/tools/fake-cli records get record-id' },
      { REQUESTS_CA_BUNDLE: CA_PATH },
    );

    expect(updated).toEqual({
      command: `${['GODEBUG=netdns=go', `REQUESTS_CA_BUNDLE='${CA_PATH}'`].join(
        ' ',
      )} /opt/tools/fake-cli records get record-id`,
    });
  });

  it('leaves non-Bash tools unchanged and adds Go DNS resolver mode without CA input', () => {
    const nonBashInput = { command: 'acme records get budget' };
    const missingCaInput = { command: 'acme records get budget' };

    expect(
      applyBashTrustEnv('WebFetch', nonBashInput, {
        REQUESTS_CA_BUNDLE: CA_PATH,
      }),
    ).toBe(nonBashInput);
    expect(applyBashTrustEnv('Bash', missingCaInput, {})).toEqual({
      command: 'GODEBUG=netdns=go acme records get budget',
    });
  });

  it('shell-quotes CA paths before prefixing the command', () => {
    const updated = applyBashTrustEnv(
      'Bash',
      { command: 'curl https://example.test' },
      { REQUESTS_CA_BUNDLE: "/tmp/gantry/gateway ca's.pem" },
    );

    expect(updated).toEqual({
      command:
        'GODEBUG=netdns=go ' +
        "REQUESTS_CA_BUNDLE='/tmp/gantry/gateway ca'\\''s.pem' " +
        'curl https://example.test',
    });
  });
});
