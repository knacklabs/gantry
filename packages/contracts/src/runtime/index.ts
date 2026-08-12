import { z } from 'zod';

export const RuntimeProcessRoleSchema = z.enum([
  'all',
  'control',
  'live-worker',
  'job-worker',
]);

const checkStatus = z.enum(['pass', 'fail']);

export const RuntimeReadinessSchema = z.object({
  status: z.enum(['ready', 'degraded']),
  checks: z.object({
    database: checkStatus,
    migrations: checkStatus,
    settings: checkStatus,
    draining: z.boolean(),
    apiAuth: checkStatus.optional(),
    workerRegistered: checkStatus.optional(),
    scheduler: checkStatus.optional(),
    liveCapacity: z.enum(['available', 'saturated']).optional(),
  }),
  failing: z.array(
    z.enum([
      'database',
      'migrations',
      'settings',
      'draining',
      'api_auth',
      'worker_registered',
      'scheduler',
    ]),
  ),
});

export const RuntimeCapacitySchema = z.object({
  liveLimit: z.number().int().nonnegative(),
  jobLimit: z.number().int().nonnegative().nullable(),
});

export const RuntimeSummaryResponseSchema = z.object({
  role: RuntimeProcessRoleSchema,
  status: z.enum(['ready', 'degraded']),
  uptimeSeconds: z.number().nonnegative(),
  capacity: RuntimeCapacitySchema,
  counts: z.object({
    instances: z.number().int().nonnegative(),
    liveWorkers: z.number().int().nonnegative(),
    jobWorkers: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
  }),
  readiness: RuntimeReadinessSchema,
});

export const RuntimeInstanceSchema = z.object({
  id: z.string(),
  role: RuntimeProcessRoleSchema,
  status: z.enum([
    'running',
    'starting',
    'healthy',
    'unhealthy',
    'draining',
    'stopped',
  ]),
  heartbeat: z.object({
    status: z.enum(['fresh', 'stale', 'not-applicable']),
    at: z.string().datetime().nullable(),
  }),
  readiness: RuntimeReadinessSchema.nullable(),
  capacity: RuntimeCapacitySchema.nullable(),
  capabilities: z.array(z.string()),
  startedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});

export const RuntimeInstancesResponseSchema = z.object({
  instances: z.array(RuntimeInstanceSchema),
});

export type RuntimeProcessRole = z.infer<typeof RuntimeProcessRoleSchema>;
export type RuntimeReadiness = z.infer<typeof RuntimeReadinessSchema>;
export type RuntimeCapacity = z.infer<typeof RuntimeCapacitySchema>;
export type RuntimeSummaryResponse = z.infer<
  typeof RuntimeSummaryResponseSchema
>;
export type RuntimeInstance = z.infer<typeof RuntimeInstanceSchema>;
export type RuntimeInstancesResponse = z.infer<
  typeof RuntimeInstancesResponseSchema
>;
