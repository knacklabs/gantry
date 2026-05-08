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
    '  myclaw skill draft upload <skill.zip> [--agent <agentId>] [--created-by <id>]',
  ].join('\n');
}

export async function runSkillCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [family, action, ...rest] = args;
  if (family === 'draft' && action === 'upload') {
    const parsed = parseUploadArgs(rest);
    if ('error' in parsed) {
      p.log.error(parsed.error);
      return 1;
    }
    return uploadSkillDraft(runtimeHome, parsed);
  }

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
      return { error: `Unknown option for skill draft upload: ${arg}` };
    }
    if (!options.zipPath) {
      options.zipPath = arg;
      continue;
    }
    return { error: `Unexpected argument for skill draft upload: ${arg}` };
  }
  if (!options.zipPath) {
    return {
      error: 'Missing zip file. Use myclaw skill draft upload <skill.zip>.',
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

async function uploadSkillDraft(
  runtimeHome: string,
  options: UploadOptions,
): Promise<number> {
  const zipPath = path.resolve(options.zipPath!);
  if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) {
    p.log.error(`Skill zip not found: ${zipPath}`);
    return 1;
  }
  const zip = fs.readFileSync(zipPath);
  const response = await controlApiRequest(runtimeHome, {
    method: 'POST',
    path: `/v1/skills/drafts/upload${uploadQuery(options)}`,
    body: zip,
    contentType: 'application/zip',
    missingKeyMessage:
      'MYCLAW_CONTROL_API_KEYS_JSON with at least one complete key record is required for skill upload.',
  });
  const draft =
    isRecord(response) && isRecord(response.draft) ? response.draft : null;
  if (!draft) {
    p.log.error('Skill upload returned an invalid response.');
    return 1;
  }
  p.note(
    [
      `id: ${String(draft.id || '')}`,
      `name: ${String(draft.name || '')}`,
      `status: ${String(draft.status || '')}`,
    ].join('\n'),
    'Skill Draft Uploaded',
  );
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
