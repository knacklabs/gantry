import { queryOptions } from '@tanstack/react-query';

import { browserCsrfHeader, browserFetch } from '../../lib/auth/browser-auth';
import { operationsQueryKeys } from './operations-queries';

export type BrowserSkill = {
  id: string;
  name: string;
  description: string | null;
  source: 'bundled' | 'agent_created' | 'admin_uploaded';
  status: 'installed' | 'disabled';
  sizeBytes: number;
  actions: Array<{
    id: string;
    capabilityId: string;
    displayName: string;
    risk: 'read' | 'write' | 'admin';
    can: string;
    cannot: string;
    networkHosts: string[];
    requiredCredentialNames: string[];
  }>;
  attachedAgents: Array<{
    id: string;
    name: string;
    status: 'active' | 'disabled';
  }>;
  createdAt: string;
  updatedAt: string;
};

export type BrowserSkillInventory = {
  role: 'administrator' | 'viewer';
  skills: BrowserSkill[];
};

export type BrowserSkillFileMetadata = {
  path: string;
  contentType: string | null;
  sizeBytes: number;
  isText: boolean;
};

export type BrowserSkillAttachmentAgent =
  BrowserSkill['attachedAgents'][number] & {
    attached: boolean;
  };

export type BrowserSkillAttachments = {
  skillId: string;
  agents: BrowserSkillAttachmentAgent[];
};

type BrowserError = { error?: { code?: string; message?: string } };

async function responseBody<T>(
  response: Response,
  fallback: string,
): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | T
    | BrowserError
    | null;
  if (!response.ok || !body) {
    const error = (body as BrowserError | null)?.error;
    throw Object.assign(new Error(error?.message ?? fallback), {
      code: error?.code,
    });
  }
  return body as T;
}

export const skillInventoryQuery = queryOptions({
  queryKey: operationsQueryKeys.skills(),
  queryFn: async (): Promise<BrowserSkillInventory> => {
    const response = await browserFetch('/ui/api/skills', {
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('Skills could not be loaded.');
    return response.json() as Promise<BrowserSkillInventory>;
  },
});

export function skillAttachmentsQuery(
  skillId: string | undefined,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: [
      ...operationsQueryKeys.skills(),
      skillId ?? '',
      'agents',
    ] as const,
    enabled: enabled && Boolean(skillId),
    queryFn: async (): Promise<BrowserSkillAttachments> => {
      const response = await browserFetch(
        `/ui/api/skills/${encodeURIComponent(skillId ?? '')}/agents`,
        { credentials: 'same-origin' },
      );
      return responseBody(response, 'Skill attachments could not be loaded.');
    },
  });
}

export async function installSkillZip(file: File): Promise<BrowserSkill> {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    throw new Error('Choose one ZIP skill package.');
  }
  const response = await browserFetch('/ui/api/skills/install', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/zip',
      ...browserCsrfHeader(),
    },
    body: file,
  });
  const body = await responseBody<{ skill: BrowserSkill }>(
    response,
    'The skill ZIP could not be installed.',
  );
  return body.skill;
}

export async function replaceSkillAttachments(
  skillId: string,
  agentIds: readonly string[],
): Promise<BrowserSkillAttachments> {
  const response = await browserFetch(
    `/ui/api/skills/${encodeURIComponent(skillId)}/agents`,
    {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...browserCsrfHeader(),
      },
      body: JSON.stringify({ agentIds }),
    },
  );
  return responseBody(response, 'Skill attachments could not be saved.');
}

export function skillFilesQuery(skillId: string | undefined, enabled: boolean) {
  return queryOptions({
    queryKey: operationsQueryKeys.skillFiles(skillId ?? ''),
    enabled: enabled && Boolean(skillId),
    queryFn: async (): Promise<{
      skillId: string;
      files: BrowserSkillFileMetadata[];
    }> => {
      const response = await browserFetch(
        `/ui/api/skills/${encodeURIComponent(skillId ?? '')}/files`,
        { credentials: 'same-origin' },
      );
      if (!response.ok) throw new Error('Skill files could not be loaded.');
      return response.json() as Promise<{
        skillId: string;
        files: BrowserSkillFileMetadata[];
      }>;
    },
  });
}

export function skillFileQuery(
  skillId: string | undefined,
  path: string | undefined,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: operationsQueryKeys.skillFile(skillId ?? '', path ?? ''),
    enabled: enabled && Boolean(skillId && path),
    queryFn: async (): Promise<{
      skillId: string;
      file: BrowserSkillFileMetadata & { content: string | null };
    }> => {
      const response = await browserFetch(
        `/ui/api/skills/${encodeURIComponent(skillId ?? '')}/files/${encodeURIComponent(path ?? '')}`,
        { credentials: 'same-origin' },
      );
      if (!response.ok) throw new Error('Skill file could not be loaded.');
      return response.json() as Promise<{
        skillId: string;
        file: BrowserSkillFileMetadata & { content: string | null };
      }>;
    },
  });
}
