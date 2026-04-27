import type { RegisteredGroup } from '../../../../domain/repositories/domain-types.js';
import {
  bindingRowToGroup,
  type PostgresCanonicalBindingRepository,
} from '../repositories/canonical-binding-repository.postgres.js';

export class CanonicalBindingOpsService {
  constructor(
    private readonly repository: PostgresCanonicalBindingRepository,
  ) {}

  async getRegisteredGroup(jid: string): Promise<RegisteredGroup | undefined> {
    return (await this.getAllRegisteredGroups())[jid];
  }

  async setRegisteredGroup(jid: string, group: RegisteredGroup): Promise<void> {
    await this.repository.saveRegisteredGroup(jid, group);
  }

  async deleteRegisteredGroup(jid: string): Promise<void> {
    await this.repository.deleteRegisteredGroup(jid);
  }

  async getAllRegisteredGroups(): Promise<Record<string, RegisteredGroup>> {
    const rows = await this.repository.listRegisteredGroups();
    const result: Record<string, RegisteredGroup> = {};
    for (const row of rows) {
      const binding = bindingRowToGroup(row);
      if (binding) result[binding.jid] = binding.group;
    }
    return result;
  }
}
