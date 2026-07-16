import { queryOptions } from '@tanstack/react-query';

import { jobs, runs } from './jobs-preview';
import {
  activities,
  capacity,
  guardrails,
  memoryPipeline,
  memoryStores,
  models,
} from './runtime-preview';

export const runtimeQueryKeys = {
  all: ['runtime-preview'] as const,
  jobs: () => [...runtimeQueryKeys.all, 'jobs'] as const,
  runs: () => [...runtimeQueryKeys.all, 'runs'] as const,
  models: () => [...runtimeQueryKeys.all, 'models'] as const,
  memory: () => [...runtimeQueryKeys.all, 'memory'] as const,
  capacity: () => [...runtimeQueryKeys.all, 'capacity'] as const,
  guardrails: () => [...runtimeQueryKeys.all, 'guardrails'] as const,
  activity: () => [...runtimeQueryKeys.all, 'activity'] as const,
};

export const jobPreviewQuery = queryOptions({
  queryKey: runtimeQueryKeys.jobs(),
  queryFn: () => jobs,
  initialData: jobs,
});
export const runPreviewQuery = queryOptions({
  queryKey: runtimeQueryKeys.runs(),
  queryFn: () => runs,
  initialData: runs,
});
export const modelPreviewQuery = queryOptions({
  queryKey: runtimeQueryKeys.models(),
  queryFn: () => models,
  initialData: models,
});
export const memoryEnginePreviewQuery = queryOptions({
  queryKey: runtimeQueryKeys.memory(),
  queryFn: () => ({ stores: memoryStores, pipeline: memoryPipeline }),
  initialData: { stores: memoryStores, pipeline: memoryPipeline },
});
export const capacityPreviewQuery = queryOptions({
  queryKey: runtimeQueryKeys.capacity(),
  queryFn: () => capacity,
  initialData: capacity,
});
export const guardrailPreviewQuery = queryOptions({
  queryKey: runtimeQueryKeys.guardrails(),
  queryFn: () => guardrails,
  initialData: guardrails,
});
export const activityPreviewQuery = queryOptions({
  queryKey: runtimeQueryKeys.activity(),
  queryFn: () => activities,
  initialData: activities,
});
