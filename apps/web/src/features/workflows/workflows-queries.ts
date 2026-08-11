import { queryOptions } from '@tanstack/react-query';

import { externalSystems, workflowRuns, workflows } from './workflows-preview';

export const workflowQueryKeys = {
  all: ['workflows'] as const,
  definitions: () => [...workflowQueryKeys.all, 'definitions'] as const,
  runs: () => [...workflowQueryKeys.all, 'runs'] as const,
  external: () => [...workflowQueryKeys.all, 'external'] as const,
};

export const workflowPreviewQuery = queryOptions({
  queryKey: workflowQueryKeys.definitions(),
  queryFn: () => workflows,
  initialData: workflows,
});

export const workflowRunPreviewQuery = queryOptions({
  queryKey: workflowQueryKeys.runs(),
  queryFn: () => workflowRuns,
  initialData: workflowRuns,
});

export const externalSystemPreviewQuery = queryOptions({
  queryKey: workflowQueryKeys.external(),
  queryFn: () => externalSystems,
  initialData: externalSystems,
});
