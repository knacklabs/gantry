import fs from 'fs';
import os from 'os';
import path from 'path';

export const PROVIDER_CONFIG_DIR_SEGMENT = ['.clau', 'de'].join('');
export const PROVIDER_CLI_NAME = ['clau', 'de'].join('');

const SKILLS = `${PROVIDER_CONFIG_DIR_SEGMENT}/skills`;
const MCP = `${PROVIDER_CONFIG_DIR_SEGMENT}/mcp`;
const LOCAL_SETTINGS = ['settings.local', 'json'].join('.');
const PROTECTED_FILES =
  '\\.mcp\\.json|mcp\\.json|SKILL\\.md|settings\\.json|settings\\.local\\.json';
const SKILL_ROOT_PATTERN = [
  '\\.codex\\/skills',
  '\\.agents\\/skills',
  `\\.${PROVIDER_CONFIG_DIR_SEGMENT.slice(1)}\\/skills`,
  'artifacts\\/skills',
  'agents\\/[^/]+\\/skills',
].join('|');
const PROTECTED_FILE_PATTERN = new RegExp(
  String.raw`(?:^|[\s"'(=:/])((?:\.?\/|[^"'()\s]+\/)?(?:${PROTECTED_FILES})|(?:\.?\/|[^"'()\s]+\/)?(?:${SKILL_ROOT_PATTERN})(?:\/[^"'()\s]*)?)`,
  'gi',
);

export function firstProtectedPathMention(command: string): string | undefined {
  return allProtectedPathMentions(command)[0];
}
export function allProtectedPathMentions(command: string): string[] {
  const tokenTargets = (command.match(/"[^"]+"|'[^']+'|[^\s;&|]+/g) ?? [])
    .flatMap((token) => splitCandidates(unquote(token)))
    .filter(isProtectedCapabilityPathLike);
  const regexTargets = matches(command, PROTECTED_FILE_PATTERN, 1).filter(
    (item) =>
      !/settings(?:\.local)?\.json$/i.test(item) ||
      isProtectedCapabilityPathLike(item),
  );
  return [...new Set([...tokenTargets, ...regexTargets])];
}

export function isProtectedCapabilityPathLike(filePath: string): boolean {
  return protectedCapabilityPathMatch(filePath) !== undefined;
}
export function protectedCapabilityPathMatch(
  filePath: string,
): string | undefined {
  return policyPathCandidates(filePath).find(isProtectedCapabilityPath);
}

export function isSkillCapabilityPath(value: string): boolean {
  return (
    value.endsWith('/SKILL.md') ||
    [
      `/${SKILLS}`,
      '/.codex/skills',
      '/.agents/skills',
      '/artifacts/skills',
    ].some((suffix) => isAtOrUnderPath(value, suffix)) ||
    /\/agents\/[^/]+\/skills(?:\/|$)/.test(value)
  );
}

export function isMcpCapabilityPath(value: string): boolean {
  return (
    value.endsWith('/.mcp.json') ||
    value.endsWith('/mcp.json') ||
    value.includes(`/${MCP}/`)
  );
}

export function isProviderSettingsPath(value: string): boolean {
  return (
    value.endsWith(`/${PROVIDER_CONFIG_DIR_SEGMENT}/settings.json`) ||
    value.endsWith(`/${PROVIDER_CONFIG_DIR_SEGMENT}/${LOCAL_SETTINGS}`)
  );
}

export function isRuntimeSettingsPath(value: string): boolean {
  return [
    '/myclaw/settings.yaml',
    '/myclaw/settings.yml',
    '/settings.yaml',
    '/settings.yml',
  ].some((suffix) => value === suffix || value.endsWith(suffix));
}

export function hasProtectedPathReference(value: string): boolean {
  return splitCandidates(value).some((candidate) =>
    Boolean(
      protectedCapabilityPathMatch(candidate) ??
      firstProtectedPathMention(candidate),
    ),
  );
}

function isProtectedCapabilityPath(value: string): boolean {
  return (
    isSkillCapabilityPath(value) ||
    isMcpCapabilityPath(value) ||
    isProviderSettingsPath(value) ||
    isRuntimeSettingsPath(value)
  );
}

function isAtOrUnderPath(value: string, suffix: string): boolean {
  return value.endsWith(suffix) || value.includes(`${suffix}/`);
}

function splitCandidates(value: string): string[] {
  return [value, ...value.split(/[@,=]/)]
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePathForPolicy(filePath: string): string {
  const parts: string[] = [];
  for (const part of filePath
    .replaceAll('\\', '/')
    .split('/')
    .map((item) => item.trim())) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function policyPathCandidates(filePath: string): string[] {
  const candidates = new Set([normalizePathForPolicy(filePath)]);
  if (filePath.startsWith('~/'))
    candidates.add(
      normalizePathForPolicy(path.join(os.homedir(), filePath.slice(2))),
    );
  try {
    const absolute = path.resolve(filePath);
    candidates.add(normalizePathForPolicy(absolute));
    const realPath = fs.existsSync(absolute)
      ? fs.realpathSync.native(absolute)
      : fs.existsSync(path.dirname(absolute))
        ? path.join(
            fs.realpathSync.native(path.dirname(absolute)),
            path.basename(filePath),
          )
        : undefined;
    if (realPath) candidates.add(normalizePathForPolicy(realPath));
  } catch {
    return [...candidates];
  }
  return [...candidates];
}

function matches(command: string, pattern: RegExp, group: number): string[] {
  pattern.lastIndex = 0;
  const out = [...command.matchAll(pattern)].flatMap((match) =>
    match[group] ? [match[group]] : [],
  );
  pattern.lastIndex = 0;
  return out;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}
