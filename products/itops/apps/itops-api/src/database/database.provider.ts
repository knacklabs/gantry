import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { createDb, type DbClient } from "@itops/db";

@Injectable()
export class DatabaseProvider implements OnModuleDestroy {
  private readonly client = createDb(getDatabaseUrl());

  get db(): DbClient["db"] {
    return this.client.db;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.pool.end();
  }
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.ITOPS_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("ITOPS_DATABASE_URL is required for the IT Ops API database.");
  }

  return databaseUrl;
}
