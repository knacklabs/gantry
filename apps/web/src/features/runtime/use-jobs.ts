import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  requireRuntimeTransport,
  useRuntimeConnection,
} from '../../lib/api/runtime-connection';
import {
  createJob,
  deleteJob,
  jobQueryKeys,
  loadJob,
  loadJobs,
  loadRunDetail,
  loadRuns,
  runJobAction,
  updateJob,
  type CreateJobInput,
} from './job-api';

export function useJobs() {
  const connection = useRuntimeConnection();
  return useQuery({
    queryKey: jobQueryKeys.list(),
    enabled: Boolean(connection.transport),
    queryFn: () => loadJobs(requireRuntimeTransport(connection)),
  });
}

export function useJob(jobId: string) {
  const connection = useRuntimeConnection();
  return useQuery({
    queryKey: jobQueryKeys.detail(jobId),
    enabled: Boolean(connection.transport && jobId),
    queryFn: () => loadJob(requireRuntimeTransport(connection), jobId),
  });
}

export function useJobRuns(jobId: string) {
  const connection = useRuntimeConnection();
  return useQuery({
    queryKey: jobQueryKeys.runs(jobId),
    enabled: Boolean(connection.transport && jobId),
    queryFn: () => loadRuns(requireRuntimeTransport(connection), jobId),
  });
}

export function useRunDetail(runId: string | undefined) {
  const connection = useRuntimeConnection();
  return useQuery({
    queryKey: jobQueryKeys.run(runId ?? ''),
    enabled: Boolean(connection.transport && runId),
    queryFn: () =>
      loadRunDetail(requireRuntimeTransport(connection), runId ?? ''),
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status === 'running' || status === 'waiting' ? 4_000 : false;
    },
  });
}

export function useCreateJob() {
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateJobInput) =>
      createJob(requireRuntimeTransport(connection), input),
    onSuccess: async () => invalidateJobs(queryClient),
  });
}

export function useUpdateJob(jobId: string) {
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      updateJob(requireRuntimeTransport(connection), jobId, patch),
    onSuccess: async () => invalidateJobs(queryClient),
  });
}

export function useDeleteJob(jobId: string) {
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deleteJob(requireRuntimeTransport(connection), jobId),
    onSuccess: async () => invalidateJobs(queryClient),
  });
}

export function useJobAction(jobId: string) {
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'trigger') =>
      runJobAction(requireRuntimeTransport(connection), jobId, action),
    onSuccess: async () => invalidateJobs(queryClient),
  });
}

async function invalidateJobs(queryClient: ReturnType<typeof useQueryClient>) {
  await queryClient.invalidateQueries({ queryKey: jobQueryKeys.all });
}
