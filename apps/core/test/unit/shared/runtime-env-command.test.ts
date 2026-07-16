import { describe, expect, it, vi } from 'vitest';

import {
  stripHostInjectedEnvPrefix,
  stripRuntimeEnvPrefix,
} from '@core/shared/runtime-env-command.js';

describe('stripRuntimeEnvPrefix', () => {
  it('strips the recognized runtime environment prefix', () => {
    expect(
      stripRuntimeEnvPrefix(
        "GODEBUG='http2client=0' HTTP_PROXY=http://127.0.0.1:8080 HTTPS_PROXY=http://127.0.0.1:8080 NO_PROXY=localhost NODE_USE_ENV_PROXY=1 /opt/tools/fake-cli records get --help",
      ),
    ).toEqual({
      command: '/opt/tools/fake-cli records get --help',
      envAssignments: [
        "GODEBUG='http2client=0'",
        'HTTP_PROXY=http://127.0.0.1:8080',
        'HTTPS_PROXY=http://127.0.0.1:8080',
        'NO_PROXY=localhost',
        'NODE_USE_ENV_PROXY=1',
      ],
    });
  });

  it('leaves commands without a recognized runtime prefix unchanged', () => {
    expect(stripRuntimeEnvPrefix('/opt/tools/fake-cli records list')).toEqual({
      command: '/opt/tools/fake-cli records list',
      envAssignments: [],
    });
  });
});

describe('stripHostInjectedEnvPrefix', () => {
  it('strips the full host loopback environment prefix', () => {
    const assignments = [
      'GODEBUG=netdns=go',
      "HTTP_PROXY='http://127.0.0.1:18790/'",
      "HTTPS_PROXY='https://localhost:18790'",
      "http_proxy='http://[::1]:18790/'",
      "https_proxy='https://127.0.0.1'",
      "ALL_PROXY='http://localhost:18790/'",
      "all_proxy='https://[::1]'",
      "GRPC_PROXY='http://127.0.0.1:18790'",
      "grpc_proxy='https://localhost/'",
      "NO_PROXY='127.0.0.1,localhost,::1'",
      "no_proxy='::1,localhost,127.0.0.1'",
      "NODE_USE_ENV_PROXY='1'",
    ];

    expect(
      stripHostInjectedEnvPrefix(
        `${assignments.join(' ')} /opt/tools/fake-cli records get --help`,
      ),
    ).toEqual({
      command: '/opt/tools/fake-cli records get --help',
      strippedAssignments: assignments,
    });
  });

  it('does not strip a non-loopback proxy assignment', () => {
    const command = "HTTP_PROXY='http://attacker.example' curl example.com";

    expect(stripHostInjectedEnvPrefix(command)).toEqual({
      command,
      strippedAssignments: [],
    });
  });

  it.each([
    "HTTP_PROXY='http://127.0.0.1'@attacker.example curl example.com",
    "HTTP_PROXY='http://127.0.0.1:99999' curl example.com",
  ])('does not strip malformed host-looking assignment %s', (command) => {
    expect(stripHostInjectedEnvPrefix(command)).toEqual({
      command,
      strippedAssignments: [],
    });
  });

  it('stops at the first non-scaffolding assignment', () => {
    expect(
      stripHostInjectedEnvPrefix(
        "HTTP_PROXY='http://127.0.0.1:18790/' GIT_SSH_COMMAND='ssh -o ProxyCommand=evil' FOO=bar git status",
      ),
    ).toEqual({
      command: "GIT_SSH_COMMAND='ssh -o ProxyCommand=evil' FOO=bar git status",
      strippedAssignments: ["HTTP_PROXY='http://127.0.0.1:18790/'"],
    });
  });

  it('strips CA trust assignments only at their trusted runtime value', () => {
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/tmp/known-ca.pem');

    expect(
      stripHostInjectedEnvPrefix(
        "SSL_CERT_FILE='/tmp/known-ca.pem' /opt/tools/fake-cli records get --help",
      ),
    ).toEqual({
      command: '/opt/tools/fake-cli records get --help',
      strippedAssignments: ["SSL_CERT_FILE='/tmp/known-ca.pem'"],
    });
    const command =
      "SSL_CERT_FILE='/tmp/untrusted-ca.pem' /opt/tools/fake-cli records get --help";
    expect(stripHostInjectedEnvPrefix(command)).toEqual({
      command,
      strippedAssignments: [],
    });

    vi.unstubAllEnvs();
  });
});
