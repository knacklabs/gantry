# Workers & Background Jobs

How to handle async work outside the request cycle. Enforced by code review and structural linters.

## Stack

| Component | Tool |
|-----------|------|
| Queue | BullMQ |
| Broker | Redis (same instance as cache, separate DB index) |
| NestJS integration | @nestjs/bullmq |
| Dashboard (dev only) | @bull-board/nestjs |
| Scheduling | BullMQ repeatable jobs (NOT node-cron) |

---

## Queue Architecture

One queue per domain. Never a shared "jobs" queue.

```
billing.queue      → BillingProcessor
notification.queue → NotificationProcessor
report.queue       → ReportProcessor
import.queue       → ImportProcessor
```

### Module Registration

```typescript
// billing/billing.module.ts
@Module({
  imports: [
    BullModule.registerQueue({ name: 'billing' }),
  ],
  providers: [BillingProcessor, BillingProducer],
})
export class BillingModule {}
```

### Directory Structure Per Domain

```
apps/api/src/billing/
  jobs/
    billing.producer.ts       # Enqueues jobs (thin — no business logic)
    billing.processor.ts      # Processes jobs (business logic here)
    billing.jobs.ts           # Job name constants + payload types
```

---

## Job Design Rules

### Serializable Payloads

Jobs carry IDs, not objects. Processor fetches fresh data.

```typescript
// billing/jobs/billing.jobs.ts
export const BillingJobs = {
  GENERATE_INVOICE: 'billing.generate-invoice',
  SEND_REMINDER: 'billing.send-reminder',
  RECONCILE: 'billing.reconcile',
} as const;

// Payload types — IDs only, max 50KB
export interface GenerateInvoicePayload {
  orderId: string;
  userId: string;
  idempotencyKey: string;  // Required on every job
}
```

### Idempotency (Non-Negotiable)

Every job MUST be safe to run more than once. BullMQ guarantees at-least-once, not exactly-once.

```typescript
// billing/jobs/billing.processor.ts
@Processor('billing')
export class BillingProcessor extends WorkerHost {
  constructor(
    private readonly billingService: BillingService,
    private readonly logger: AppLogger,
  ) { super(); }

  async process(job: Job<GenerateInvoicePayload>): Promise<void> {
    const { orderId, idempotencyKey } = job.data;

    // Idempotency check — skip if already processed
    const existing = await this.billingService.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      this.logger.info('Job already processed, skipping', {
        jobName: job.name,
        idempotencyKey,
      });
      return;
    }

    await this.billingService.generateInvoice(orderId);
  }
}
```

### Producer (Thin Enqueuer)

Producers enqueue. They don't decide, transform, or validate — that's the processor's job.

```typescript
// billing/jobs/billing.producer.ts
@Injectable()
export class BillingProducer {
  constructor(@InjectQueue('billing') private readonly queue: Queue) {}

  async enqueueInvoiceGeneration(orderId: string, userId: string): Promise<void> {
    await this.queue.add(
      BillingJobs.GENERATE_INVOICE,
      {
        orderId,
        userId,
        idempotencyKey: `invoice:${orderId}`,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 24 * 3600 },    // Keep completed 24h
        removeOnFail: { age: 7 * 24 * 3600 },    // Keep failed 7 days
      },
    );
  }
}
```

---

## Retry & Failure

### Default Retry Strategy

```typescript
// Configured per job type, not globally
{
  attempts: 3,                                    // Max retries
  backoff: { type: 'exponential', delay: 1000 },  // 1s → 2s → 4s
}
```

| Job Type | Max Attempts | Backoff | Rationale |
|----------|-------------|---------|-----------|
| Invoice generation | 3 | Exponential 1s | DB might be briefly unavailable |
| Email send | 5 | Exponential 5s | External service, flaky |
| Report generation | 2 | Fixed 30s | Heavy, don't hammer |
| Data import | 1 | None | Manual retry after investigation |

### Dead Letter Handling

Exhausted jobs stay in the failed set. Alert via structured logging:

```typescript
@OnWorkerEvent('failed')
onFailed(job: Job, error: Error): void {
  this.logger.error('Job permanently failed', {
    jobName: job.name,
    jobId: job.id,
    attemptsMade: job.attemptsMade,
    error: error.message,
    stack: error.stack,
    data: job.data,
  });

  // If critical, emit domain event for alerting
  if (job.name === BillingJobs.GENERATE_INVOICE) {
    this.eventBus.emit(new InvoiceGenerationFailedEvent(job.data.orderId));
  }
}
```

### Rules
- Never swallow errors — always log with full context
- Never retry indefinitely — set a hard max
- Distinguish transient (retry) from permanent (fail immediately) errors
- Permanent failures: validation errors, not-found, auth failures — skip retry

```typescript
// Permanent failure — don't retry
if (error instanceof RecordNotFoundError) {
  throw new UnrecoverableError(error.message);  // BullMQ skips retries
}
```

---

## Scheduled Jobs (Cron)

Use BullMQ repeatable jobs. Never `node-cron`, `setInterval`, or OS crontab.

```typescript
// billing/jobs/billing.producer.ts
async onModuleInit(): Promise<void> {
  // Daily invoice reconciliation at 2 AM
  await this.queue.upsertJobScheduler(
    'billing-daily-reconcile',
    { pattern: '0 2 * * *' },
    {
      name: BillingJobs.RECONCILE,
      data: { idempotencyKey: `reconcile:${new Date().toISOString().split('T')[0]}` },
    },
  );
}
```

### Rules
- Register all scheduled jobs in `onModuleInit` of the producer
- Use `upsertJobScheduler` (idempotent — safe on restart)
- Prevent overlap: use a job lock or check if previous run completed

```typescript
// Prevent concurrent runs of same cron
async process(job: Job): Promise<void> {
  const lockKey = `lock:${job.name}`;
  const acquired = await this.redis.set(lockKey, job.id, 'NX', 'EX', 3600);
  if (!acquired) {
    this.logger.warn('Skipping — previous run still active', { jobName: job.name });
    return;
  }
  try {
    await this.doWork(job);
  } finally {
    await this.redis.del(lockKey);
  }
}
```

---

## Long-Running Jobs

No single job should run longer than 5 minutes. Split into chains.

```typescript
// WRONG — one 30-minute import job
async processImport(job: Job<ImportPayload>): Promise<void> {
  const rows = await this.fetchAllRows();  // 100k rows
  for (const row of rows) { await this.process(row); }
}

// RIGHT — chunked into child jobs
async processImport(job: Job<ImportPayload>): Promise<void> {
  const totalRows = await this.countRows(job.data.importId);
  const chunkSize = 500;

  for (let offset = 0; offset < totalRows; offset += chunkSize) {
    await this.queue.add(BillingJobs.IMPORT_CHUNK, {
      importId: job.data.importId,
      offset,
      limit: chunkSize,
      idempotencyKey: `import:${job.data.importId}:${offset}`,
    });
  }
}
```

### Rules
- Max 5 minutes per job. If longer, chunk it.
- Batch database operations (bulk insert, not one-by-one)
- Progress tracking via `job.updateProgress(percentage)`
- Parent job waits on children via BullMQ flow (job dependencies)

---

## Observability

### Logging (Every Job)

```
[started]   { jobName, jobId, correlationId, payload }
[completed] { jobName, jobId, correlationId, duration }
[failed]    { jobName, jobId, correlationId, duration, error, attemptsMade }
```

### Bull Board (Dev Only)

```typescript
// app.module.ts — conditionally loaded
@Module({
  imports: [
    ...(process.env.NODE_ENV !== 'production'
      ? [BullBoardModule.forRoot({ route: '/admin/queues', adapter: ExpressAdapter })]
      : []),
  ],
})
```

Never expose queue dashboard in production. Use structured logs + metrics instead.

### Metrics to Track
- Queue depth (pending jobs per queue)
- Processing time (p50, p95, p99 per job type)
- Failure rate (per job type, rolling 1h window)
- Retry rate (jobs that succeeded on retry vs first attempt)

---

## Anti-Patterns

| Anti-Pattern | Fix |
|-------------|-----|
| One "jobs" queue for everything | One queue per domain |
| Full objects in payload | IDs only, fetch fresh in processor |
| No idempotency key | Every job has one — duplicates are skipped |
| Business logic in producer | Producer enqueues, processor does work |
| Fixed retry intervals | Exponential backoff |
| Swallowing failures | Log + alert on every failure |
| node-cron / setInterval | BullMQ repeatable jobs |
| 30-minute monolith job | Chunk into ≤5 min child jobs |
| HTTP calls without timeout | Always set timeout + handle failure |
| DB transaction spanning full job | Batch in chunks, commit per batch |
| Bull Board in production | Structured logs + metrics only |
| `any` typed job payloads | Typed interfaces per job |
