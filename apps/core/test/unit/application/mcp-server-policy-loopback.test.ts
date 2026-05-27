import { describe, expect, it } from 'vitest';

import { validateTransportConfig } from '@core/application/mcp/mcp-server-policy.js';
import { ApplicationError } from '@core/application/common/application-error.js';

const STDIO_OPTS = { sandboxProfileId: 'default' };

describe('validateTransportConfig (loopback exception)', () => {
  it('passes http://127.0.0.1', () => {
    expect(() =>
      validateTransportConfig({
        transport: 'http',
        url: 'http://127.0.0.1:8081/mcp',
      }),
    ).not.toThrow();
  });

  it('passes http://[::1]', () => {
    expect(() =>
      validateTransportConfig({
        transport: 'http',
        url: 'http://[::1]:8081/mcp',
      }),
    ).not.toThrow();
  });

  it('passes any 127.x.x.x address (entire /8)', () => {
    expect(() =>
      validateTransportConfig({
        transport: 'http',
        url: 'http://127.255.255.254:9000/mcp',
      }),
    ).not.toThrow();
  });

  it('rejects http://10.0.0.1 (private but not loopback)', () => {
    expect(() =>
      validateTransportConfig({
        transport: 'http',
        url: 'http://10.0.0.1:8081/mcp',
      }),
    ).toThrow(ApplicationError);
  });

  it('rejects http://example.com (non-loopback http)', () => {
    expect(() =>
      validateTransportConfig({
        transport: 'http',
        url: 'http://example.com/mcp',
      }),
    ).toThrow(ApplicationError);
  });

  it('passes https://api.example.com (unchanged remote https behavior)', () => {
    expect(() =>
      validateTransportConfig({
        transport: 'http',
        url: 'https://api.example.com/mcp',
      }),
    ).not.toThrow();
  });

  it('rejects http://localhost (hostname is still rejected, only IP loopback is exempt)', () => {
    expect(() =>
      validateTransportConfig({
        transport: 'http',
        url: 'http://localhost:8081/mcp',
      }),
    ).toThrow(ApplicationError);
  });

  it('rejects https://127.0.0.1 because the exception is only for plain loopback http', () => {
    expect(() =>
      validateTransportConfig({
        transport: 'http',
        url: 'https://127.0.0.1:8081/mcp',
      }),
    ).toThrow(ApplicationError);
  });

  it('still rejects URLs that embed credentials', () => {
    expect(() =>
      validateTransportConfig({
        transport: 'http',
        url: 'http://user:pass@127.0.0.1:8081/mcp',
      }),
    ).toThrow(/credentials/);
  });

  it('passes sse with loopback', () => {
    expect(() =>
      validateTransportConfig({
        transport: 'sse',
        url: 'http://127.0.0.1:8081/sse',
      }),
    ).not.toThrow();
  });

  it('does not affect stdio_template validation', () => {
    expect(() =>
      validateTransportConfig(
        {
          transport: 'stdio_template',
          templateId: 'node-script',
          args: [],
        },
        STDIO_OPTS,
      ),
    ).not.toThrow();
  });

  it('accepts caller identity config for http transports', () => {
    expect(() =>
      validateTransportConfig({
        transport: 'http',
        url: 'http://127.0.0.1:8081/mcp',
        callerIdentity: {
          mode: 'required',
          headerName: 'x-caller-identity',
          signingRef: 'CUSTOMER_API_IDENTITY_SECRET',
          source: { kind: 'conversation_jid_phone', jidPrefix: 'wa:' },
        },
      }),
    ).not.toThrow();
  });

  it('rejects caller identity config on stdio transports', () => {
    expect(() =>
      validateTransportConfig(
        {
          transport: 'stdio_template',
          templateId: 'node-script',
          callerIdentity: {
            mode: 'required',
            headerName: 'x-caller-identity',
            signingRef: 'CUSTOMER_API_IDENTITY_SECRET',
            source: { kind: 'conversation_jid_phone', jidPrefix: 'wa:' },
          },
        },
        STDIO_OPTS,
      ),
    ).toThrow(/HTTP or SSE/);
  });

  it('rejects caller identity config with invalid secret refs', () => {
    expect(() =>
      validateTransportConfig({
        transport: 'http',
        url: 'http://127.0.0.1:8081/mcp',
        callerIdentity: {
          mode: 'required',
          headerName: 'x-caller-identity',
          signingRef: 'not valid',
          source: { kind: 'conversation_jid_phone', jidPrefix: 'wa:' },
        },
      }),
    ).toThrow(/signingRef/);
  });
});
