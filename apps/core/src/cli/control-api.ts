import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import {
  CONTROL_API_SCOPES,
  isValidControlId,
} from '../control/server/auth.js';
import { parseEnvContent } from '../shared/env-file.js';

export async function controlApiRequest(
  runtimeHome: string,
  input: {
    method: string;
    path: string;
    body?: unknown;
    contentType?: string;
    missingKeyMessage?: string;
  },
): Promise<unknown> {
  const env = readRuntimeControlEnv(runtimeHome);
  const apiKey = controlApiKey(env);
  if (!apiKey) {
    throw new Error(
      input.missingKeyMessage ||
        'GANTRY_CONTROL_API_KEYS_JSON with at least one complete key record is required.',
    );
  }
  const body = requestBody(input.body);
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
          ...(body
            ? {
                'content-type': input.contentType || 'application/json',
                'content-length': String(body.byteLength),
              }
            : {}),
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
    if (body) req.write(body);
    req.end();
  });
}

function requestBody(body: unknown): Buffer | undefined {
  if (body === undefined) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
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
    return parseEnvContent(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function controlApiKey(env: Record<string, string>): string {
  const rawJson = env.GANTRY_CONTROL_API_KEYS_JSON?.trim();
  if (!rawJson) return '';
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return '';
    return (
      parsed
        .find((entry) => isCompleteControlApiKeyEntry(entry))
        ?.token.trim() || ''
    );
  } catch {
    return '';
  }
}

function isCompleteControlApiKeyEntry(input: unknown): input is {
  kid: string;
  token: string;
  appId: string;
  scopes: string[];
} {
  if (!isRecord(input)) return false;
  return (
    typeof input.kid === 'string' &&
    input.kid.trim().length > 0 &&
    typeof input.token === 'string' &&
    input.token.trim().length > 0 &&
    typeof input.appId === 'string' &&
    isValidControlId(input.appId.trim()) &&
    Array.isArray(input.scopes) &&
    input.scopes.length > 0 &&
    input.scopes.every(
      (scope) =>
        typeof scope === 'string' &&
        CONTROL_API_SCOPES.includes(
          scope.trim() as (typeof CONTROL_API_SCOPES)[number],
        ),
    )
  );
}

function controlBaseUrl(env: Record<string, string>): string {
  if (env.GANTRY_CONTROL_BASE_URL?.trim()) {
    return env.GANTRY_CONTROL_BASE_URL.trim();
  }
  const port = Number(env.GANTRY_CONTROL_PORT || 0);
  return port > 0 ? `http://127.0.0.1:${port}` : 'http://127.0.0.1';
}

function controlSocketPath(
  runtimeHome: string,
  env: Record<string, string>,
): string | undefined {
  if (env.GANTRY_CONTROL_BASE_URL?.trim()) return undefined;
  if (Number(env.GANTRY_CONTROL_PORT || 0) > 0) return undefined;
  return (
    env.GANTRY_CONTROL_SOCKET_PATH?.trim() ||
    path.join(runtimeHome, 'run', 'control.sock')
  );
}

function parseJson(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('Gantry returned a non-JSON response', { cause: err });
  }
}

function errorMessage(input: unknown): string {
  if (isRecord(input) && isRecord(input.error)) {
    return String(input.error.message || 'Gantry request failed');
  }
  return 'Gantry request failed';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object';
}
