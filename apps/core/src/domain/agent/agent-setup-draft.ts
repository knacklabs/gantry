import type { AppId } from '../app/app.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
import type { AgentId } from './agent.js';

export type AgentSetupStage =
  | 'agent'
  | 'model'
  | 'connection'
  | 'conversation'
  | 'profile'
  | 'review';

/**
 * Setup-only state for an agent which has not yet been admitted to runtime
 * routing. Secrets are referenced by name; their values never belong here.
 */
export interface AgentSetupDraft {
  appId: AppId;
  agentId: AgentId;
  purpose?: string;
  modelAlias?: string;
  connection?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
  currentStage: AgentSetupStage;
  version: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
