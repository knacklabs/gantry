import { loadEnvFiles } from "@itops/config";
import { createDb } from "../packages/db/src/client.js";
import { designationCatalog } from "../packages/db/src/schema/index.js";

const fteDesignations = [
  "Backend Engineer",
  "Frontend Engineer",
  "Full Stack Engineer",
  "QA Engineer",
  "DevOps Engineer",
  "Product Manager",
  "UI/UX Designer"
] as const;

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  loadEnvFiles();

  const databaseUrl = process.env.ITOPS_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("ITOPS_DATABASE_URL is required to seed designation catalog data.");
  }

  const { db, pool } = createDb(databaseUrl);
  const now = new Date();

  try {
    const seededDesignations = await db
      .insert(designationCatalog)
      .values(
        fteDesignations.map((name) => ({
          name,
          employmentType: "fte",
          active: true
        }))
      )
      .onConflictDoUpdate({
        target: [designationCatalog.employmentType, designationCatalog.name],
        set: {
          active: true,
          updatedAt: now
        }
      })
      .returning({
        id: designationCatalog.id,
        name: designationCatalog.name,
        employmentType: designationCatalog.employmentType
      });

    console.info(
      JSON.stringify({
        level: "info",
        message: "Seeded designation catalog data.",
        count: seededDesignations.length,
        designations: seededDesignations.map((designation) => ({
          id: designation.id,
          name: designation.name,
          employmentType: designation.employmentType
        }))
      })
    );
  } finally {
    await pool.end();
  }
}
