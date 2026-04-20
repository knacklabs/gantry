import fs from 'fs';
import path from 'path';

export interface RuntimeMemorySettingsSnapshot {
  enabled?: boolean;
  root?: string;
  embeddingsEnabled?: boolean;
  embeddingProvider?: string;
  embeddingModel?: string;
  dreamingEnabled?: boolean;
  llmExtractorModel?: string;
  llmDreamingModel?: string;
  llmConsolidationModel?: string;
  llmSessionSummaryModel?: string;
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

function stripInlineComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === '#' && !inSingle && !inDouble) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trimEnd();
}

function parseScalar(raw: string): string | boolean {
  const value = stripQuotes(stripInlineComment(raw).trim());
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
  keyPath: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`${keyPath} must be true or false`);
  }
  return typeof value === 'boolean' ? value : undefined;
}

function parseJsonSettingsSnapshot(raw: string): RuntimeMemorySettingsSnapshot {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('root must be a mapping');
  }
  const root = parsed as Record<string, unknown>;
  const memoryRaw = root.memory;
  if (memoryRaw === undefined) return {};
  if (
    typeof memoryRaw !== 'object' ||
    memoryRaw === null ||
    Array.isArray(memoryRaw)
  ) {
    throw new Error('memory must be a mapping');
  }

  const memory = memoryRaw as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(memory, 'root')) {
    throw new Error('memory.root must be set explicitly');
  }
  const rootValue = memory.root;
  if (typeof rootValue !== 'string' || !rootValue.trim()) {
    throw new Error('memory.root must be set explicitly');
  }

  const embeddingsRaw = memory.embeddings;
  const embeddings =
    typeof embeddingsRaw === 'object' &&
    embeddingsRaw !== null &&
    !Array.isArray(embeddingsRaw)
      ? (embeddingsRaw as Record<string, unknown>)
      : undefined;

  const dreamingRaw = memory.dreaming;
  const dreaming =
    typeof dreamingRaw === 'object' &&
    dreamingRaw !== null &&
    !Array.isArray(dreamingRaw)
      ? (dreamingRaw as Record<string, unknown>)
      : undefined;

  const llmRaw = memory.llm;
  const llm =
    typeof llmRaw === 'object' && llmRaw !== null && !Array.isArray(llmRaw)
      ? (llmRaw as Record<string, unknown>)
      : undefined;
  const llmModelsRaw = llm?.models;
  const llmModels =
    typeof llmModelsRaw === 'object' &&
    llmModelsRaw !== null &&
    !Array.isArray(llmModelsRaw)
      ? (llmModelsRaw as Record<string, unknown>)
      : undefined;

  const stringOrUndefined = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

  return {
    enabled: booleanValue(
      memory.enabled as string | boolean | undefined,
      'memory.enabled',
    ),
    root: rootValue.trim(),
    embeddingsEnabled: booleanValue(
      embeddings?.enabled as string | boolean | undefined,
      'memory.embeddings.enabled',
    ),
    embeddingProvider: stringOrUndefined(embeddings?.provider),
    embeddingModel: stringOrUndefined(embeddings?.model),
    dreamingEnabled: booleanValue(
      dreaming?.enabled as string | boolean | undefined,
      'memory.dreaming.enabled',
    ),
    llmExtractorModel: stringOrUndefined(llmModels?.extractor),
    llmDreamingModel: stringOrUndefined(llmModels?.dreaming),
    llmConsolidationModel: stringOrUndefined(llmModels?.consolidation),
    llmSessionSummaryModel: stringOrUndefined(
      llmModels?.session_summary ?? llmModels?.sessionSummary,
    ),
  };
}

export function readRuntimeMemorySettingsSnapshot(
  runtimeHome: string,
): RuntimeMemorySettingsSnapshot {
  const settingsPath = path.join(runtimeHome, 'settings.yaml');
  if (!fs.existsSync(settingsPath)) return {};

  const raw = fs.readFileSync(settingsPath, 'utf-8');
  if (raw.trimStart().startsWith('{')) {
    return parseJsonSettingsSnapshot(raw);
  }
  const lines = raw.split(/\r?\n/);
  const memoryIndex = lines.findIndex((line) =>
    isSectionHeader(line, 'memory', 0),
  );
  if (memoryIndex < 0) return {};

  const memoryBlock = readIndentedBlock(lines, memoryIndex, 0);
  const embeddingsBlock = readNestedBlock(memoryBlock, 'embeddings', 2);
  const dreamingBlock = readNestedBlock(memoryBlock, 'dreaming', 2);
  const llmBlock = readNestedBlock(memoryBlock, 'llm', 2);
  const llmModelsBlock = readNestedBlock(llmBlock, 'models', 4);
  const root = stringValue(readKeyValue(memoryBlock, 'root', 2));
  if (!root) {
    throw new Error('memory.root must be set explicitly');
  }

  return {
    enabled: booleanValue(
      readKeyValue(memoryBlock, 'enabled', 2),
      'memory.enabled',
    ),
    root,
    embeddingsEnabled: booleanValue(
      readKeyValue(embeddingsBlock, 'enabled', 4),
      'memory.embeddings.enabled',
    ),
    embeddingProvider: stringValue(
      readKeyValue(embeddingsBlock, 'provider', 4),
    ),
    embeddingModel: stringValue(readKeyValue(embeddingsBlock, 'model', 4)),
    dreamingEnabled: booleanValue(
      readKeyValue(dreamingBlock, 'enabled', 4),
      'memory.dreaming.enabled',
    ),
    llmExtractorModel: stringValue(
      readKeyValue(llmModelsBlock, 'extractor', 6),
    ),
    llmDreamingModel: stringValue(readKeyValue(llmModelsBlock, 'dreaming', 6)),
    llmConsolidationModel: stringValue(
      readKeyValue(llmModelsBlock, 'consolidation', 6),
    ),
    llmSessionSummaryModel: stringValue(
      readKeyValue(llmModelsBlock, 'session_summary', 6) ||
        readKeyValue(llmModelsBlock, 'sessionSummary', 6),
    ),
  };
}
