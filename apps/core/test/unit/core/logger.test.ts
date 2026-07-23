import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixedClock } from '@core/shared/time/datetime.js';
import {
  createLogger,
  currentLogContext,
  installGlobalErrorHandlers,
  logger,
  redactString,
  type LogRecord,
  type LogSink,
  withLogContext,
} from '@core/infrastructure/logging/logger.js';

describe('logger', () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrWriteSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
  });

  it('writes text logs to stderr for warn/error/fatal', () => {
    const l = createLogger({
      level: 'debug',
      clock: fixedClock('2026-04-21T00:00:00.000Z'),
      format: 'text',
    });
    l.warn('warning message');
    const output = stderrWriteSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join('');
    expect(output).toContain('WARN');
    expect(output).toContain('warning message');
    expect(output).toContain('2026-04-21T00:00:00.000Z');
  });

  it('writes json logs when json format is selected', () => {
    const l = createLogger({
      level: 'debug',
      clock: fixedClock('2026-04-21T00:00:00.000Z'),
      format: 'json',
    });
    l.info({ foo: 'bar' }, 'json log');
    const output = stdoutWriteSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join('')
      .trim();
    const parsed = JSON.parse(output) as LogRecord;
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('json log');
    expect(parsed.context).toEqual({ foo: 'bar' });
    expect(parsed.timestamp).toBe('2026-04-21T00:00:00.000Z');
  });

  it('supports sink injection and child context', () => {
    const records: LogRecord[] = [];
    const sink: LogSink = {
      write: (record) => {
        records.push(record);
      },
    };
    const l = createLogger({
      level: 'debug',
      sink,
      clock: fixedClock('2026-04-21T00:00:00.000Z'),
      context: { scope: 'root' },
    });
    l.child({ group: 'team-a' }).info({ event: 'start' }, 'child event');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'info',
      message: 'child event',
      context: { scope: 'root', group: 'team-a', event: 'start' },
    });
  });

  it('isolates per-turn context across concurrent async work', async () => {
    const records: LogRecord[] = [];
    const l = createLogger({
      level: 'debug',
      sink: { write: (record) => records.push(record) },
    });

    await Promise.all([
      withLogContext(
        { runId: 'run-a', appId: 'app-a', agentId: 'agent-a' },
        async () => {
          await Promise.resolve();
          l.info('turn a');
        },
      ),
      withLogContext(
        { runId: 'run-b', appId: 'app-b', agentId: 'agent-b' },
        async () => {
          await Promise.resolve();
          l.info('turn b');
        },
      ),
    ]);

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          context: { runId: 'run-a', appId: 'app-a', agentId: 'agent-a' },
        }),
        expect.objectContaining({
          context: { runId: 'run-b', appId: 'app-b', agentId: 'agent-b' },
        }),
      ]),
    );
    expect(currentLogContext()).toBeUndefined();
  });

  it('redacts merged object context once', () => {
    const redact = vi.fn((value: unknown) => value);
    const l = createLogger({
      level: 'debug',
      sink: { write: () => undefined },
      redact,
    });

    l.info({ event: 'start' }, 'event');

    expect(redact).toHaveBeenCalledTimes(1);
  });

  it('keeps base and child context for string-only log calls', () => {
    const records: LogRecord[] = [];
    const l = createLogger({
      level: 'debug',
      sink: { write: (record) => records.push(record) },
      context: { scope: 'root' },
    });
    l.child({ group: 'team-a' }).info('string only event');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'info',
      message: 'string only event',
      context: { scope: 'root', group: 'team-a' },
    });
  });

  it('redacts sensitive keys by default', () => {
    const records: LogRecord[] = [];
    const l = createLogger({
      level: 'debug',
      sink: { write: (record) => records.push(record) },
    });
    l.info(
      {
        apiToken: 'secret',
        nested: { password: 'p@ss', keep: 'ok' },
      },
      'redaction test',
    );
    expect(records[0]?.context).toEqual({
      apiToken: '[REDACTED]',
      nested: { password: '[REDACTED]', keep: 'ok' },
    });
  });

  it('redacts provider session handle keys and raw text fields by default', () => {
    const records: LogRecord[] = [];
    const uuidSessionHandle = '9f1d4b44-8347-4f6a-90b1-7262bc4f0db4';
    const shortSessionHandle = 'sess-abc';
    const l = createLogger({
      level: 'debug',
      sink: { write: (record) => records.push(record) },
      context: { latestProviderSessionId: uuidSessionHandle },
    });

    l.child({ externalSessionId: shortSessionHandle }).info(
      {
        sessionId: uuidSessionHandle,
        newSessionId: shortSessionHandle,
        providerSessionId: 'opaque-provider-handle',
        nested: {
          session_id: 'snake-opaque-handle',
          message:
            'runner framed {"newSessionId":"json-field-handle","providerSessionId":"provider-json-handle","externalSessionId":"external-json-handle","session_id":"snake-json-handle"} latestProviderSessionId: colon-field-handle sessionId=equals-field-handle newSessionId whitespace-field-handle standalone claude-session-raw-shape provider-session:raw-shape',
        },
      },
      'completed with {"newSessionId":"message-json-handle"} session_id=message-snake-handle sessionId message-whitespace-handle and claude-session-message-shape',
    );

    const serialized = JSON.stringify(records[0]);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain(uuidSessionHandle);
    expect(serialized).not.toContain(shortSessionHandle);
    expect(serialized).not.toContain('opaque-provider-handle');
    expect(serialized).not.toContain('snake-opaque-handle');
    expect(serialized).not.toContain('json-field-handle');
    expect(serialized).not.toContain('provider-json-handle');
    expect(serialized).not.toContain('external-json-handle');
    expect(serialized).not.toContain('snake-json-handle');
    expect(serialized).not.toContain('colon-field-handle');
    expect(serialized).not.toContain('equals-field-handle');
    expect(serialized).not.toContain('whitespace-field-handle');
    expect(serialized).not.toContain('message-json-handle');
    expect(serialized).not.toContain('message-snake-handle');
    expect(serialized).not.toContain('message-whitespace-handle');
    expect(serialized).not.toContain('claude-session-raw-shape');
    expect(serialized).not.toContain('provider-session:raw-shape');
    expect(serialized).not.toContain('claude-session-message-shape');
  });

  it('redacts credential-bearing URLs and assignment strings', () => {
    const input =
      "postgresql://postgres:secret@localhost:5432/gantry?sslmode=require POSTGRES_PASSWORD=secret ALTER ROLE gantry_app PASSWORD 'role-secret' https://user:pass@example.com/path?token=secret";

    const redacted = redactString(input);

    expect(redacted).not.toContain('secret');
    expect(redacted).not.toContain('pass@example');
    expect(redacted).toContain('postgresql://[REDACTED]@localhost');
    expect(redacted).toContain('POSTGRES_PASSWORD=[REDACTED]');
    expect(redacted).toContain("PASSWORD '[REDACTED]'");
    expect(redacted).toContain('token=[REDACTED]');
  });

  it('redacts run-scoped gateway tokens (gtw_)', () => {
    const input =
      'projected OPENAI_API_KEY using token gtw_abc123.DEF-456_xyz for the run';
    const redacted = redactString(input);
    expect(redacted).not.toContain('gtw_abc123.DEF-456_xyz');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts AWS and service-account credential material', () => {
    const input =
      'accessKeyId=AKIAABCDEFGHIJKLMNOP secretAccessKey=camelsecret42 sessionToken=session-raw-token private_key=inline-key serviceAccountJson={"private_key":"-----BEGIN PRIVATE KEY-----\\nraw\\n-----END PRIVATE KEY-----"}';
    const redacted = redactString(input);
    expect(redacted).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(redacted).not.toContain('camelsecret42');
    expect(redacted).not.toContain('session-raw-token');
    expect(redacted).not.toContain('inline-key');
    expect(redacted).not.toContain('raw');
    expect(redacted).not.toContain('PRIVATE KEY');
    expect(redacted).toContain('[REDACTED]');
  });

  it('filters entries below configured level', () => {
    const records: LogRecord[] = [];
    const l = createLogger({
      level: 'warn',
      sink: { write: (record) => records.push(record) },
    });
    l.debug('skip debug');
    l.info('skip info');
    l.warn('emit warn');
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe('warn');
  });

  it('does not install process handlers on module import', async () => {
    vi.resetModules();
    const beforeUncaught = process.listeners('uncaughtException').length;
    const beforeUnhandled = process.listeners('unhandledRejection').length;
    await import('@core/infrastructure/logging/logger.js');
    const afterUncaught = process.listeners('uncaughtException').length;
    const afterUnhandled = process.listeners('unhandledRejection').length;
    expect(afterUncaught).toBe(beforeUncaught);
    expect(afterUnhandled).toBe(beforeUnhandled);
  });

  it('installs global handlers only when asked', () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const fatalSpy = vi.spyOn(logger, 'fatal');
    const errorSpy = vi.spyOn(logger, 'error');
    const cleanup = installGlobalErrorHandlers(logger);

    const uncaught = process.listeners('uncaughtException');
    const unhandled = process.listeners('unhandledRejection');
    expect(uncaught.length).toBeGreaterThan(0);
    expect(unhandled.length).toBeGreaterThan(0);

    const uncaughtHandler = uncaught[uncaught.length - 1] as (
      err: Error,
    ) => void;
    const unhandledHandler = unhandled[unhandled.length - 1] as (
      reason: unknown,
    ) => void;
    uncaughtHandler(new Error('boom'));
    unhandledHandler(new Error('reject'));

    expect(fatalSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Uncaught exception',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Unhandled rejection',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    cleanup();
    fatalSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
