import { queryOptions } from '@tanstack/react-query';

import { browserFetch } from '../../lib/auth/browser-auth';
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
