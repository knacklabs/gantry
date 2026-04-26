import type { AppId } from '../app/app.js';
import type { ToolId } from '../tools/tools.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';

export type SkillId = BrandedId<'SkillId'>;

export interface SkillCatalogItem {
  id: SkillId;
  appId: AppId;
  name: string;
  description?: string;
  version: string;
  promptRefs: string[];
  toolIds: ToolId[];
  workflowRefs: string[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
