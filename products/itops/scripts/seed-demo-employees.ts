import { and, eq, inArray, like, or } from "drizzle-orm";

import { loadEnvFiles } from "@itops/config";
import {
  ACCESS_GRANT_STATUS,
  ACCESS_RESOURCE_KEY,
  accessGrants,
  accessRequests,
  accessResources,
  accessTasks,
  approvals,
  AUDIT_ACTOR,
  auditEvents,
  createDb,
  EMPLOYEE_STATUS,
  employees,
  offboardingIntakeApprovals,
  offboardingIntakes,
  offboardingRevokeItems,
  onboardingIntakeApprovals,
  onboardingIntakes,
  ROLE_KEY,
  roles,
  slackSourceMessages,
  SYSTEM_KEY,
  systems
} from "@itops/db";

type DemoEmployee = {
  fullName: string;
  workEmail: string;
  personalEmail: string;
  contactNo: string;
  designation: string;
  department: string;
  startDate: string;
};

const currentEmployeeNames = [
  "Aayush Bajaj",
  "Archita Srivastava",
  "Abdus Samad",
  "Ahmad Zafar Zaidi",
  "Arhan Ali Khan",
  "Arihant Jain",
  "Bommakanti Abhilash",
  "Alekhya Gopu",
  "Amber Pandey",
  "Ameer Khan",
  "Aman Singh",
  "Anil Chauhan",
  "Aryan Thakur",
  "Ashirwad Pramod Shetye",
  "Ayush Gupta",
  "Baskar Harshine",
  "Bokka Pardha Sarathi Reddy",
  "Bommani Bharath",
  "Bhargav Reddy",
  "C Akshay",
  "Chandradeep Kumar",
  "T R Charitha",
  "Chenna Mithin Kumar",
  "Chetan Singh",
  "Gowrishankar K",
  "Geetika Agarwal",
  "Haris Rahman",
  "Hemant Agrawal",
  "Himanshu Kumar",
  "Jayanth Ponnada",
  "Kalagotla Suhas",
  "Karthick Kumar",
  "Kartik Bansal",
  "Kashish Chugh",
  "Madisetty Krishna",
  "Bhogapurapu Krishnaveni",
  "Korra Manjula",
  "Kirti Padhi",
  "Kommula Lakshmi Sai Sravanthi",
  "Mahtv Bansal",
  "Manda Neel Gagan",
  "Mandumula Nandeshwar Reddy",
  "Manish Mangla",
  "K Mary Das",
  "Mayankana Gupta",
  "MK. Revan",
  "Mounica E",
  "Mohd Farhan Ansari",
  "Naveen V",
  "Nanda Kishore SM",
  "Bandaru Neeraj",
  "Peraka Dola Naga Syam Kumar",
  "Pilli RamDurgaPrasad",
  "Nannapaneni Prameela",
  "Kalidindi Pramod Varma",
  "Prashant Anand",
  "Pranali Rajbhoj Sawale",
  "Rahul Anand",
  "Rahul Balasaheb Kandhare",
  "Rahul Balu Khadse",
  "Ranjana Singh",
  "Raj Karmakar",
  "Ravi Kiran Vemula",
  "Rudraksh Chandel",
  "Guntupalli Sai Charan",
  "Perumalla Venkata Shiva Rama Sai Kumar",
  "Sakaram Ruchitha",
  "Shalini Tripathi",
  "Shivom Srivastava",
  "Shorya Sharma",
  "Shuaib Ahmed",
  "SG Amulya",
  "Sri Harsha S",
  "Sriniketh Reddy",
  "Sriram M Pant",
  "Lagaputi Srinivasrao",
  "Stuti Jain",
  "Varigala Suvarna",
  "Suraj Ranganath Bangade",
  "Taavish Thaman",
  "Tejas Dattatray Ligade",
  "Tithi Das",
  "Tushar Mavi",
  "Kottu Rama Naga Vishnu Kumar",
  "Vaishnavi Tadaka",
  "Vishnupriya A",
  "Vedant Sasane",
  "Shivarathri Vishwa Anuj",
  "Shaik Imran",
  "Yeggoni Jayanth Pushparaju"
] as const;

const designationRotation = [
  { designation: "Backend Engineer", department: "Engineering" },
  { designation: "Frontend Engineer", department: "Engineering" },
  { designation: "Full Stack Engineer", department: "Engineering" },
  { designation: "QA Engineer", department: "Quality" },
  { designation: "DevOps Engineer", department: "Platform" },
  { designation: "Product Manager", department: "Product" },
  { designation: "UI/UX Designer", department: "Design" }
] as const;

const demoEmployees = buildDemoEmployees(currentEmployeeNames);

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  loadEnvFiles();

  const databaseUrl = process.env.ITOPS_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("ITOPS_DATABASE_URL is required to seed demo employees.");
  }

  const { db, pool } = createDb(databaseUrl);
  const now = new Date();

  try {
    const catalog = await loadRequiredCatalog(db);
    const deleted = await deleteExistingDemoEmployees({ db });
    const seeded = [];

    for (const demoEmployee of demoEmployees) {
      const [employee] = await db
        .insert(employees)
        .values({
          fullName: demoEmployee.fullName,
          workEmail: demoEmployee.workEmail,
          personalEmail: demoEmployee.personalEmail,
          contactNo: demoEmployee.contactNo,
          employmentType: "fte",
          designation: demoEmployee.designation,
          department: demoEmployee.department,
          status: EMPLOYEE_STATUS.active,
          startDate: demoEmployee.startDate,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: employees.workEmail,
          set: {
            fullName: demoEmployee.fullName,
            personalEmail: demoEmployee.personalEmail,
            contactNo: demoEmployee.contactNo,
            employmentType: "fte",
            designation: demoEmployee.designation,
            department: demoEmployee.department,
            status: EMPLOYEE_STATUS.active,
            startDate: demoEmployee.startDate,
            endDate: null,
            updatedAt: now
          }
        })
        .returning({
          id: employees.id,
          fullName: employees.fullName,
          workEmail: employees.workEmail
        });

      await upsertActiveGrant({
        db,
        employeeId: employee.id,
        systemId: catalog.googleWorkspace.systemId,
        resourceId: catalog.googleWorkspace.companyEmailResourceId,
        roleId: catalog.googleWorkspace.userRoleId,
        externalAccountId: `demo-google:${demoEmployee.workEmail}`,
        now
      });

      await upsertActiveGrant({
        db,
        employeeId: employee.id,
        systemId: catalog.slack.systemId,
        resourceId: catalog.slack.workspaceMembershipResourceId,
        roleId: catalog.slack.memberRoleId,
        externalAccountId: `demo-slack:${demoEmployee.workEmail}`,
        now
      });

      await db.insert(auditEvents).values({
        actorExternalUserId: AUDIT_ACTOR.system,
        eventType: "demo_employee.seeded",
        entityType: "employee",
        entityId: employee.id,
        metadataJson: {
          work_email: demoEmployee.workEmail,
          grants: ["google_workspace.company_email.user", "slack.workspace_membership.member"],
          note: "Demo seed data only; external systems were not mutated or linked."
        }
      });

      seeded.push({
        id: employee.id,
        fullName: employee.fullName,
        workEmail: employee.workEmail
      });
    }

    const archived = await archiveOldDemoEmployees({
      db,
      activeDemoWorkEmails: new Set(demoEmployees.map((employee) => employee.workEmail)),
      now
    });

    console.info(
      JSON.stringify({
        level: "info",
        message: "Seeded current demo employees with dummy Google Workspace and Slack grants.",
        count: seeded.length,
        deletedExistingDemoEmployees: deleted.length,
        archivedOldDemoEmployees: archived.length,
        employees: seeded,
        deleted,
        archived
      })
    );
  } finally {
    await pool.end();
  }
}

async function deleteExistingDemoEmployees(input: {
  db: ReturnType<typeof createDb>["db"];
}): Promise<Array<{ id: string; fullName: string; workEmail: string | null }>> {
  const demoGrantRows = await input.db
    .select({
      id: employees.id,
      fullName: employees.fullName,
      workEmail: employees.workEmail
    })
    .from(employees)
    .innerJoin(accessGrants, eq(accessGrants.employeeId, employees.id))
    .where(like(accessGrants.externalAccountId, "demo-%"));

  const demoEmployeesById = new Map<string, { id: string; fullName: string; workEmail: string | null }>();

  for (const row of demoGrantRows) {
    demoEmployeesById.set(row.id, row);
  }

  const deleted = Array.from(demoEmployeesById.values());

  for (const employee of deleted) {
    const employeeAccessRequests = await input.db
      .select({ id: accessRequests.id })
      .from(accessRequests)
      .where(eq(accessRequests.employeeId, employee.id));
    const accessRequestIds = employeeAccessRequests.map((request) => request.id);
    const employeeAccessTasks = accessRequestIds.length > 0
      ? await input.db
          .select({ id: accessTasks.id })
          .from(accessTasks)
          .where(inArray(accessTasks.accessRequestId, accessRequestIds))
      : [];
    const accessTaskIds = employeeAccessTasks.map((task) => task.id);
    const employeeAccessGrants = await input.db
      .select({ id: accessGrants.id })
      .from(accessGrants)
      .where(eq(accessGrants.employeeId, employee.id));
    const accessGrantIds = employeeAccessGrants.map((grant) => grant.id);
    const employeeOnboardingIntakes = await input.db
      .select({ id: onboardingIntakes.id, sourceMessageId: onboardingIntakes.sourceMessageId })
      .from(onboardingIntakes)
      .where(eq(onboardingIntakes.employeeId, employee.id));
    const onboardingIntakeIds = employeeOnboardingIntakes.map((intake) => intake.id);
    const sourceMessageIds = employeeOnboardingIntakes.map((intake) => intake.sourceMessageId);
    const employeeOffboardingIntakes = await input.db
      .select({ id: offboardingIntakes.id })
      .from(offboardingIntakes)
      .where(eq(offboardingIntakes.employeeId, employee.id));
    const offboardingIntakeIds = employeeOffboardingIntakes.map((intake) => intake.id);

    const entityIds = [
      employee.id,
      ...accessRequestIds,
      ...accessTaskIds,
      ...accessGrantIds,
      ...onboardingIntakeIds,
      ...sourceMessageIds,
      ...offboardingIntakeIds
    ];

    if (entityIds.length > 0) {
      await input.db.delete(auditEvents).where(inArray(auditEvents.entityId, entityIds));
    }

    const revokeItemConditions = [
      offboardingIntakeIds.length > 0
        ? inArray(offboardingRevokeItems.offboardingIntakeId, offboardingIntakeIds)
        : undefined,
      accessRequestIds.length > 0 ? inArray(offboardingRevokeItems.accessRequestId, accessRequestIds) : undefined,
      accessTaskIds.length > 0 ? inArray(offboardingRevokeItems.accessTaskId, accessTaskIds) : undefined,
      accessGrantIds.length > 0 ? inArray(offboardingRevokeItems.accessGrantId, accessGrantIds) : undefined
    ].filter((condition) => condition !== undefined);

    if (revokeItemConditions.length > 0) {
      await input.db.delete(offboardingRevokeItems).where(or(...revokeItemConditions));
    }

    if (offboardingIntakeIds.length > 0) {
      await input.db
        .delete(offboardingIntakeApprovals)
        .where(inArray(offboardingIntakeApprovals.offboardingIntakeId, offboardingIntakeIds));
      await input.db.delete(offboardingIntakes).where(inArray(offboardingIntakes.id, offboardingIntakeIds));
    }

    if (onboardingIntakeIds.length > 0) {
      await input.db
        .delete(onboardingIntakeApprovals)
        .where(inArray(onboardingIntakeApprovals.onboardingIntakeId, onboardingIntakeIds));
      await input.db.delete(onboardingIntakes).where(inArray(onboardingIntakes.id, onboardingIntakeIds));
    }

    if (accessRequestIds.length > 0) {
      await input.db.delete(approvals).where(inArray(approvals.accessRequestId, accessRequestIds));
    }

    if (accessTaskIds.length > 0) {
      await input.db.delete(accessTasks).where(inArray(accessTasks.id, accessTaskIds));
    }

    if (accessGrantIds.length > 0) {
      await input.db.delete(accessGrants).where(inArray(accessGrants.id, accessGrantIds));
    }

    if (accessRequestIds.length > 0) {
      await input.db.delete(accessRequests).where(inArray(accessRequests.id, accessRequestIds));
    }

    if (sourceMessageIds.length > 0) {
      await input.db.delete(slackSourceMessages).where(inArray(slackSourceMessages.id, sourceMessageIds));
    }

    await input.db.delete(employees).where(eq(employees.id, employee.id));
  }

  return deleted;
}

async function loadRequiredCatalog(db: ReturnType<typeof createDb>["db"]) {
  const allSystems = await db.select().from(systems);
  const googleWorkspaceSystem = allSystems.find((system) => system.key === SYSTEM_KEY.googleWorkspace);
  const slackSystem = allSystems.find((system) => system.key === SYSTEM_KEY.slack);

  if (!googleWorkspaceSystem || !slackSystem) {
    throw new Error("Google Workspace and Slack catalog systems are required. Run catalog seed scripts first.");
  }

  const googleResources = await db
    .select()
    .from(accessResources)
    .where(eq(accessResources.systemId, googleWorkspaceSystem.id));
  const slackResources = await db.select().from(accessResources).where(eq(accessResources.systemId, slackSystem.id));
  const googleRoles = await db.select().from(roles).where(eq(roles.systemId, googleWorkspaceSystem.id));
  const slackRoles = await db.select().from(roles).where(eq(roles.systemId, slackSystem.id));

  const companyEmailResource = googleResources.find((resource) => resource.key === ACCESS_RESOURCE_KEY.companyEmail);
  const workspaceMembershipResource = slackResources.find(
    (resource) => resource.key === ACCESS_RESOURCE_KEY.workspaceMembership
  );
  const userRole = googleRoles.find((role) => role.key === ROLE_KEY.user);
  const memberRole = slackRoles.find((role) => role.key === ROLE_KEY.member);

  if (!companyEmailResource || !workspaceMembershipResource || !userRole || !memberRole) {
    throw new Error("Google Workspace company email and Slack workspace membership catalog entries are required.");
  }

  return {
    googleWorkspace: {
      systemId: googleWorkspaceSystem.id,
      companyEmailResourceId: companyEmailResource.id,
      userRoleId: userRole.id
    },
    slack: {
      systemId: slackSystem.id,
      workspaceMembershipResourceId: workspaceMembershipResource.id,
      memberRoleId: memberRole.id
    }
  };
}

async function upsertActiveGrant(input: {
  db: ReturnType<typeof createDb>["db"];
  employeeId: string;
  systemId: string;
  resourceId: string;
  roleId: string;
  externalAccountId: string;
  now: Date;
}): Promise<void> {
  await input.db
    .insert(accessGrants)
    .values({
      employeeId: input.employeeId,
      systemId: input.systemId,
      resourceId: input.resourceId,
      roleId: input.roleId,
      status: ACCESS_GRANT_STATUS.active,
      externalAccountId: input.externalAccountId,
      grantedAt: input.now,
      updatedAt: input.now
    })
    .onConflictDoUpdate({
      target: [accessGrants.employeeId, accessGrants.systemId, accessGrants.resourceId, accessGrants.roleId],
      set: {
        status: ACCESS_GRANT_STATUS.active,
        externalAccountId: input.externalAccountId,
        grantedAt: input.now,
        revokedAt: null,
        updatedAt: input.now
      }
    });
}

async function archiveOldDemoEmployees(input: {
  db: ReturnType<typeof createDb>["db"];
  activeDemoWorkEmails: Set<string>;
  now: Date;
}): Promise<Array<{ id: string; fullName: string; workEmail: string | null }>> {
  const demoGrantRows = await input.db
    .select({
      id: employees.id,
      fullName: employees.fullName,
      workEmail: employees.workEmail
    })
    .from(employees)
    .innerJoin(accessGrants, eq(accessGrants.employeeId, employees.id))
    .where(like(accessGrants.externalAccountId, "demo-google:%"));

  const uniqueEmployees = new Map<string, { id: string; fullName: string; workEmail: string | null }>();

  for (const row of demoGrantRows) {
    if (!row.workEmail || input.activeDemoWorkEmails.has(row.workEmail)) {
      continue;
    }

    uniqueEmployees.set(row.id, row);
  }

  const archived = Array.from(uniqueEmployees.values());

  for (const employee of archived) {
    await input.db
      .update(employees)
      .set({
        status: EMPLOYEE_STATUS.offboarded,
        endDate: input.now.toISOString().slice(0, 10),
        updatedAt: input.now
      })
      .where(eq(employees.id, employee.id));

    await input.db
      .update(accessGrants)
      .set({
        status: ACCESS_GRANT_STATUS.revoked,
        revokedAt: input.now,
        updatedAt: input.now
      })
      .where(and(eq(accessGrants.employeeId, employee.id), like(accessGrants.externalAccountId, "demo-%")));
  }

  return archived;
}

function buildDemoEmployees(names: readonly string[]): DemoEmployee[] {
  const usedSlugs = new Map<string, number>();

  return names.map((name, index) => {
    const slug = uniqueSlug(slugifyName(name), usedSlugs);
    const demoCode = demoCodeForName(name, index);
    const profile = designationRotation[index % designationRotation.length];

    return {
      fullName: normalizeName(name),
      workEmail: `${slug}.demo.${demoCode}@caw.tech`,
      personalEmail: `${slug}.demo.${demoCode}@example.com`,
      contactNo: `+91 90000 ${String(index + 1).padStart(5, "0")}`,
      designation: profile.designation,
      department: profile.department,
      startDate: startDateForIndex(index)
    };
  });
}

function normalizeName(name: string): string {
  return name.replace(/\s+/gu, " ").trim();
}

function slugifyName(name: string): string {
  return normalizeName(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, "")
    .split(/\s+/gu)
    .filter(Boolean)
    .join(".");
}

function uniqueSlug(baseSlug: string, usedSlugs: Map<string, number>): string {
  const seenCount = usedSlugs.get(baseSlug) ?? 0;
  usedSlugs.set(baseSlug, seenCount + 1);

  if (seenCount === 0) {
    return baseSlug;
  }

  return `${baseSlug}.${seenCount + 1}`;
}

function demoCodeForName(name: string, index: number): string {
  let hash = 2166136261;
  const input = `${normalizeName(name)}:${index}`;

  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36).padStart(6, "0").slice(0, 6);
}

function startDateForIndex(index: number): string {
  const month = (index % 12) + 1;
  const day = (index % 20) + 1;

  return `2025-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
