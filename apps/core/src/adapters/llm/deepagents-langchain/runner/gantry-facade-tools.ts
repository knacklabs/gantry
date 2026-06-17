import fs from 'node:fs/promises';
import path from 'node:path';

import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';

import {
  GANTRY_FACADE_EXACT_TOOL_NAMES,
  type GantryFacadeExactToolName,
  validateGantryFacadeToolInput,
} from '../../../../shared/gantry-tool-facades.js';
import {
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '../../../../shared/tool-execution-policy-service.js';
import {
  evaluateNeutralToolPreChecks,
  evaluateNeutralToolPolicy,
  LOCKED_ACCESS_PRESET_DENY_REASON,
} from '../../../../runner/tool-gate-core.js';
import {
  requestPermissionApprovalViaIpc,
  type PermissionIpcRuntimeEnv,
} from '../../../../runner/permission-ipc-client.js';
import type { ThirdPartyMcpGateConfig } from './third-party-mcp-gate.js';

export const DEEPAGENTS_GANTRY_FACADE_TOOL_NAMES =
  GANTRY_FACADE_EXACT_TOOL_NAMES.filter(
    (name) => name !== 'AgentDelegation',
  ) as Exclude<GantryFacadeExactToolName, 'AgentDelegation'>[];

type DeepAgentsFacadeToolName =
  (typeof DEEPAGENTS_GANTRY_FACADE_TOOL_NAMES)[number];

export interface GantryFacadeToolsConfig {
  workspaceFolder: string;
  memoryBlock: string;
  configuredAllowedTools: readonly string[];
  gateContext: ThirdPartyMcpGateConfig['gateContext'];
  permissionEnv: PermissionIpcRuntimeEnv;
  lockedAccessPreset: boolean;
  cwd?: string;
}

const MAX_TEXT_OUTPUT_CHARS = 80_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_SEARCH_ENTRIES = 10_000;
const WEB_FETCH_TIMEOUT_MS = 20_000;

const schemas = {
  WebSearch: z.object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(50).optional(),
  }),
  WebRead: z.object({ url: z.string().url() }),
  FileSearch: z.object({
    mode: z.union([z.literal('path'), z.literal('content')]),
    query: z.string().min(1),
    include: z.union([z.string(), z.array(z.string())]).optional(),
    exclude: z.union([z.string(), z.array(z.string())]).optional(),
    maxResults: z.number().int().min(1).max(1000).optional(),
  }),
  FileRead: z.object({ path: z.string().min(1) }),
  FileEdit: z.object({ path: z.string().min(1), patch: z.string().min(1) }),
  FileWrite: z.object({ path: z.string().min(1), content: z.string() }),
} satisfies Record<DeepAgentsFacadeToolName, z.ZodTypeAny>;

export function createGantryFacadeTools(
  config: GantryFacadeToolsConfig,
): StructuredToolInterface[] {
  const classifier = new ToolExecutionClassifier();
  const policy = new ToolExecutionPolicyService();
  return DEEPAGENTS_GANTRY_FACADE_TOOL_NAMES.map((toolName) =>
    createOneFacadeTool(toolName, config, classifier, policy),
  );
}

function createOneFacadeTool(
  toolName: DeepAgentsFacadeToolName,
  config: GantryFacadeToolsConfig,
  classifier: ToolExecutionClassifier,
  policy: ToolExecutionPolicyService,
): StructuredToolInterface {
  return tool(
    async (input: unknown): Promise<string> => {
      const validation = validateGantryFacadeToolInput(toolName, input);
      if (!validation.ok) return validation.reason;

      const policyRequest = policyToolRequest(toolName, input);
      const preChecks = evaluateNeutralToolPreChecks({
        toolName: policyRequest.toolName,
        toolInput: policyRequest.toolInput,
        memoryBlock: config.memoryBlock,
        yoloMode: config.gateContext.yoloMode,
      });
      if (preChecks) return preChecks.reason;

      const decision = evaluateNeutralToolPolicy({
        classifier,
        policy,
        toolName: policyRequest.toolName,
        toolInput: policyRequest.toolInput,
        context: config.gateContext,
        allowedToolRules: config.configuredAllowedTools,
      });
      if (decision.status === 'allow') {
        return executeFacadeTool(toolName, input, config);
      }

      if (config.lockedAccessPreset) return LOCKED_ACCESS_PRESET_DENY_REASON;

      const approval = await requestPermissionApprovalViaIpc(
        config.permissionEnv,
        {
          appId: config.permissionEnv.appId,
          agentId: config.permissionEnv.agentId || undefined,
          agentFolder: config.workspaceFolder,
          targetJid: config.permissionEnv.chatJid || undefined,
          toolName,
          decisionReason: decision.reason,
          closestRule: decision.closestRule,
          toolInput: input,
          threadId: config.gateContext.threadId,
        },
      );
      if (!approval.approved) {
        return `Permission denied: ${approval.reason || 'Denied by operator'}`;
      }
      return executeFacadeTool(toolName, input, config);
    },
    {
      name: toolName,
      description: facadeDescription(toolName),
      schema: schemas[toolName] as never,
    },
  ) as unknown as StructuredToolInterface;
}

function policyToolRequest(
  toolName: DeepAgentsFacadeToolName,
  input: unknown,
): { toolName: string; toolInput: unknown } {
  const record = input as Record<string, unknown>;
  switch (toolName) {
    case 'WebSearch':
      return { toolName: 'WebSearch', toolInput: input };
    case 'WebRead':
      return { toolName: 'WebFetch', toolInput: input };
    case 'FileSearch':
      return {
        toolName: record.mode === 'path' ? 'Glob' : 'Grep',
        toolInput:
          record.mode === 'path'
            ? { pattern: record.query }
            : { pattern: record.query, path: record.include },
      };
    case 'FileRead':
      return { toolName: 'Read', toolInput: { file_path: record.path } };
    case 'FileEdit':
      return {
        toolName: 'Edit',
        toolInput: { file_path: record.path, patch: record.patch },
      };
    case 'FileWrite':
      return {
        toolName: 'Write',
        toolInput: { file_path: record.path, content: record.content },
      };
  }
}

async function executeFacadeTool(
  toolName: DeepAgentsFacadeToolName,
  input: unknown,
  config: GantryFacadeToolsConfig,
): Promise<string> {
  const record = input as Record<string, unknown>;
  switch (toolName) {
    case 'WebSearch':
      return webSearch(
        String(record.query),
        numberOrDefault(record.maxResults, 8),
      );
    case 'WebRead':
      return webRead(String(record.url));
    case 'FileSearch':
      return fileSearch(record, config);
    case 'FileRead':
      return fileRead(String(record.path), config);
    case 'FileEdit':
      return fileEdit(String(record.path), String(record.patch), config);
    case 'FileWrite':
      return fileWrite(String(record.path), String(record.content), config);
  }
}

async function webSearch(query: string, maxResults: number): Promise<string> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url);
  const results = [
    ...html.matchAll(
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    ),
  ]
    .slice(0, maxResults)
    .map((match, index) => {
      const href = decodeSearchHref(match[1] ?? '');
      const title = htmlToText(match[2] ?? '').trim() || href;
      return `${index + 1}. ${title}\n${href}`;
    });
  if (results.length === 0) {
    return `No parsed search results. Search URL: ${url}`;
  }
  return results.join('\n\n');
}

async function webRead(url: string): Promise<string> {
  const raw = await fetchText(url);
  const text = htmlToText(raw);
  return truncateText(text.trim() || raw, MAX_TEXT_OUTPUT_CHARS);
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Gantry/1.0 WebRead' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fileSearch(
  input: Record<string, unknown>,
  config: GantryFacadeToolsConfig,
): Promise<string> {
  const root = await workspaceRoot(config);
  const maxResults = numberOrDefault(input.maxResults, 100);
  const include = filters(input.include);
  const exclude = filters(input.exclude);
  const query = String(input.query);
  const queryLower = query.toLowerCase();
  const results: string[] = [];
  let visited = 0;

  await walk(root, '', async (absolute, relative, entry) => {
    if (results.length >= maxResults || visited >= MAX_SEARCH_ENTRIES) return;
    visited += 1;
    if (entry.isDirectory()) return;
    if (!matchesFilters(relative, include, exclude)) return;
    if (input.mode === 'path') {
      if (relative.toLowerCase().includes(queryLower)) results.push(relative);
      return;
    }
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat || stat.size > MAX_SEARCH_FILE_BYTES) return;
    const text = await fs.readFile(absolute, 'utf-8').catch(() => '');
    const lineIndex = text
      .split(/\r?\n/)
      .findIndex((line) => line.toLowerCase().includes(queryLower));
    if (lineIndex >= 0) {
      const preview = text.split(/\r?\n/)[lineIndex]?.trim() ?? '';
      results.push(`${relative}:${lineIndex + 1}: ${preview}`);
    }
  });

  return results.length
    ? results.join('\n')
    : `No ${input.mode === 'path' ? 'path' : 'content'} results for "${query}".`;
}

async function fileRead(
  relativePath: string,
  config: GantryFacadeToolsConfig,
): Promise<string> {
  const target = await resolveExistingWorkspacePath(relativePath, config);
  const text = await fs.readFile(target, 'utf-8');
  return truncateText(text, MAX_TEXT_OUTPUT_CHARS);
}

async function fileWrite(
  relativePath: string,
  content: string,
  config: GantryFacadeToolsConfig,
): Promise<string> {
  const target = await resolveWritableWorkspacePath(relativePath, config);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf-8');
  return `Wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${relativePath}.`;
}

async function fileEdit(
  relativePath: string,
  patch: string,
  config: GantryFacadeToolsConfig,
): Promise<string> {
  const target = await resolveExistingWorkspacePath(relativePath, config);
  const current = await fs.readFile(target, 'utf-8');
  const edit = parseEditPatch(patch);
  if (!edit) {
    return 'FileEdit patch must be JSON {"oldText":"...","newText":"..."} or a SEARCH/REPLACE block.';
  }
  if (!current.includes(edit.oldText)) {
    return 'FileEdit oldText was not found; read the file again before editing.';
  }
  const next = current.replace(edit.oldText, edit.newText);
  await fs.writeFile(target, next, 'utf-8');
  return `Edited ${relativePath}.`;
}

function parseEditPatch(
  patch: string,
): { oldText: string; newText: string } | null {
  try {
    const parsed = JSON.parse(patch) as Record<string, unknown>;
    if (
      typeof parsed.oldText === 'string' &&
      typeof parsed.newText === 'string'
    ) {
      return { oldText: parsed.oldText, newText: parsed.newText };
    }
  } catch {
    // Fall through to SEARCH/REPLACE.
  }
  const match =
    /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/.exec(
      patch,
    );
  return match ? { oldText: match[1] ?? '', newText: match[2] ?? '' } : null;
}

async function workspaceRoot(config: GantryFacadeToolsConfig): Promise<string> {
  const configured =
    config.cwd?.trim() ||
    process.env.GANTRY_WORKSPACE_GROUP_DIR?.trim() ||
    process.cwd();
  return fs.realpath(configured);
}

async function resolveExistingWorkspacePath(
  relativePath: string,
  config: GantryFacadeToolsConfig,
): Promise<string> {
  const root = await workspaceRoot(config);
  const candidate = path.resolve(root, relativePath);
  ensureInsideRoot(root, candidate);
  const real = await fs.realpath(candidate);
  ensureInsideRoot(root, real);
  return real;
}

async function resolveWritableWorkspacePath(
  relativePath: string,
  config: GantryFacadeToolsConfig,
): Promise<string> {
  const root = await workspaceRoot(config);
  const candidate = path.resolve(root, relativePath);
  ensureInsideRoot(root, candidate);
  const existingParent = await nearestExistingParent(path.dirname(candidate));
  const realParent = await fs.realpath(existingParent);
  ensureInsideRoot(root, realParent);
  return candidate;
}

async function nearestExistingParent(dir: string): Promise<string> {
  for (;;) {
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) return dir;
    } catch {
      // Keep walking up.
    }
    const next = path.dirname(dir);
    if (next === dir) return dir;
    dir = next;
  }
}

function ensureInsideRoot(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error('File path escapes the Gantry workspace.');
}

async function walk(
  root: string,
  relativeDir: string,
  visit: (
    absolute: string,
    relative: string,
    entry: import('node:fs').Dirent,
  ) => Promise<void>,
): Promise<void> {
  const absoluteDir = path.join(root, relativeDir);
  const entries = await fs
    .readdir(absoluteDir, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const relative = toPosix(path.join(relativeDir, entry.name));
    const absolute = path.join(root, relative);
    await visit(absolute, relative, entry);
    if (entry.isDirectory()) {
      await walk(root, relative, visit);
    }
  }
}

function filters(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function matchesFilters(
  relativePath: string,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  if (
    include.length > 0 &&
    !include.some((item) => globMatch(item, relativePath))
  ) {
    return false;
  }
  return !exclude.some((item) => globMatch(item, relativePath));
}

function globMatch(pattern: string, value: string): boolean {
  const regex = new RegExp(
    `^${pattern.split('*').map(escapeRegex).join('.*')}$`,
  );
  return regex.test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}

function decodeSearchHref(value: string): string {
  try {
    const url = new URL(value, 'https://duckduckgo.com');
    const redirected = url.searchParams.get('uddg');
    return redirected || url.toString();
  } catch {
    return value;
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function facadeDescription(toolName: DeepAgentsFacadeToolName): string {
  switch (toolName) {
    case 'WebSearch':
      return 'Search the web for discovery. Use WebRead for exact source reading.';
    case 'WebRead':
      return 'Read one exact http(s) URL and return extracted text.';
    case 'FileSearch':
      return 'Search approved host workspace files by safe relative path or content.';
    case 'FileRead':
      return 'Read one approved host workspace file by exact safe relative path.';
    case 'FileEdit':
      return 'Edit one approved host workspace file. Patch must be JSON {"oldText":"...","newText":"..."} or a SEARCH/REPLACE block.';
    case 'FileWrite':
      return 'Write one approved host workspace file by exact safe relative path.';
  }
}
