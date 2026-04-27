import { makeSessionScopeKey } from '../../../../domain/repositories/ops-repo.js';
import type { PostgresCanonicalSessionRepository } from '../repositories/canonical-session-repository.postgres.js';

export class CanonicalSessionOpsService {
  constructor(
    private readonly repository: PostgresCanonicalSessionRepository,
  ) {}

  async getSession(
    groupFolder: string,
    threadId?: string | null,
  ): Promise<string | undefined> {
    return this.repository.getProviderSessionId(
      makeSessionScopeKey(groupFolder, threadId),
    );
  }

  async setSession(
    groupFolder: string,
    sessionId: string,
    threadId?: string | null,
  ): Promise<void> {
    await this.repository.setProviderSession({
      groupFolder,
      sessionId,
      scopeKey: makeSessionScopeKey(groupFolder, threadId),
    });
  }

  async deleteSession(
    groupFolder: string,
    threadId?: string | null,
  ): Promise<void> {
    await this.repository.deleteScope(
      makeSessionScopeKey(groupFolder, threadId),
    );
  }

  async deleteSessionsByGroupFolder(groupFolder: string): Promise<void> {
    await this.repository.deleteGroupFolder(groupFolder);
  }

  async getAllSessions(): Promise<Record<string, string>> {
    const rows = await this.repository.listSessions();
    return Object.fromEntries(rows.map((row) => [row.scopeKey, row.sessionId]));
  }
}
