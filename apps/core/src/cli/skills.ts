import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import * as p from '@clack/prompts';

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
  const response = await controlRequest(runtimeHome, {
    method: 'POST',
    path: `/v1/skills/drafts/upload${uploadQuery(options)}`,
    body: zip,
    contentType: 'application/zip',
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

async function controlRequest(
  runtimeHome: string,
  input: {
    method: string;
    path: string;
    body: Uint8Array;
    contentType: string;
  },
): Promise<unknown> {
  const env = readRuntimeControlEnv(runtimeHome);
  const apiKey = controlApiKey(env);
  if (!apiKey) {
    throw new Error('MYCLAW_CONTROL_API_KEY is required for skill upload.');
  }
  const baseUrl = controlBaseUrl(env);
  const url = new URL(input.path, baseUrl);
  const mod = url.protocol === 'https:' ? https : http;
  const socketPath = controlSocketPath(runtimeHome, env);

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: socketPath ? undefined : url.hostname,
        port: socketPath ? undefined : url.port,
        path: `${url.pathname}${url.search}`,
        socketPath,
        method: input.method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
          'content-type': input.contentType,
          'content-length': String(input.body.byteLength),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const parsed = parseJson(Buffer.concat(chunks).toString('utf-8'));
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(errorMessage(parsed)));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on('error', reject);
    req.write(input.body);
    req.end();
  });
}

function readRuntimeControlEnv(runtimeHome: string): Record<string, string> {
  return {
    ...readEnvFile(path.join(runtimeHome, '.env')),
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  };
}

function readEnvFile(filePath: string): Record<string, string> {
  try {
    const env: Record<string, string> = {};
    for (const rawLine of fs.readFileSync(filePath, 'utf-8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = line.slice(0, eqIdx).trim();
      let value = line.slice(eqIdx + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

function controlApiKey(env: Record<string, string>): string {
  const single = env.MYCLAW_CONTROL_API_KEY?.trim();
  if (single) return single;
  const rawJson = env.MYCLAW_CONTROL_API_KEYS_JSON?.trim();
  if (!rawJson) return '';
  try {
    const parsed = JSON.parse(rawJson) as Array<{ token?: string }>;
    return parsed.find((entry) => entry.token?.trim())?.token?.trim() || '';
  } catch {
    return '';
  }
}

function controlBaseUrl(env: Record<string, string>): string {
  if (env.MYCLAW_CONTROL_BASE_URL?.trim()) {
    return env.MYCLAW_CONTROL_BASE_URL.trim();
  }
  const port = Number(env.MYCLAW_CONTROL_PORT || 0);
  return port > 0 ? `http://127.0.0.1:${port}` : 'http://127.0.0.1';
}

function controlSocketPath(
  runtimeHome: string,
  env: Record<string, string>,
): string | undefined {
  if (Number(env.MYCLAW_CONTROL_PORT || 0) > 0) return undefined;
  return (
    env.MYCLAW_CONTROL_SOCKET_PATH?.trim() ||
    path.join(runtimeHome, 'run', 'control.sock')
  );
}

function parseJson(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('MyClaw returned a non-JSON response');
  }
}

function errorMessage(input: unknown): string {
  if (isRecord(input) && isRecord(input.error)) {
    return String(input.error.message || 'MyClaw request failed');
  }
  return 'MyClaw request failed';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object';
}
