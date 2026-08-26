import { describe, expect, it } from 'vitest';

import { CustomRoleService } from '@core/application/agents/custom-role-service.js';
import type { CustomRole } from '@core/domain/agent/agent.js';
import type { CustomRoleRepository } from '@core/domain/ports/repositories.js';

describe('CustomRoleService', () => {
  it('preserves an agent role snapshot when its source template changes or is deleted', async () => {
    const roles = new InMemoryCustomRoles();
    const service = new CustomRoleService(
      roles,
      () => 'writer',
      () => '2026-08-26T00:00:00.000Z' as never,
    );
    const role = await service.create({
      appId: 'app:one' as never,
      name: 'Writer',
      prompt: 'Write with care.',
    });
    const snapshot = service.snapshot(role);

    await service.update({
      appId: 'app:one' as never,
      id: role.id,
      name: 'Changed writer',
      prompt: 'Different prompt.',
    });
    await service.delete({ appId: 'app:one' as never, id: role.id });

    expect(snapshot).toEqual({
      displayName: 'Writer',
      prompt: 'Write with care.',
      sourceRoleId: role.id,
    });
    await expect(roles.getCustomRole(role.id)).resolves.toBeNull();
  });
});

class InMemoryCustomRoles implements CustomRoleRepository {
  private readonly roles = new Map<string, CustomRole>();

  async getCustomRole(id: CustomRole['id']): Promise<CustomRole | null> {
    return this.roles.get(id) ?? null;
  }

  async listCustomRoles(appId: CustomRole['appId']): Promise<CustomRole[]> {
    return [...this.roles.values()].filter((role) => role.appId === appId);
  }

  async saveCustomRole(role: CustomRole): Promise<void> {
    this.roles.set(role.id, role);
  }

  async deleteCustomRole(input: {
    appId: CustomRole['appId'];
    id: CustomRole['id'];
  }): Promise<void> {
    const role = this.roles.get(input.id);
    if (role?.appId === input.appId) this.roles.delete(input.id);
  }
}
