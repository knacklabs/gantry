import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CALLER_IDENTITY_UNAVAILABLE_MESSAGE,
  deriveCallerIdentityFromJid,
  injectIdentityHeaderIntoMcpCapability,
  projectCallerIdentityHeaders,
} from '@core/application/mcp/mcp-caller-identity.js';
import type { MaterializedMcpCapability } from '@core/application/mcp/mcp-server-materialization.js';

const TEST_SECRET = 'test_secret_thirty_two_bytes_long_xx';

function httpCap(
  overrides: Partial<MaterializedMcpCapability> = {},
): MaterializedMcpCapability {
  return {
    name: 'customer-api',
    callerIdentity: {
      mode: 'required',
      headerName: 'x-caller-identity',
      signingRef: 'CUSTOMER_API_IDENTITY_SECRET',
      source: { kind: 'conversation_jid_phone', jidPrefix: 'wa:' },
    },
    config: { type: 'http', url: 'http://127.0.0.1:8081/mcp' },
    allowedToolPatterns: [],
    autoApproveToolPatterns: [],
    allowedToolNames: [],
    autoApproveToolNames: [],
    required: false,
    ...overrides,
  };
}

function stdioCap(): MaterializedMcpCapability {
  return {
    name: 'some-stdio',
    callerIdentity: {
      mode: 'required',
      headerName: 'x-caller-identity',
      signingRef: 'CUSTOMER_API_IDENTITY_SECRET',
      source: { kind: 'conversation_jid_phone', jidPrefix: 'wa:' },
    },
    config: { type: 'stdio', command: 'node', args: [] },
    allowedToolPatterns: [],
    autoApproveToolPatterns: [],
    allowedToolNames: [],
    autoApproveToolNames: [],
    required: false,
  };
}

function parseIdentityHeader(raw: string): Record<string, string> {
  return Object.fromEntries(
    raw
      .split(';')
      .filter(Boolean)
      .map((part) => {
        const [key, ...rest] = part.split(':');
        return [key, rest.join(':')];
      }),
  );
}

function expectedSignature(input: {
  phone?: string;
  email?: string;
  ts: string;
}): string {
  return createHmac('sha256', TEST_SECRET)
    .update(
      [
        `phone=${input.phone ?? ''}`,
        `email=${(input.email ?? '').toLowerCase()}`,
        `ts=${input.ts}`,
      ].join('|'),
    )
    .digest('hex');
}

describe('deriveCallerIdentityFromJid', () => {
  it('returns +E.164 phone for a configured JID prefix', () => {
    expect(
      deriveCallerIdentityFromJid({
        jid: 'wa:917003705584',
        jidPrefix: 'wa:',
      }),
    ).toEqual({
      phone: '+917003705584',
    });
  });

  it('returns null for non-matching prefixes and invalid digits', () => {
    expect(
      deriveCallerIdentityFromJid({ jid: 'tg:-123', jidPrefix: 'wa:' }),
    ).toBeNull();
    expect(
      deriveCallerIdentityFromJid({ jid: 'wa:abc', jidPrefix: 'wa:' }),
    ).toBeNull();
    expect(
      deriveCallerIdentityFromJid({ jid: 'wa:123', jidPrefix: 'wa:' }),
    ).toBeNull();
  });
});

describe('injectIdentityHeaderIntoMcpCapability', () => {
  it('adds a signed caller identity header to http caps', () => {
    const cap = injectIdentityHeaderIntoMcpCapability({
      cap: httpCap(),
      identity: { phone: '+917003705584' },
      headerName: 'x-caller-identity',
      secret: TEST_SECRET,
    });
    expect(cap.config.type).toBe('http');
    const headerValue =
      (cap.config as { headers?: Record<string, string> }).headers?.[
        'x-caller-identity'
      ] ?? '';
    expect(headerValue).toMatch(/^phone:\+917003705584;ts:\d+;sig:[0-9a-f]+$/);
    const parsed = parseIdentityHeader(headerValue);
    expect(parsed.sig).toBe(
      expectedSignature({ phone: '+917003705584', ts: parsed.ts ?? '' }),
    );
  });

  it('preserves existing headers on the cap', () => {
    const cap = injectIdentityHeaderIntoMcpCapability({
      cap: httpCap({
        config: {
          type: 'http',
          url: 'http://127.0.0.1:8081/mcp',
          headers: { 'x-existing': 'keep-me' },
        },
      }),
      identity: { phone: '+14155551234' },
      headerName: 'x-caller-identity',
      secret: TEST_SECRET,
    });
    const headers = (cap.config as { headers: Record<string, string> }).headers;
    expect(headers['x-existing']).toBe('keep-me');
    expect(headers['x-caller-identity']).toMatch(/^phone:\+14155551234;/);
  });

  it('is a no-op for stdio caps', () => {
    const before = stdioCap();
    const after = injectIdentityHeaderIntoMcpCapability({
      cap: before,
      identity: { phone: '+14155551234' },
      headerName: 'x-caller-identity',
      secret: TEST_SECRET,
    });
    expect(after).toEqual(before);
  });

  it('includes lowercased email when present', () => {
    const cap = injectIdentityHeaderIntoMcpCapability({
      cap: httpCap(),
      identity: { phone: '+14155551234', email: 'A@B.COM' },
      headerName: 'x-caller-identity',
      secret: TEST_SECRET,
    });
    const headerValue = (cap.config as { headers: Record<string, string> })
      .headers['x-caller-identity'];
    expect(headerValue).toContain('email:a@b.com');
  });
});

describe('projectCallerIdentityHeaders', () => {
  it('signs only capabilities that opt into caller identity', () => {
    const result = projectCallerIdentityHeaders({
      capabilities: [
        httpCap(),
        httpCap({
          name: 'inventory-api',
          callerIdentity: undefined,
          config: { type: 'http', url: 'http://127.0.0.1:18081/mcp' },
        }),
      ],
      chatJid: 'wa:919654405340',
      credentialEnv: { CUSTOMER_API_IDENTITY_SECRET: TEST_SECRET },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [customer, inventory] = result.capabilities;
    expect(
      (customer?.config as { headers?: Record<string, string> }).headers?.[
        'x-caller-identity'
      ],
    ).toMatch(/^phone:\+919654405340;ts:\d+;sig:[0-9a-f]+$/);
    expect(
      (inventory?.config as { headers?: Record<string, string> }).headers,
    ).toBeUndefined();
  });

  it('fails closed when the signing secret is missing', () => {
    const result = projectCallerIdentityHeaders({
      capabilities: [httpCap()],
      chatJid: 'wa:919654405340',
      credentialEnv: {},
    });

    expect(result).toMatchObject({
      ok: false,
      error: CALLER_IDENTITY_UNAVAILABLE_MESSAGE,
      internalError: expect.stringContaining('CUSTOMER_API_IDENTITY_SECRET'),
    });
  });

  it('fails closed when the conversation identity is unavailable', () => {
    const result = projectCallerIdentityHeaders({
      capabilities: [httpCap()],
      chatJid: 'tg:-123',
      credentialEnv: { CUSTOMER_API_IDENTITY_SECRET: TEST_SECRET },
    });

    expect(result).toMatchObject({
      ok: false,
      error: CALLER_IDENTITY_UNAVAILABLE_MESSAGE,
      internalError: expect.stringContaining('wa: conversation identity'),
    });
  });
});
