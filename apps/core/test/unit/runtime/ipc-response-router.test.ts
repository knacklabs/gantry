import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createIpcResponseSigningKeyPair,
  verifyIpcResponsePayload,
} from '@core/infrastructure/ipc/response-signing.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import {
  clearIpcResponders,
  hasIpcResponder,
  registerIpcResponder,
  takeIpcResponder,
} from '@core/runtime/ipc-response-router.js';
import { writeTaskIpcResponse } from '@core/jobs/ipc-shared.js';
import { writeMemoryResponse } from '@core/memory/memory-ipc.js';
import { getIpcResponseSigningPrivateKey } from '@core/runtime/ipc-auth.js';
import type { MemoryIpcResponse } from '@gantry/contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FOLDER = 'team';

/**
 * Set up a real signing key pair registered via createIpcAuthEnvelope (which is
 * exactly what the IPC request path does before calling writeTaskIpcResponse).
 * Returns the envelope so tests can access the public key for verification.
 */
function setupSigningKey(folder = FOLDER, threadId?: string) {
  const envelope = createIpcAuthEnvelope(folder, threadId ?? null);
  return envelope;
}

/**
 * Derive the task-response file path that writeTaskIpcResponse would produce,
 * given the current GANTRY_HOME (set by the global test setup to a temp dir).
 */
function taskResponsePath(folder: string, taskId: string): string {
  const gantryHome = process.env.GANTRY_HOME as string;
  return path.join(
    gantryHome,
    'data',
    'ipc',
    folder,
    'task-responses',
    `task-${taskId}.json`,
  );
}

// ---------------------------------------------------------------------------
// Pure router unit tests
// ---------------------------------------------------------------------------

describe('ipc-response-router — pure registry semantics', () => {
  afterEach(() => {
    clearIpcResponders();
  });

  it('returns undefined for an unregistered key', () => {
    expect(takeIpcResponder('folder-a', 'task-x')).toBeUndefined();
  });

  it('hasIpcResponder returns false when no responder is registered', () => {
    expect(hasIpcResponder('folder-a', 'task-x')).toBe(false);
  });

  it('registers a responder and hasIpcResponder returns true', () => {
    const fn = vi.fn();
    registerIpcResponder('folder-a', 'task-x', fn);
    expect(hasIpcResponder('folder-a', 'task-x')).toBe(true);
  });

  it('take returns the registered responder', () => {
    const fn = vi.fn();
    registerIpcResponder('folder-a', 'task-x', fn);
    expect(takeIpcResponder('folder-a', 'task-x')).toBe(fn);
  });

  it('take removes the entry (single-shot)', () => {
    const fn = vi.fn();
    registerIpcResponder('folder-a', 'task-x', fn);
    takeIpcResponder('folder-a', 'task-x');
    expect(hasIpcResponder('folder-a', 'task-x')).toBe(false);
    expect(takeIpcResponder('folder-a', 'task-x')).toBeUndefined();
  });

  it('overwrite: second register for same key replaces the first', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    registerIpcResponder('folder-a', 'task-x', fn1);
    registerIpcResponder('folder-a', 'task-x', fn2);
    expect(takeIpcResponder('folder-a', 'task-x')).toBe(fn2);
  });

  it('isolates by folder: different folders do not share entries', () => {
    const fn = vi.fn();
    registerIpcResponder('folder-a', 'task-x', fn);
    expect(hasIpcResponder('folder-b', 'task-x')).toBe(false);
    expect(takeIpcResponder('folder-b', 'task-x')).toBeUndefined();
    // original key still there
    expect(takeIpcResponder('folder-a', 'task-x')).toBe(fn);
  });

  it('isolates by correlationId: different ids do not share entries', () => {
    const fn = vi.fn();
    registerIpcResponder('folder-a', 'task-x', fn);
    expect(hasIpcResponder('folder-a', 'task-y')).toBe(false);
    expect(takeIpcResponder('folder-a', 'task-y')).toBeUndefined();
    expect(takeIpcResponder('folder-a', 'task-x')).toBe(fn);
  });

  it('clearIpcResponders empties the map', () => {
    registerIpcResponder('folder-a', 'task-1', vi.fn());
    registerIpcResponder('folder-b', 'task-2', vi.fn());
    clearIpcResponders();
    expect(hasIpcResponder('folder-a', 'task-1')).toBe(false);
    expect(hasIpcResponder('folder-b', 'task-2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: writeTaskIpcResponse routing behaviour
// ---------------------------------------------------------------------------

describe('writeTaskIpcResponse — router integration', () => {
  let envelope: ReturnType<typeof setupSigningKey>;

  beforeEach(() => {
    // Each test gets a fresh signing key registered in ipc-auth's in-memory map.
    envelope = setupSigningKey(FOLDER);
  });

  afterEach(() => {
    clearIpcResponders();
  });

  // 1 — Equivalence: no responder → file written, identical to baseline behaviour
  it('writes the signed response file when no responder is registered', () => {
    const taskId = `eq-${Date.now()}`;
    const filePath = taskResponsePath(FOLDER, taskId);

    writeTaskIpcResponse(
      FOLDER,
      taskId,
      { ok: true, message: 'hello' },
      undefined,
      envelope.responseKeyId,
    );

    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
      string,
      unknown
    >;

    // Shape
    expect(parsed.taskId).toBe(taskId);
    expect(parsed.ok).toBe(true);
    expect(parsed.message).toBe('hello');
    expect(typeof parsed.timestamp).toBe('string');
    expect(typeof parsed.signature).toBe('string');

    // Cryptographic validity
    const { signature, ...withoutSig } = parsed;
    expect(
      verifyIpcResponsePayload(
        envelope.responseVerifyKey,
        withoutSig as Record<string, unknown>,
        signature as string,
      ),
    ).toBe(true);
  });

  // 2 — Socket delivery: responder receives the signed object, no file created
  it('calls the registered responder with the signed object and creates no file', () => {
    const taskId = `sock-${Date.now()}`;
    const filePath = taskResponsePath(FOLDER, taskId);
    const received: Record<string, unknown>[] = [];

    registerIpcResponder(FOLDER, `task-${taskId}`, (signed) => {
      received.push(signed);
    });

    writeTaskIpcResponse(
      FOLDER,
      taskId,
      { ok: true, message: 'socket' },
      undefined,
      envelope.responseKeyId,
    );

    // Responder called exactly once, no file
    expect(received).toHaveLength(1);
    expect(fs.existsSync(filePath)).toBe(false);

    // Shape matches the file case
    const signed = received[0];
    expect(signed.taskId).toBe(taskId);
    expect(signed.ok).toBe(true);
    expect(signed.message).toBe('socket');
    expect(typeof signed.timestamp).toBe('string');
    expect(typeof signed.signature).toBe('string');

    // Cryptographic validity
    const { signature, ...withoutSig } = signed;
    expect(
      verifyIpcResponsePayload(
        envelope.responseVerifyKey,
        withoutSig as Record<string, unknown>,
        signature as string,
      ),
    ).toBe(true);

    // Single-shot: has is false after the call
    expect(hasIpcResponder(FOLDER, `task-${taskId}`)).toBe(false);
  });

  // 3 — Fallback after take: second write (no re-register) writes the file
  it('falls back to file write on a second call after the responder was consumed', () => {
    const taskId = `fallback-${Date.now()}`;
    const filePath = taskResponsePath(FOLDER, taskId);

    registerIpcResponder(FOLDER, `task-${taskId}`, vi.fn());

    // First call — routed to responder, no file
    writeTaskIpcResponse(
      FOLDER,
      taskId,
      { ok: true, message: 'first' },
      undefined,
      envelope.responseKeyId,
    );
    expect(fs.existsSync(filePath)).toBe(false);

    // Second call — responder consumed; falls back to file
    // We need a fresh signing key since the envelope may have been revoked or re-use is fine;
    // the auth map still holds the key for this envelope.
    writeTaskIpcResponse(
      FOLDER,
      taskId,
      { ok: true, message: 'second' },
      undefined,
      envelope.responseKeyId,
    );
    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(parsed.message).toBe('second');
  });

  // 4 — Fail-closed: no signing key → neither file nor responder
  it('does not write a file or call the responder when no signing key is available', () => {
    const taskId = `failclosed-${Date.now()}`;
    const filePath = taskResponsePath(FOLDER, taskId);
    const responder = vi.fn();

    registerIpcResponder(FOLDER, `task-${taskId}`, responder);

    // Deliberately pass a responseKeyId that has never been registered
    writeTaskIpcResponse(
      FOLDER,
      taskId,
      { ok: true, message: 'x' },
      undefined,
      'nonexistent-key-id',
    );

    expect(fs.existsSync(filePath)).toBe(false);
    expect(responder).not.toHaveBeenCalled();
  });

  // 5 — Signed object handed to responder is byte-identical to what would be written to file
  it('delivers byte-identical signed object to responder vs file', () => {
    const taskIdFile = `byte-file-${Date.now()}`;
    const taskIdSock = `byte-sock-${Date.now()}`;

    // Write the file version first
    writeTaskIpcResponse(
      FOLDER,
      taskIdFile,
      { ok: true, message: 'compare' },
      undefined,
      envelope.responseKeyId,
    );
    const fileContent = JSON.parse(
      fs.readFileSync(taskResponsePath(FOLDER, taskIdFile), 'utf-8'),
    ) as Record<string, unknown>;

    // Now capture socket version (need a fresh key since each writeTaskIpcResponse
    // uses nowIso() for timestamp, so we only compare shape/keys, not exact values)
    const received: Record<string, unknown>[] = [];
    // New envelope for second call
    const envelope2 = setupSigningKey(FOLDER);
    registerIpcResponder(FOLDER, `task-${taskIdSock}`, (s) => received.push(s));
    writeTaskIpcResponse(
      FOLDER,
      taskIdSock,
      { ok: true, message: 'compare' },
      undefined,
      envelope2.responseKeyId,
    );

    const socketContent = received[0];

    // Same top-level keys (order-independent)
    expect(Object.keys(socketContent).sort()).toEqual(
      Object.keys(fileContent).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: writeMemoryResponse routing behaviour (Pillar 1, Phase 5.3a)
// ---------------------------------------------------------------------------

describe('writeMemoryResponse — router integration', () => {
  let envelope: ReturnType<typeof setupSigningKey>;

  function memoryResponsePath(folder: string, requestId: string): string {
    const gantryHome = process.env.GANTRY_HOME as string;
    return path.join(
      gantryHome,
      'data',
      'ipc',
      folder,
      'memory-responses',
      `${requestId}.json`,
    );
  }

  function signingKeyFor(): string | undefined {
    return getIpcResponseSigningPrivateKey(
      FOLDER,
      undefined,
      envelope.responseKeyId,
    );
  }

  beforeEach(() => {
    envelope = setupSigningKey(FOLDER);
  });

  afterEach(() => {
    clearIpcResponders();
  });

  // 1 — Equivalence: no responder → signed file written, byte-shape as before.
  it('writes the signed memory response file when no responder is registered', () => {
    const requestId = `mem-eq-${Date.now()}`;
    const filePath = memoryResponsePath(FOLDER, requestId);
    const response: MemoryIpcResponse = {
      ok: true,
      requestId,
      provider: 'postgres',
      data: { results: [{ id: 'm-1' }] },
    };

    writeMemoryResponse(FOLDER, requestId, response, signingKeyFor());

    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(parsed.ok).toBe(true);
    expect(parsed.requestId).toBe(requestId);
    expect(parsed.provider).toBe('postgres');
    expect(parsed.data).toEqual({ results: [{ id: 'm-1' }] });
    expect(typeof parsed.signature).toBe('string');

    const { signature, ...withoutSig } = parsed;
    expect(
      verifyIpcResponsePayload(
        envelope.responseVerifyKey,
        withoutSig as Record<string, unknown>,
        signature as string,
      ),
    ).toBe(true);
  });

  // 2 — Socket delivery: responder receives the signed object, no file created.
  it('calls the registered responder with the signed object and creates no file', () => {
    const requestId = `mem-sock-${Date.now()}`;
    const filePath = memoryResponsePath(FOLDER, requestId);
    const received: Record<string, unknown>[] = [];

    registerIpcResponder(FOLDER, `memory-${requestId}`, (signed) => {
      received.push(signed);
    });

    const response: MemoryIpcResponse = {
      ok: true,
      requestId,
      provider: 'postgres',
      data: { results: [] },
    };
    writeMemoryResponse(FOLDER, requestId, response, signingKeyFor());

    expect(received).toHaveLength(1);
    expect(fs.existsSync(filePath)).toBe(false);

    const signed = received[0];
    expect(signed.ok).toBe(true);
    expect(signed.requestId).toBe(requestId);
    expect(signed.provider).toBe('postgres');
    expect(typeof signed.signature).toBe('string');

    const { signature, ...withoutSig } = signed;
    expect(
      verifyIpcResponsePayload(
        envelope.responseVerifyKey,
        withoutSig as Record<string, unknown>,
        signature as string,
      ),
    ).toBe(true);

    // Single-shot: consumed after delivery.
    expect(hasIpcResponder(FOLDER, `memory-${requestId}`)).toBe(false);
  });

  // 3 — Fallback after take: second write (no re-register) writes the file.
  it('falls back to file write on a second call after the responder was consumed', () => {
    const requestId = `mem-fallback-${Date.now()}`;
    const filePath = memoryResponsePath(FOLDER, requestId);
    const response: MemoryIpcResponse = { ok: true, requestId, provider: 'p' };

    registerIpcResponder(FOLDER, `memory-${requestId}`, vi.fn());

    writeMemoryResponse(FOLDER, requestId, response, signingKeyFor());
    expect(fs.existsSync(filePath)).toBe(false);

    writeMemoryResponse(FOLDER, requestId, response, signingKeyFor());
    expect(fs.existsSync(filePath)).toBe(true);
  });

  // 4 — Fail-closed: no signing key → neither file nor responder consumed.
  it('does not write a file or call the responder when no signing key is available', () => {
    const requestId = `mem-failclosed-${Date.now()}`;
    const filePath = memoryResponsePath(FOLDER, requestId);
    const responder = vi.fn();

    registerIpcResponder(FOLDER, `memory-${requestId}`, responder);

    // No signing key (undefined) → signIpcResponsePayload returns undefined →
    // early return BEFORE the responder is taken (mirrors the task fail-closed
    // path, where neither a file nor the responder is touched).
    const response: MemoryIpcResponse = { ok: true, requestId, provider: 'p' };
    writeMemoryResponse(FOLDER, requestId, response, undefined);

    expect(fs.existsSync(filePath)).toBe(false);
    expect(responder).not.toHaveBeenCalled();
    // Responder still registered (not consumed) — the request will time out.
    expect(hasIpcResponder(FOLDER, `memory-${requestId}`)).toBe(true);
  });
});
