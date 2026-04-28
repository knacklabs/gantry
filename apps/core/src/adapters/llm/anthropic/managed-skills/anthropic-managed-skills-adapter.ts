import type Anthropic from '@anthropic-ai/sdk';

export type AnthropicManagedSkillType = 'anthropic' | 'custom';

export interface AnthropicManagedSkillRef {
  skillId: string;
  type: AnthropicManagedSkillType;
  version?: string;
}

export interface AnthropicSkillSummary {
  id: string;
  displayTitle: string | null;
  latestVersion: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnthropicSkillVersionSummary {
  id: string;
  skillId: string;
  version: string;
  name: string;
  description: string;
  directory: string;
  createdAt: string;
}

export interface AnthropicSkillUploadAsset {
  path: string;
  contentType?: string;
  content: Uint8Array;
}

type SkillListItem = {
  id: string;
  display_title: string | null;
  latest_version: string | null;
  source: string;
  created_at: string;
  updated_at: string;
};

type SkillVersionListItem = {
  id: string;
  skill_id: string;
  version: string;
  name: string;
  description: string;
  directory: string;
  created_at: string;
};

type AnthropicSkillsApi = Anthropic['beta']['skills'];
type SkillCreateParams = Parameters<AnthropicSkillsApi['create']>[0];
type SkillListParams = Parameters<AnthropicSkillsApi['list']>[0];
type SkillVersionCreateParams = Parameters<
  AnthropicSkillsApi['versions']['create']
>[1];
type SkillVersionListParams = Parameters<
  AnthropicSkillsApi['versions']['list']
>[1];
type AnthropicManagedSkillsClient = {
  beta: {
    skills: {
      create(params?: SkillCreateParams): Promise<SkillListItem>;
      retrieve(skillId: string): Promise<SkillListItem>;
      list(params?: SkillListParams): AsyncIterable<SkillListItem>;
      delete(skillId: string): Promise<unknown>;
      versions: {
        create(
          skillId: string,
          params?: SkillVersionCreateParams,
        ): Promise<SkillVersionListItem>;
        retrieve(
          version: string,
          params: { skill_id: string },
        ): Promise<SkillVersionListItem>;
        list(
          skillId: string,
          params?: SkillVersionListParams,
        ): AsyncIterable<SkillVersionListItem>;
        delete(version: string, params: { skill_id: string }): Promise<unknown>;
      };
    };
  };
};

export class AnthropicManagedSkillsAdapter {
  constructor(private readonly client: AnthropicManagedSkillsClient) {}

  async createSkill(
    params?: SkillCreateParams,
  ): Promise<AnthropicSkillSummary> {
    return toSkillSummary(await this.client.beta.skills.create(params));
  }

  async createCustomSkillFromAssets(input: {
    displayTitle?: string;
    assets: AnthropicSkillUploadAsset[];
  }): Promise<AnthropicSkillSummary> {
    return this.createSkill({
      display_title: input.displayTitle,
      files: input.assets.map(assetToFile),
    });
  }

  async getSkill(skillId: string): Promise<AnthropicSkillSummary> {
    return toSkillSummary(await this.client.beta.skills.retrieve(skillId));
  }

  async listSkills(params?: SkillListParams): Promise<AnthropicSkillSummary[]> {
    const skills: AnthropicSkillSummary[] = [];
    for await (const skill of this.client.beta.skills.list(params)) {
      skills.push(toSkillSummary(skill));
    }
    return skills;
  }

  deleteSkill(skillId: string): Promise<unknown> {
    return this.client.beta.skills.delete(skillId);
  }

  async createSkillVersion(
    skillId: string,
    params?: SkillVersionCreateParams,
  ): Promise<AnthropicSkillVersionSummary> {
    return toVersionSummary(
      await this.client.beta.skills.versions.create(skillId, params),
    );
  }

  async createCustomSkillVersionFromAssets(input: {
    skillId: string;
    assets: AnthropicSkillUploadAsset[];
  }): Promise<AnthropicSkillVersionSummary> {
    return this.createSkillVersion(input.skillId, {
      files: input.assets.map(assetToFile),
    });
  }

  async getSkillVersion(
    skillId: string,
    version: string,
  ): Promise<AnthropicSkillVersionSummary> {
    return toVersionSummary(
      await this.client.beta.skills.versions.retrieve(version, {
        skill_id: skillId,
      }),
    );
  }

  async listSkillVersions(
    skillId: string,
    params?: SkillVersionListParams,
  ): Promise<AnthropicSkillVersionSummary[]> {
    const versions: AnthropicSkillVersionSummary[] = [];
    for await (const version of this.client.beta.skills.versions.list(
      skillId,
      params,
    )) {
      versions.push(toVersionSummary(version));
    }
    return versions;
  }

  deleteSkillVersion(skillId: string, version: string): Promise<unknown> {
    return this.client.beta.skills.versions.delete(version, {
      skill_id: skillId,
    });
  }
}

function assetToFile(asset: AnthropicSkillUploadAsset): File {
  return new File([Buffer.from(asset.content)], `skill/${asset.path}`, {
    type: asset.contentType || 'application/octet-stream',
  });
}

export function toAnthropicSkillParam(ref: AnthropicManagedSkillRef): {
  skill_id: string;
  type: AnthropicManagedSkillType;
  version?: string;
} {
  return {
    skill_id: ref.skillId,
    type: ref.type,
    ...(ref.version ? { version: ref.version } : {}),
  };
}

export function toAnthropicSkillParams(
  refs: AnthropicManagedSkillRef[],
): Array<ReturnType<typeof toAnthropicSkillParam>> {
  return refs.map(toAnthropicSkillParam);
}

function toSkillSummary(skill: SkillListItem): AnthropicSkillSummary {
  return {
    id: skill.id,
    displayTitle: skill.display_title,
    latestVersion: skill.latest_version,
    source: skill.source,
    createdAt: skill.created_at,
    updatedAt: skill.updated_at,
  };
}

function toVersionSummary(
  version: SkillVersionListItem,
): AnthropicSkillVersionSummary {
  return {
    id: version.id,
    skillId: version.skill_id,
    version: version.version,
    name: version.name,
    description: version.description,
    directory: version.directory,
    createdAt: version.created_at,
  };
}
