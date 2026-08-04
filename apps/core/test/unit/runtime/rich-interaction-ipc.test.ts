import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { signIpcRequestPayload } from '@core/infrastructure/ipc/request-signing.js';
import { computeIpcAuthToken } from '@core/runtime/ipc-auth.js';
import { clearConsumedIpcRequestIds } from '@core/runtime/ipc-auth-validation.js';
import { parseRichInteractionIpcRequest } from '@core/runtime/ipc-parsing.js';
import { processRichInteractionIpc } from '@core/runtime/ipc-rich-interaction-processing.js';
import type { IpcDeps } from '@core/runtime/ipc-domain-types.js';

function signedPayload(
  payload: Record<string, unknown>,
  sourceAgentFolder = 'team',
  threadId?: string,
): Record<string, unknown> {
  const signingKey = computeIpcAuthToken(sourceAgentFolder, threadId);
  return {
    ...payload,
    signature: signIpcRequestPayload(signingKey, payload),
  };
}

function signedRichPayload(payload: Record<string, unknown>) {
  return signedPayload(payload, 'team', 'thread-1');
}

function richPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'rich_interaction',
    requestId: `rich-${randomUUID()}`,
    nonce: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    targetJid: 'slack:C123',
    context: { chatJid: 'slack:C123', threadId: 'thread-1' },
    interaction: {
      id: 'lead-form',
      title: 'Lead qualification',
      fallbackText: 'Lead qualification form',
      rich: {
        kind: 'form',
        fallbackText: 'Lead qualification form',
        payload: {
          fields: [
            { id: 'company', label: 'Company', type: 'text', required: true },
          ],
        },
      },
    },
    ...overrides,
  };
}

function deps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  return {
    sendMessage: vi.fn(),
    conversationRoutes: vi.fn(() => ({})),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    onSchedulerChanged: vi.fn(),
    requestPermissionApproval: vi.fn(),
    requestUserAnswer: vi.fn(),
    opsRepository: {} as never,
    ...overrides,
  };
}

describe('rich interaction IPC', () => {
  afterEach(() => {
    clearConsumedIpcRequestIds({ durable: 'consumed' });
  });

  it('accepts signed rich descriptors and enforces fallback text', () => {
    const parsed = parseRichInteractionIpcRequest(
      signedRichPayload(richPayload()),
      'team',
    );

    expect(parsed).toMatchObject({
      requestId: expect.stringMatching(/^rich-/),
      sourceAgentFolder: 'team',
      targetJid: 'slack:C123',
      descriptor: {
        id: 'lead-form',
        title: 'Lead qualification',
        fallbackText: 'Lead qualification form',
        rich: {
          kind: 'form',
          fallbackText: 'Lead qualification form',
          payload: {
            fields: [
              {
                id: 'company',
                label: 'Company',
                type: 'text',
                required: true,
              },
            ],
          },
        },
      },
    });
  });

  it('rejects forged rich IPC signatures before rendering', () => {
    const payload = richPayload();
    const signed = signedRichPayload(payload);

    expect(() =>
      parseRichInteractionIpcRequest(
        {
          ...signed,
          targetJid: 'slack:attacker',
        },
        'team',
      ),
    ).toThrow(/signature|auth|Invalid/i);
  });

  it('rejects rich form field types that native renderers do not implement', () => {
    expect(() =>
      parseRichInteractionIpcRequest(
        signedRichPayload(
          richPayload({
            interaction: {
              id: 'lead-form',
              title: 'Lead qualification',
              fallbackText: 'Lead qualification form',
              rich: {
                kind: 'form',
                fallbackText: 'Lead qualification form',
                payload: {
                  fields: [{ id: 'ok', label: 'OK', type: 'checkbox' }],
                },
              },
            },
          }),
        ),
        'team',
      ),
    ).toThrow(/field type/i);
  });

  it('falls back with exact copy when native rich rendering is unavailable', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-ipc-'));
    const claimedPath = path.join(tempDir, 'claimed.json');
    fs.writeFileSync(claimedPath, '{}');
    const sendMessage = vi.fn(async () => {});
    const request = parseRichInteractionIpcRequest(
      signedRichPayload(richPayload()),
      'team',
    );

    await processRichInteractionIpc({
      request,
      sourceAgentFolder: 'team',
      deps: deps({ sendMessage }),
      ipcBaseDir: tempDir,
      file: 'rich.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'slack:C123',
      'Rich view unavailable in this conversation. Showing text version.\n\nLead qualification form',
      { threadId: 'thread-1' },
    );
    expect(fs.existsSync(claimedPath)).toBe(false);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('falls back when native rich rendering reports no delivery', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-ipc-'));
    const claimedPath = path.join(tempDir, 'claimed.json');
    fs.writeFileSync(claimedPath, '{}');
    const sendMessage = vi.fn(async () => {});
    const renderRichInteraction = vi.fn(async () => false);
    const request = parseRichInteractionIpcRequest(
      signedRichPayload(richPayload()),
      'team',
    );

    await processRichInteractionIpc({
      request,
      sourceAgentFolder: 'team',
      deps: deps({ sendMessage, renderRichInteraction }),
      ipcBaseDir: tempDir,
      file: 'rich.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    expect(renderRichInteraction).toHaveBeenCalledWith(
      'slack:C123',
      request,
      undefined,
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'slack:C123',
      'Rich view unavailable in this conversation. Showing text version.\n\nLead qualification form',
      { threadId: 'thread-1' },
    );
    expect(fs.existsSync(claimedPath)).toBe(false);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('routes progress through the edit-in-place progress card', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-ipc-'));
    const claimedPath = path.join(tempDir, 'claimed.json');
    fs.writeFileSync(claimedPath, '{}');
    const renderAgentTodo = vi.fn(async () => true);
    const renderRichInteraction = vi.fn(async () => true);
    const request = parseRichInteractionIpcRequest(
      signedRichPayload(
        richPayload({
          interaction: {
            id: 'skill-install-progress',
            title: 'Installing',
            fallbackText: 'Installing: 2 of 3',
            rich: {
              kind: 'progress',
              fallbackText: 'Installing: 2 of 3',
              payload: { label: '2 of 3', value: 50, done: true },
            },
          },
        }),
      ),
      'team',
    );

    await processRichInteractionIpc({
      request,
      sourceAgentFolder: 'team',
      deps: deps({ renderAgentTodo, renderRichInteraction }),
      ipcBaseDir: tempDir,
      file: 'rich.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    expect(renderAgentTodo).toHaveBeenCalledWith(
      'slack:C123',
      expect.objectContaining({
        summary: 'Installing… 2 of 3 — 50% — done',
        items: [],
        status: 'done',
        threadId: 'thread-1',
        cardKind: 'progress',
      }),
      undefined,
    );
    expect(renderRichInteraction).not.toHaveBeenCalled();
    expect(fs.existsSync(claimedPath)).toBe(false);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses the resolved provider account for rich fallback delivery', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-ipc-'));
    const claimedPath = path.join(tempDir, 'claimed.json');
    fs.writeFileSync(claimedPath, '{}');
    const sendMessage = vi.fn(async () => {});
    const request = {
      ...parseRichInteractionIpcRequest(
        signedRichPayload(richPayload()),
        'team',
      ),
      providerAccountId: 'acct:a',
    };

    await processRichInteractionIpc({
      request,
      sourceAgentFolder: 'team',
      deps: deps({ sendMessage }),
      ipcBaseDir: tempDir,
      file: 'rich.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'slack:C123',
      'Rich view unavailable in this conversation. Showing text version.\n\nLead qualification form',
      { threadId: 'thread-1', providerAccountId: 'acct:a' },
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
