import type {
  AgentRoleSnapshot,
  CustomRole,
  CustomRoleId,
} from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { CustomRoleRepository } from '../../domain/ports/repositories.js';
import { nowIso } from '../../shared/time/datetime.js';

export class CustomRoleService {
  constructor(
    private readonly roles: CustomRoleRepository,
    private readonly createId = () => globalThis.crypto.randomUUID(),
    private readonly now = nowIso,
  ) {}

  async create(input: {
    appId: AppId;
    name: string;
    prompt: string;
    sourceRoleId?: string;
  }): Promise<CustomRole> {
    const now = this.now();
    const role: CustomRole = {
      id: `custom-role:${this.createId()}` as CustomRoleId,
      appId: input.appId,
      ...validateRoleContent(input),
      createdAt: now,
      updatedAt: now,
    };
    await this.roles.saveCustomRole(role);
    return role;
  }

  async update(input: {
    appId: AppId;
    id: CustomRoleId;
    name: string;
    prompt: string;
    sourceRoleId?: string;
  }): Promise<CustomRole> {
    const existing = await this.requireInApp(input.appId, input.id);
    const role: CustomRole = {
      ...existing,
      ...validateRoleContent(input),
      updatedAt: this.now(),
    };
    await this.roles.saveCustomRole(role);
    return role;
  }

  async delete(input: { appId: AppId; id: CustomRoleId }): Promise<void> {
    await this.requireInApp(input.appId, input.id);
    await this.roles.deleteCustomRole(input);
  }

  snapshot(role: CustomRole): AgentRoleSnapshot {
    return {
      displayName: role.name,
      prompt: role.prompt,
      sourceRoleId: role.id,
    };
  }

  private async requireInApp(
    appId: AppId,
    id: CustomRoleId,
  ): Promise<CustomRole> {
    const role = await this.roles.getCustomRole(id);
    if (!role || role.appId !== appId)
      throw new Error(`Custom role not found: ${id}`);
    return role;
  }
}

function validateRoleContent(input: {
  name: string;
  prompt: string;
  sourceRoleId?: string;
}): Pick<CustomRole, 'name' | 'prompt' | 'sourceRoleId'> {
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  if (!name || !prompt)
    throw new Error('Custom role name and prompt are required');
  return {
    name,
    prompt,
    sourceRoleId: input.sourceRoleId?.trim() || undefined,
  };
}
