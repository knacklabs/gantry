import { z } from 'zod';

import {
  AGENT_HARNESSES,
  type AgentHarness,
} from '../../../shared/agent-engine.js';

const SCHEDULER_MODEL_WORKLOADS = ['one_time_job', 'recurring_job'] as const;

export const schedulerModelRecommendationSchema = {
  workload: z.enum(SCHEDULER_MODEL_WORKLOADS).optional(),
  agent_harness: z.enum(AGENT_HARNESSES).optional(),
  estimated_context_tokens: z.number().int().positive().optional(),
  requires_tools: z.boolean().optional(),
  priority: z.enum(['cheap', 'balanced', 'best']).optional(),
  current_alias: z.string().optional(),
};

export type SchedulerModelRecommendationArgs = {
  workload?: (typeof SCHEDULER_MODEL_WORKLOADS)[number];
  agent_harness?: AgentHarness;
  estimated_context_tokens?: number;
  requires_tools?: boolean;
  priority?: 'cheap' | 'balanced' | 'best';
  current_alias?: string;
};
