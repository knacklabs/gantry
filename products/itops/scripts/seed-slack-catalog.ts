import { loadEnvFiles } from "@itops/config";
import { createDb } from "../packages/db/src/client.js";
import {
  ACCESS_RESOURCE_KEY,
  ACCESS_RESOURCE_TYPE,
  accessResources,
  ROLE_KEY,
  ROLE_RISK_LEVEL,
  roles,
  SYSTEM_KEY,
  SYSTEM_STATUS,
  systems
} from "../packages/db/src/schema/index.js";

const slackSystem = {
  key: SYSTEM_KEY.slack,
  name: "Slack",
  status: SYSTEM_STATUS.active
};

const slackRoles = [
  {
    key: ROLE_KEY.member,
    name: "Member",
    riskLevel: ROLE_RISK_LEVEL.low
  },
  {
    key: ROLE_KEY.channelManager,
    name: "Channel Manager",
    riskLevel: ROLE_RISK_LEVEL.medium
  }
] as const;

const slackResources = [
  {
    key: ACCESS_RESOURCE_KEY.workspaceMembership,
    name: "Slack Workspace Membership",
    resourceType: ACCESS_RESOURCE_TYPE.workspace
  }
] as const;

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  loadEnvFiles();

  const databaseUrl = process.env.ITOPS_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("ITOPS_DATABASE_URL is required to seed Slack catalog data.");
  }

  const { db, pool } = createDb(databaseUrl);
  const now = new Date();

  try {
    const [system] = await db
      .insert(systems)
      .values(slackSystem)
      .onConflictDoUpdate({
        target: systems.key,
        set: {
          name: slackSystem.name,
          status: slackSystem.status,
          updatedAt: now
        }
      })
      .returning();

    const seededRoles = [];
    const seededResources = [];

    for (const role of slackRoles) {
      const [seededRole] = await db
        .insert(roles)
        .values({
          systemId: system.id,
          ...role
        })
        .onConflictDoUpdate({
          target: [roles.systemId, roles.key],
          set: {
            name: role.name,
            riskLevel: role.riskLevel,
            updatedAt: now
          }
        })
        .returning({
          id: roles.id,
          key: roles.key,
          name: roles.name,
          riskLevel: roles.riskLevel
        });

      seededRoles.push(seededRole);
    }

    for (const resource of slackResources) {
      const [seededResource] = await db
        .insert(accessResources)
        .values({
          systemId: system.id,
          ...resource
        })
        .onConflictDoUpdate({
          target: [accessResources.systemId, accessResources.key],
          set: {
            name: resource.name,
            resourceType: resource.resourceType,
            updatedAt: now
          }
        })
        .returning({
          id: accessResources.id,
          key: accessResources.key,
          name: accessResources.name,
          resourceType: accessResources.resourceType
        });

      seededResources.push(seededResource);
    }

    console.info(
      JSON.stringify({
        level: "info",
        message: "Seeded Slack catalog data.",
        system: { id: system.id, key: system.key },
        roles: seededRoles.map((role) => ({
          id: role.id,
          key: role.key,
          name: role.name,
          riskLevel: role.riskLevel
        })),
        resources: seededResources.map((resource) => ({
          id: resource.id,
          key: resource.key,
          name: resource.name,
          resourceType: resource.resourceType
        }))
      })
    );
  } finally {
    await pool.end();
  }
}
