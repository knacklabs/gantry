import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnvFiles } from "./load-env.js";

describe("loadEnvFiles", () => {
  const originalEnv = { ...process.env };
  const tempDirectories: string[] = [];

  afterEach(() => {
    process.env = { ...originalEnv };

    for (const tempDirectory of tempDirectories.splice(0)) {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("loads .env files from parent directories without overriding existing env vars", () => {
    const repoDirectory = mkdtempSync(join(tmpdir(), "itops-env-"));
    const appDirectory = join(repoDirectory, "apps", "itops-api");
    tempDirectories.push(repoDirectory);

    mkdirSync(appDirectory, { recursive: true });
    writeFileSync(
      join(repoDirectory, ".env"),
      [
        "ITOPS_DATABASE_URL=postgresql://repo",
        "ITOPS_API_PORT=4000",
        "QUOTED_VALUE=\"quoted\"",
        "# ignored"
      ].join("\n")
    );
    writeFileSync(join(appDirectory, ".env"), "ITOPS_API_PORT=4100\nAPP_ONLY=true\n");

    process.env.ITOPS_DATABASE_URL = "postgresql://existing";
    delete process.env.ITOPS_API_PORT;
    delete process.env.QUOTED_VALUE;
    delete process.env.APP_ONLY;

    loadEnvFiles(appDirectory);

    expect(process.env.ITOPS_DATABASE_URL).toBe("postgresql://existing");
    expect(process.env.ITOPS_API_PORT).toBe("4100");
    expect(process.env.QUOTED_VALUE).toBe("quoted");
    expect(process.env.APP_ONLY).toBe("true");
  });
});
