import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function loadEnvFiles(startDirectory = process.cwd()): void {
  const protectedKeys = new Set(Object.keys(process.env));

  for (const envPath of findEnvFiles(startDirectory)) {
    loadEnvFile(envPath, protectedKeys);
  }
}

function findEnvFiles(startDirectory: string): string[] {
  const envFiles: string[] = [];
  let currentDirectory = resolve(startDirectory);

  while (true) {
    const envPath = join(currentDirectory, ".env");

    if (existsSync(envPath)) {
      envFiles.unshift(envPath);
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return envFiles;
    }

    currentDirectory = parentDirectory;
  }
}

function loadEnvFile(envPath: string, protectedKeys: Set<string>): void {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#") || !trimmedLine.includes("=")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");
    const key = trimmedLine.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(trimmedLine.slice(separatorIndex + 1).trim());

    if (!protectedKeys.has(key)) {
      process.env[key] = value;
    }
  }
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}
