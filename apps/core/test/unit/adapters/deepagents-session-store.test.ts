import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DeepAgentSessionStore,
  isMissingDeepAgentSessionError,
  MISSING_DEEPAGENTS_SESSION_MARKER,
} from '@core/adapters/llm/deepagents-langchain/runner/session-store.js';

const roots: string[] = [];
function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepagents-sessions-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('DeepAgentSessionStore', () => {
  it('round-trips the prior-turn message history', () => {
    const store = new DeepAgentSessionStore(makeDir());
    const sessionId = store.newSessionId();
    store.save(sessionId, [
      { role: 'human', text: 'hi' },
      { role: 'ai', text: 'hello' },
    ]);
    expect(store.load(sessionId)).toEqual([
      { role: 'human', text: 'hi' },
      { role: 'ai', text: 'hello' },
    ]);
  });

  it('throws a missing-session error for an unknown session id', () => {
    const store = new DeepAgentSessionStore(makeDir());
    expect(() => store.load('does-not-exist')).toThrow(
      MISSING_DEEPAGENTS_SESSION_MARKER,
    );
  });

  it('throws a missing-session error for corrupt session data', () => {
    const dir = makeDir();
    const store = new DeepAgentSessionStore(dir);
    fs.writeFileSync(path.join(dir, 'corrupt.json'), '{not json');
    expect(() => store.load('corrupt')).toThrow('corrupt');
  });

  it('classifies missing-session errors for host stale-session retry', () => {
    expect(
      isMissingDeepAgentSessionError(
        `${MISSING_DEEPAGENTS_SESSION_MARKER}: abc`,
      ),
    ).toBe(true);
    expect(isMissingDeepAgentSessionError('some upstream error')).toBe(false);
  });

  it('writes atomically via a .tmp sibling + rename and leaves no .tmp residue (R6)', () => {
    const dir = makeDir();
    const store = new DeepAgentSessionStore(dir);
    const sessionId = store.newSessionId();
    store.save(sessionId, [{ role: 'human', text: 'hi' }]);
    // The final file is complete and no partial .tmp file is left behind.
    const entries = fs.readdirSync(dir);
    expect(entries).toContain(`${sessionId}.json`);
    expect(entries.some((name) => name.endsWith('.tmp'))).toBe(false);
    expect(store.load(sessionId)).toEqual([{ role: 'human', text: 'hi' }]);
  });

  it('a truncated/garbage .tmp does not corrupt the live session file (R6)', () => {
    const dir = makeDir();
    const store = new DeepAgentSessionStore(dir);
    const sessionId = store.newSessionId();
    // Simulate a prior good write.
    store.save(sessionId, [{ role: 'ai', text: 'good' }]);
    // Simulate a kill mid-write leaving a partial tmp file (the rename never ran).
    fs.writeFileSync(path.join(dir, `${sessionId}.json.tmp`), '{not json');
    // The live file is still the prior good content; load() succeeds.
    expect(store.load(sessionId)).toEqual([{ role: 'ai', text: 'good' }]);
    // A subsequent save reuses the same .tmp path then renames it onto the live
    // file, so the stale garbage tmp is overwritten and renamed away — no .tmp
    // residue remains and the live file holds the newest content.
    store.save(sessionId, [{ role: 'ai', text: 'newer' }]);
    expect(store.load(sessionId)).toEqual([{ role: 'ai', text: 'newer' }]);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual(
      [],
    );
  });
});
