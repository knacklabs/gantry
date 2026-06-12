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
});
