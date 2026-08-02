import { z } from 'zod';
import { type AgentHarness } from '../../../shared/agent-engine.js';
import type { ModelWorkload } from '../../../shared/model-catalog.js';
export declare const schedulerModelRecommendationSchema: {
    workload: z.ZodOptional<z.ZodEnum<{
        chat: "chat";
        one_time_job: "one_time_job";
        recurring_job: "recurring_job";
        memory_extractor: "memory_extractor";
        memory_dreaming: "memory_dreaming";
        memory_consolidation: "memory_consolidation";
    }>>;
    agent_harness: z.ZodOptional<z.ZodEnum<{
        auto: "auto";
        deepagents: "deepagents";
        anthropic_sdk: "anthropic_sdk";
    }>>;
    estimated_context_tokens: z.ZodOptional<z.ZodNumber>;
    requires_tools: z.ZodOptional<z.ZodBoolean>;
    priority: z.ZodOptional<z.ZodEnum<{
        cheap: "cheap";
        balanced: "balanced";
        best: "best";
    }>>;
    current_alias: z.ZodOptional<z.ZodString>;
};
export type SchedulerModelRecommendationArgs = {
    workload?: ModelWorkload;
    agent_harness?: AgentHarness;
    estimated_context_tokens?: number;
    requires_tools?: boolean;
    priority?: 'cheap' | 'balanced' | 'best';
    current_alias?: string;
};
