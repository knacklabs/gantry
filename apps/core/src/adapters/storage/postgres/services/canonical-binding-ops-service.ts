import type { ConversationRoute } from '../../../../domain/repositories/domain-types.js';
import {
  bindingRowToGroup,
  type PostgresCanonicalBindingRepository,
} from '../repositories/canonical-binding-repository.postgres.js';

export class CanonicalBindingOpsService {
  constructor(
    private readonly repository: PostgresCanonicalBindingRepository,
  ) {}

  async getConversationRoute(
    jid: string,
  ): Promise<ConversationRoute | undefined> {
    return (await this.getAllConversationRoutes())[jid];
  }

  async setConversationRoute(
    jid: string,
    group: ConversationRoute,
  ): Promise<void> {
    await this.repository.saveConversationRoute(jid, group);
  }

  async deleteConversationRoute(jid: string): Promise<void> {
    await this.repository.deleteConversationRoute(jid);
  }

  async getAllConversationRoutes(): Promise<Record<string, ConversationRoute>> {
    const rows = await this.repository.listConversationRoutes();
    const result: Record<string, ConversationRoute> = {};
    for (const row of rows) {
      const binding = bindingRowToGroup(row);
      if (binding) result[binding.jid] = binding.group;
    }
    return result;
  }
}
