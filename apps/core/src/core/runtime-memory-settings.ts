import fs from 'fs';
import path from 'path';

export interface RuntimeMemorySettingsSnapshot {
  enabled?: boolean;
  provider?: string;
  sqlitePath?: string;
  qmdRoot?: string;
  embeddingsEnabled?: boolean;
  embeddingProvider?: string;
  embeddingModel?: string;
  dreamingEnabled?: boolean;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(raw: string): string | boolean {
  const value = stripQuotes(raw);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function isSectionHeader(line: string, name: string, indent: number): boolean {
  return line === `${' '.repeat(indent)}${name}:`;
}

function readIndentedBlock(
  lines: string[],
  start: number,
  indent: number,
): string[] {
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const currentIndent = line.match(/^ */)?.[0].length || 0;
    if (currentIndent <= indent) break;
    out.push(line);
  }
  return out;
}

function readKeyValue(
  block: string[],
  key: string,
  indent: number,
): string | boolean | undefined {
  const prefix = `${' '.repeat(indent)}${key}:`;
  for (const line of block) {
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length).trim();
    if (!rest) return undefined;
    return parseScalar(rest);
  }
  return undefined;
}

function readNestedBlock(
  block: string[],
  key: string,
  indent: number,
): string[] {
  const header = `${' '.repeat(indent)}${key}:`;
  const index = block.findIndex((line) => line === header);
  if (index < 0) return [];
  return readIndentedBlock(block, index, indent);
}

function stringValue(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanValue(
  value: string | boolean | undefined,
): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function readRuntimeMemorySettingsSnapshot(
  runtimeHome: string,
): RuntimeMemorySettingsSnapshot {
  const settingsPath = path.join(runtimeHome, 'settings.yaml');
  if (!fs.existsSync(settingsPath)) return {};

  const lines = fs.readFileSync(settingsPath, 'utf-8').split(/\r?\n/);
  const memoryIndex = lines.findIndex((line) =>
    isSectionHeader(line, 'memory', 0),
  );
  if (memoryIndex < 0) return {};

  const memoryBlock = readIndentedBlock(lines, memoryIndex, 0);
  const embeddingsBlock = readNestedBlock(memoryBlock, 'embeddings', 2);
  const dreamingBlock = readNestedBlock(memoryBlock, 'dreaming', 2);

  return {
    enabled: booleanValue(readKeyValue(memoryBlock, 'enabled', 2)),
    provider: stringValue(readKeyValue(memoryBlock, 'provider', 2)),
    sqlitePath: stringValue(readKeyValue(memoryBlock, 'sqlite_path', 2)),
    qmdRoot: stringValue(readKeyValue(memoryBlock, 'qmd_root', 2)),
    embeddingsEnabled: booleanValue(
      readKeyValue(embeddingsBlock, 'enabled', 4),
    ),
    embeddingProvider: stringValue(
      readKeyValue(embeddingsBlock, 'provider', 4),
    ),
    embeddingModel: stringValue(readKeyValue(embeddingsBlock, 'model', 4)),
    dreamingEnabled: booleanValue(readKeyValue(dreamingBlock, 'enabled', 4)),
  };
}
