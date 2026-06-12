import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

// Adapter-private session projection for live (interactive) DeepAgents turns.
// Durable continuity stays Gantry-owned (AgentSession); this file is the
// LangChain analogue of the Claude per-run session files: it persists the prior
// turn's plain message history (role + text) as a JSON artifact keyed by a
// generated session id, under the adapter-owned runtime config dir. On resume
// the host passes the session id back; we load the prior messages and prepend
// them to the new HumanMessage (a full file checkpointer is overkill for a
// tool-less v1 runner, and interrupts/HITL are a later packet). Scheduled jobs
// are ephemeral and never touch this store. A missing or corrupt file throws
// MISSING_DEEPAGENTS_SESSION so the host expires the stale session and retries
// fresh via the adapter's isMissingProviderSessionError classifier.

export const MISSING_DEEPAGENTS_SESSION_MARKER =
  'No DeepAgents session found with session ID';

export interface PersistedTurnMessage {
  role: 'human' | 'ai';
  text: string;
}

interface PersistedSession {
  version: 1;
  messages: PersistedTurnMessage[];
}

export class DeepAgentSessionStore {
  constructor(private readonly sessionsDir: string) {}

  private sessionPath(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new Error(
        `${MISSING_DEEPAGENTS_SESSION_MARKER}: ${sessionId} (invalid id)`,
      );
    }
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  newSessionId(): string {
    return randomUUID();
  }

  load(sessionId: string): PersistedTurnMessage[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.sessionPath(sessionId), 'utf-8');
    } catch {
      throw new Error(`${MISSING_DEEPAGENTS_SESSION_MARKER}: ${sessionId}`);
    }
    let parsed: PersistedSession;
    try {
      parsed = JSON.parse(raw) as PersistedSession;
    } catch {
      throw new Error(
        `${MISSING_DEEPAGENTS_SESSION_MARKER}: ${sessionId} (corrupt)`,
      );
    }
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.messages) ||
      parsed.messages.some(
        (message) =>
          (message.role !== 'human' && message.role !== 'ai') ||
          typeof message.text !== 'string',
      )
    ) {
      throw new Error(
        `${MISSING_DEEPAGENTS_SESSION_MARKER}: ${sessionId} (corrupt)`,
      );
    }
    return parsed.messages;
  }

  save(sessionId: string, messages: PersistedTurnMessage[]): void {
    fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    const finalPath = this.sessionPath(sessionId);
    // Atomic write: a bare writeFileSync truncated by a kill mid-write leaves a
    // partial file, and load() then throws -> the host stale-session retry
    // discards the conversation. Write a sibling .tmp then rename (same-fs
    // atomic) so load() only ever sees a complete file or the prior good one.
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({ version: 1, messages } satisfies PersistedSession),
      { mode: 0o600 },
    );
    fs.renameSync(tmpPath, finalPath);
  }
}

export function isMissingDeepAgentSessionError(
  error: string | undefined,
): boolean {
  return new RegExp(MISSING_DEEPAGENTS_SESSION_MARKER, 'i').test(error ?? '');
}
