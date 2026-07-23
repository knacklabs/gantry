import { loadEnvFiles } from "@itops/config";
import {
  ACCESS_RESOURCE_KEY,
  accessResources,
  createDb,
  ROLE_KEY,
  ROLE_RISK_LEVEL,
  roles,
  SYSTEM_KEY,
  SYSTEM_STATUS,
  systems
} from "@itops/db";

const googleWorkspaceSystem = {
  key: SYSTEM_KEY.googleWorkspace,
  name: "Google Workspace",
  status: SYSTEM_STATUS.active
};

const companyEmailResource = {
  key: ACCESS_RESOURCE_KEY.companyEmail,
  name: "Company Email Account",
  resourceType: "account"
};

const userRole = {
  key: ROLE_KEY.user,
  name: "User",
  riskLevel: ROLE_RISK_LEVEL.medium
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  loadEnvFiles();

  const databaseUrl = process.env.ITOPS_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("ITOPS_DATABASE_URL is required to seed Google Workspace catalog data.");
  }

  const { db, pool } = createDb(databaseUrl);

  try {
    const [system] = await db
      .insert(systems)
      .values(googleWorkspaceSystem)
      .onConflictDoUpdate({
        target: systems.key,
        set: {
          name: googleWorkspaceSystem.name,
          status: googleWorkspaceSystem.status,
          updatedAt: new Date()
        }
      })
      .returning();

    const [resource] = await db
      .insert(accessResources)
      .values({
        systemId: system.id,
        ...companyEmailResource
      })
      .onConflictDoUpdate({
        target: [accessResources.systemId, accessResources.key],
        set: {
          name: companyEmailResource.name,
          resourceType: companyEmailResource.resourceType,
          updatedAt: new Date()
        }
      })
      .returning();

    const [role] = await db
      .insert(roles)
      .values({
        systemId: system.id,
        ...userRole
      })
      .onConflictDoUpdate({
        target: [roles.systemId, roles.key],
        set: {
          name: userRole.name,
          riskLevel: userRole.riskLevel,
          updatedAt: new Date()
        }
      })
      .returning();

    console.info(
      JSON.stringify({
        level: "info",
        message: "Seeded Google Workspace catalog data.",
        system: { id: system.id, key: system.key },
        resource: { id: resource.id, key: resource.key },
        role: { id: role.id, key: role.key }
      })
    );
  } finally {
    await pool.end();
  }
}
