import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';

import { controlApiRequest } from './control-api.js';

type UploadOptions = {
  zipPath?: string;
  agentId?: string;
  createdBy?: string;
};

function usage(): string {
  return [
    'Usage:',
    '  gantry skill install <skill.zip> --agent <agentId> [--created-by <id>]',
    '  gantry skill list [--agent <agentId>]',
    '  gantry skill doctor <skillId>',
    '  gantry skill remove <skillId> --agent <agentId>',
  ].join('\n');
}

export async function runSkillCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [family, action, ...rest] = args;
  if (family === 'install') {
    const parsed = parseUploadArgs([action, ...rest].filter(Boolean));
    if ('error' in parsed) {
      p.log.error(parsed.error);
      return 1;
    }
    if (!parsed.agentId) {
      p.log.error('Missing --agent for skill install.');
      return 1;
    }
    return installSkill(runtimeHome, parsed);
  }
  if (family === 'list') return listSkills(runtimeHome, [action, ...rest]);
  if (family === 'doctor') return doctorSkill(runtimeHome, action);
  if (family === 'remove') return removeSkill(runtimeHome, action, rest);

  p.note(usage(), 'Skill');
  return 1;
}

function parseUploadArgs(args: string[]): UploadOptions | { error: string } {
  const options: UploadOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--agent') {
      options.agentId = args[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--agent=')) {
      options.agentId = arg.slice('--agent='.length);
      continue;
    }
    if (arg === '--created-by') {
      options.createdBy = args[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--created-by=')) {
      options.createdBy = arg.slice('--created-by='.length);
      continue;
    }
    if (arg.startsWith('--')) {
      return { error: `Unknown option for skill install: ${arg}` };
    }
    if (!options.zipPath) {
      options.zipPath = arg;
      continue;
    }
    return { error: `Unexpected argument for skill install: ${arg}` };
  }
  if (!options.zipPath) {
    return {
      error: 'Missing zip file. Use gantry skill install <skill.zip>.',
    };
  }
  if (options.agentId === '') {
    return { error: 'Missing value for --agent.' };
  }
  if (options.createdBy === '') {
    return { error: 'Missing value for --created-by.' };
  }
  return options;
}

async function installSkill(
  runtimeHome: string,
  options: UploadOptions,
): Promise<number> {
  const agentId = normalizeAgentId(options.agentId!);
  const createdBy = options.createdBy ?? 'cli';
  const uploaded = await uploadSkillResponse(runtimeHome, {
    ...options,
    agentId,
    createdBy,
  });
  const skill =
    isRecord(uploaded) && isRecord(uploaded.skill) ? uploaded.skill : null;
  const skillId = String(skill?.id ?? '');
  if (!skillId) {
    p.log.error('Skill upload returned an invalid response.');
    return 1;
  }
  const encodedAgentId = encodeURIComponent(agentId);
  await controlApiRequest(runtimeHome, {
    method: 'PUT',
    path: `/v1/agents/${encodedAgentId}/skills/${encodeURIComponent(skillId)}`,
    body: {},
  });
  const capabilityIds = skillActionCapabilityIds(skill);
  if (capabilityIds.length > 0) {
    // Read-modify-write the full access document: the access PUT replaces
    // sources and selections together, so preserve existing sources (the
    // skill source was attached above) while adding the new selections.
    const current = await controlApiRequest(runtimeHome, {
      method: 'GET',
      path: `/v1/agents/${encodedAgentId}/access`,
    });
    const existing = Array.isArray(
      isRecord(current) ? current.selections : undefined,
    )
      ? (
          current as {
            selections: Array<{ id?: unknown; version?: unknown }>;
          }
        ).selections
      : [];
    const sources =
      isRecord(current) && isRecord(current.sources)
        ? current.sources
        : { skills: [], mcpServers: [], tools: [] };
    await controlApiRequest(runtimeHome, {
      method: 'PUT',
      path: `/v1/agents/${encodedAgentId}/access`,
      body: {
        sources,
        selections: uniqueCapabilities([
          ...existing.map((capability) => ({
            id: String(capability.id ?? ''),
            version: String(capability.version ?? 'catalog'),
          })),
          ...capabilityIds.map((id) => ({ id, version: 'catalog' })),
        ]),
      },
    });
  }
  p.note(
    [
      `skill: ${skillId}`,
      `agent: ${agentId}`,
      capabilityIds.length > 0
        ? `capabilities: ${capabilityIds.join(', ')}`
        : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
    'Skill Installed',
  );
  return 0;
}

async function uploadSkillResponse(
  runtimeHome: string,
  options: UploadOptions,
): Promise<unknown> {
  const zipPath = path.resolve(options.zipPath!);
  if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) {
    throw new Error(`Skill zip not found: ${zipPath}`);
  }
  const zip = fs.readFileSync(zipPath);
  return controlApiRequest(runtimeHome, {
    method: 'POST',
    path: `/v1/skills/install${uploadQuery(options)}`,
    body: zip,
    contentType: 'application/zip',
    missingKeyMessage:
      'GANTRY_CONTROL_API_KEYS_JSON with at least one complete key record is required for skill install.',
  });
}

async function listSkills(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const agentId = flagValue(args.filter(Boolean), '--agent');
  const response = await controlApiRequest(runtimeHome, {
    method: 'GET',
    path: `/v1/skills${agentId ? `?agentId=${encodeURIComponent(normalizeAgentId(agentId))}` : ''}`,
  });
  const skills = Array.isArray(isRecord(response) ? response.skills : undefined)
    ? (response as { skills: unknown[] }).skills
    : [];
  if (skills.length === 0) {
    p.note('No installed skills found.', 'Skills');
    return 0;
  }
  p.note(skills.map(formatSkill).join('\n'), 'Skills');
  return 0;
}

async function doctorSkill(runtimeHome: string, skillId = ''): Promise<number> {
  if (!skillId) {
    p.log.error('Missing skill id for skill doctor.');
    return 1;
  }
  await controlApiRequest(runtimeHome, {
    method: 'GET',
    path: `/v1/skills/${encodeURIComponent(skillId)}/files`,
  });
  p.log.success(`Skill ${skillId} is readable.`);
  return 0;
}

async function removeSkill(
  runtimeHome: string,
  skillId = '',
  args: string[],
): Promise<number> {
  if (!skillId) {
    p.log.error('Missing skill id for skill remove.');
    return 1;
  }
  const agentId = flagValue(args, '--agent');
  if (!agentId) {
    p.log.error('Missing --agent for skill remove.');
    return 1;
  }
  await controlApiRequest(runtimeHome, {
    method: 'DELETE',
    path: `/v1/agents/${encodeURIComponent(normalizeAgentId(agentId))}/skills/${encodeURIComponent(skillId)}`,
  });
  p.log.success(`Removed ${skillId} from ${normalizeAgentId(agentId)}.`);
  return 0;
}

function uploadQuery(options: UploadOptions): string {
  const params = new URLSearchParams();
  if (options.agentId) params.set('agentId', options.agentId);
  if (options.createdBy) params.set('createdBy', options.createdBy);
  const raw = params.toString();
  return raw ? `?${raw}` : '';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object';
}

function flagValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === name) return args[i + 1] || undefined;
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function formatSkill(input: unknown): string {
  if (!isRecord(input)) return '- <invalid>';
  const id = String(input.id ?? '');
  const name = String(input.name ?? id);
  const status = String(input.status ?? 'installed');
  const lines = [
    `- ${name} (${id}) [${status}]`,
    ...formatSkillActionLines(input),
  ];
  return lines.join('\n');
}

function formatSkillActionLines(skill: Record<string, unknown>): string[] {
  const actions = skill.actionPermissions;
  if (!Array.isArray(actions)) return [];
  const lines: string[] = [];
  for (const action of actions) {
    if (!isRecord(action)) continue;
    const displayName = String(action.displayName ?? action.capabilityId ?? '');
    if (!displayName) continue;
    lines.push(`    • ${displayName}`);
    const hosts = Array.isArray(action.networkHosts)
      ? [
          ...new Set(
            action.networkHosts
              .map((host) => String(host ?? '').trim())
              .filter(Boolean),
          ),
        ]
      : [];
    if (hosts.length > 0) {
      lines.push(`      Network: ${hosts.join(', ')}`);
    }
  }
  return lines;
}

function normalizeAgentId(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('agent:') ? trimmed : `agent:${trimmed}`;
}

function skillActionCapabilityIds(skill: Record<string, unknown> | null) {
  const actions = skill?.actionPermissions;
  if (!Array.isArray(actions)) return [];
  return [
    ...new Set(
      actions
        .map((action) =>
          isRecord(action) ? String(action.capabilityId ?? '') : '',
        )
        .filter(Boolean),
    ),
  ];
}

function uniqueCapabilities(
  capabilities: Array<{ id: string; version: string }>,
) {
  const seen = new Set<string>();
  return capabilities.filter((capability) => {
    if (!capability.id || seen.has(capability.id)) return false;
    seen.add(capability.id);
    return true;
  });
}
