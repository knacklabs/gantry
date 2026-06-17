import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  new URL('../../../../..', import.meta.url).pathname,
);
const switchReferencePath = path.join(
  repoRoot,
  'docs/architecture/runtime-switch-reference.md',
);
const warmPoolPlanPath = path.join(
  repoRoot,
  'docs/architecture/warm-pool-routing-findings-and-todos.md',
);

describe('runtime switch reference', () => {
  it('documents owner, default, dev, prod, restart, and impact for runtime switches', () => {
    const doc = fs.readFileSync(switchReferencePath, 'utf8');
    const plan = fs.readFileSync(warmPoolPlanPath, 'utf8');
    const requiredHeaders = [
      'runtime.queue.max_message_runs',
      'runtime.queue.max_job_runs',
      'runtime.queue.max_retries',
      'runtime.queue.base_retry_ms',
      'runtime.warm_pool.enabled',
      'runtime.warm_pool.size',
      'runtime.warm_pool.idle_ttl_ms',
      'runtime.warm_pool.max_bound_workers',
      'runtime.warm_pool.cache_prewarm_enabled',
      'runtime.warm_pool.cache_prewarm_concurrency',
      'runtime.runner.idle_timeout_ms',
      'runtime.ownership.lease_ttl_ms',
      'runtime.ownership.heartbeat_interval_ms',
      'runtime.ownership.reconciler_interval_ms',
      'runtime.ownership.reconciler_limit',
      'runtime.ownership.shutdown_claim_wait_ms',
      'GANTRY_FLOW_LOG',
      'GANTRY_DEV_LOG',
      'GANTRY_OUTBOUND_DRYRUN',
      'GANTRY_TEST_OPERATOR_PHONE',
      'GANTRY_TEST_CALLER_IDENTITY_PHONE',
      'BOONDI_CRM_RECONCILE_INTERVAL_MS',
      'GANTRY_TRACE_PAYLOADS',
      'GANTRY_CONTROL_API_KEYS_JSON',
      'messages:admin',
    ];

    expect(doc).toMatch(
      /\|\s*Switch\s*\|\s*Owner surface\s*\|\s*Default\s*\|\s*Dev recommendation\s*\|\s*Production recommendation\s*\|\s*Restart requirement\s*\|\s*Latency\/correctness impact\s*\|/,
    );
    for (const token of requiredHeaders) {
      expect(doc).toContain(token);
    }
    expect(doc).toContain('Do not reintroduce `GANTRY_WARM_POOL`');
    expect(doc).toContain('Do not reintroduce `GANTRY_WARM_POOL_CACHE_PROBE`');
    expect(doc).toContain('Do not reintroduce `IDLE_TIMEOUT`');
    expect(plan).toContain('docs/architecture/runtime-switch-reference.md');
  });
});
