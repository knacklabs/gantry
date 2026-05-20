import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirSync, writePrivateFileSync } from './private-fs.js';

const LIVE_TOOL_RULE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const LIVE_TOOL_RULES_DIR = 'live-tool-rules';

export function readLiveToolRules(input: {
  ipcDir?: string;
  runHandle?: string;
}): string[] {
  const filePath = liveToolRulesPath(input);
  if (!filePath) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return normalizeRuleList(parsed);
  } catch (err) {
    if (!isExpectedReadMiss(err)) throw err;
    return [];
  }
}

export function appendLiveToolRules(input: {
  ipcDir?: string;
  runHandle?: string;
  rules: readonly string[];
}): string[] {
  const filePath = liveToolRulesPath(input);
  if (!filePath) return [];
  const next = mergeRules(readLiveToolRules(input), input.rules);
  ensurePrivateDirSync(path.dirname(filePath));
  writePrivateFileSync(filePath, JSON.stringify(next, null, 2));
  return next;
}

export function removeLiveToolRules(input: {
  ipcDir?: string;
  runHandle?: string;
  rules: readonly string[];
}): string[] {
  const filePath = liveToolRulesPath(input);
  if (!filePath) return [];
  const remove = new Set(normalizeRuleList(input.rules));
  const next = readLiveToolRules(input).filter((rule) => !remove.has(rule));
  ensurePrivateDirSync(path.dirname(filePath));
  writePrivateFileSync(filePath, JSON.stringify(next, null, 2));
  return next;
}

function liveToolRulesPath(input: {
  ipcDir?: string;
  runHandle?: string;
}): string | null {
  const ipcDir = input.ipcDir?.trim();
  const runHandle = input.runHandle?.trim();
  if (!ipcDir || !runHandle || !LIVE_TOOL_RULE_ID_RE.test(runHandle)) {
    return null;
  }
  return path.join(ipcDir, LIVE_TOOL_RULES_DIR, `${runHandle}.json`);
}

function isExpectedReadMiss(err: unknown): boolean {
  if (err instanceof SyntaxError) return true;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function mergeRules(
  baseRules: readonly string[],
  nextRules: readonly string[],
): string[] {
  const out = new Set(baseRules);
  for (const rule of normalizeRuleList(nextRules)) out.add(rule);
  return [...out];
}

function normalizeRuleList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    const rule = typeof item === 'string' ? item.trim() : '';
    if (rule) out.add(rule);
  }
  return [...out];
}
