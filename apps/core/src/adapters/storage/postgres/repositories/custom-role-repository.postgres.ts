import { and, asc, eq } from 'drizzle-orm';

import type {
  CustomRole,
  CustomRoleId,
} from '../../../../domain/agent/agent.js';
import type { CustomRoleRepository } from '../../../../domain/ports/repositories.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

export class PostgresCustomRoleRepository implements CustomRoleRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getCustomRole(id: CustomRoleId): Promise<CustomRole | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.customRolesPostgres)
      .where(eq(pgSchema.customRolesPostgres.id, id))
      .limit(1);
    return rows[0] ? this.fromRow(rows[0]) : null;
  }

  async listCustomRoles(appId: CustomRole['appId']): Promise<CustomRole[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.customRolesPostgres)
      .where(eq(pgSchema.customRolesPostgres.appId, appId))
      .orderBy(asc(pgSchema.customRolesPostgres.name));
    return rows.map((row) => this.fromRow(row));
  }

  async saveCustomRole(role: CustomRole): Promise<void> {
    await this.db
      .insert(pgSchema.customRolesPostgres)
      .values({ ...role, sourceRoleId: role.sourceRoleId ?? null })
      .onConflictDoUpdate({
        target: pgSchema.customRolesPostgres.id,
        set: {
          name: role.name,
          prompt: role.prompt,
          sourceRoleId: role.sourceRoleId ?? null,
          updatedAt: role.updatedAt,
        },
      });
  }

  async deleteCustomRole(input: {
    appId: CustomRole['appId'];
    id: CustomRoleId;
  }): Promise<void> {
    await this.db
      .delete(pgSchema.customRolesPostgres)
      .where(
        and(
          eq(pgSchema.customRolesPostgres.appId, input.appId),
          eq(pgSchema.customRolesPostgres.id, input.id),
        ),
      );
  }

  private fromRow(
    row: typeof pgSchema.customRolesPostgres.$inferSelect,
  ): CustomRole {
    return {
      id: row.id as CustomRoleId,
      appId: row.appId as CustomRole['appId'],
      name: row.name,
      prompt: row.prompt,
      sourceRoleId: row.sourceRoleId ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
