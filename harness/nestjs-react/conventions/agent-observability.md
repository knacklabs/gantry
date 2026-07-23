# Agent Observability Conventions
> Canon: <!-- canon: constitution/05-logging-and-observability.md --> — this file only adds NestJS-React scaffold specifics.

Agents don't guess at performance — they measure it. Every worktree boots an ephemeral
observability stack so agents can query logs, metrics, and traces. When the worktree
tears down, everything goes with it.

> "Agents can query logs with LogQL and metrics with PromQL. With this context available,
> prompts like 'ensure service startup completes in under 800ms' become tractable."
> — OpenAI Harness Engineering

## Observability Stack (Per Worktree)

| Component | Image | Purpose | Agent Interface |
|-----------|-------|---------|-----------------|
| Grafana Loki | `grafana/loki:latest` | Log aggregation | LogQL queries |
| Prometheus | `prom/prometheus:latest` | Metrics collection | PromQL queries |
| Grafana Tempo | `grafana/tempo:latest` | Distributed tracing | Trace ID lookup |
| Grafana | `grafana/grafana:latest` | Dev dashboard (visual) | Browser / API |

All four run via `docker-compose.observability.yml` — an overlay composed alongside the
app services. Ephemeral: created with the worktree, destroyed with it.

## Docker Compose Overlay

```yaml
# docker-compose.observability.yml (per worktree)
services:
  loki:
    image: grafana/loki:latest
    ports: ["3100:3100"]
    volumes: ["./observability/loki-config.yml:/etc/loki/local-config.yaml"]
  prometheus:
    image: prom/prometheus:latest
    ports: ["9090:9090"]
    volumes: ["./observability/prometheus.yml:/etc/prometheus/prometheus.yml"]
  tempo:
    image: grafana/tempo:latest
    ports: ["4318:4318"]  # OTLP HTTP
    volumes: ["./observability/tempo-config.yml:/etc/tempo/config.yml"]
  grafana:
    image: grafana/grafana:latest
    ports: ["3001:3000"]
    environment: ["GF_AUTH_ANONYMOUS_ENABLED=true"]
    volumes: ["./observability/grafana-datasources.yml:/etc/grafana/provisioning/datasources/ds.yml"]
```

## Agent-Legible Endpoints

| Endpoint | Source | How It Gets There |
|----------|--------|-------------------|
| `GET /metrics` | NestJS app | `@willsoto/nestjs-prometheus` exposes Prometheus format |
| Loki push | Pino logs | `pino-loki` transport auto-ships structured JSON logs |
| Tempo spans | All services | OpenTelemetry SDK auto-instrumentation |

Agents query these directly via HTTP — no dashboards required:

```bash
# Logs: query Loki API
curl -G 'http://localhost:3100/loki/api/v1/query_range' \
  --data-urlencode 'query={service="api"} |= "error"'
# Metrics: query Prometheus API
curl 'http://localhost:9090/api/v1/query?query=histogram_quantile(0.95,rate(http_request_duration_seconds_bucket[5m]))'
# Traces: lookup by trace ID from Tempo
curl 'http://localhost:4318/api/traces/<traceId>'
```

## What Agents Can Query

### Logs (Loki — LogQL)

- Structured JSON searchable by `correlationId`, `service`, `level`, `module`, time range
- By level: `{service="api"} | json | level="error"`
- By correlation ID: `{service="api"} |= "corr_abc123"`
- Business events: `{service="api"} | json | message=~"user\\.created|invoice\\.paid"`

### Metrics (Prometheus — PromQL)

| Metric | Query |
|--------|-------|
| Request latency p95 | `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))` |
| Request latency p99 | `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))` |
| Error rate | `rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m])` |
| Queue depth | `bullmq_queue_waiting_total` |
| DB query time | `histogram_quantile(0.95, rate(prisma_query_duration_seconds_bucket[5m]))` |

### Traces (Tempo)

- Full request lifecycle across API → workers → database
- Span duration per operation (controller → service → repository → DB)
- Cross-service correlation via W3C trace context headers

## Performance SLAs

Agents **must** validate these before marking a task complete:

| SLA | Threshold | How to Check |
|-----|-----------|--------------|
| Service startup | < 60s | Time from `docker compose up` to first healthy `/health` response |
| CRUD API response | p95 < 500ms | PromQL `histogram_quantile(0.95, ...)` filtered by endpoint |
| Report endpoints | p95 < 2s | Same query, filtered to `/api/v1/reports/*` |
| Single span max | < 2s | Tempo trace inspection — no span exceeds 2000ms in critical journeys |
| Queue processing | p95 < 30s/job | `histogram_quantile(0.95, rate(bullmq_job_duration_seconds_bucket[5m]))` |
| Database queries | < 100ms each | `prisma_query_duration_seconds` — any > 100ms needs PR justification |

**Critical user journeys** (no span > 2s): authentication, CRUD operations,
invoice generation, file upload/download.

## Agent Workflow

```
1. Boot worktree       → docker compose -f docker-compose.yml \
                           -f docker-compose.observability.yml up -d
2. Wait for healthy    → curl --retry 10 --retry-delay 3 localhost:3000/health
3. Exercise feature    → Run API calls, trigger workers, simulate user flows
4. Query observability → Loki (logs), Prometheus (metrics), Tempo (traces)
                         Validate all SLAs pass
5. Include evidence    → PR description includes p95 latency, error rate,
                         span summary, any SLA near threshold
6. Teardown            → docker compose ... down -v (kills app + observability)
```

## PR Evidence Requirements

Every PR touching API endpoints, workers, or database queries **must** include:

```markdown
## Performance Evidence
- **Endpoint:** `POST /api/v1/invoices`
- **p95 latency:** 120ms (SLA: 500ms) ✅
- **Max span:** 85ms (prisma.findMany) (SLA: 2s) ✅
- **Error rate:** 0% over 50 requests
- **Startup time:** 12s (SLA: 60s) ✅
```

## Anti-Patterns

| ❌ Don't | ✅ Do Instead |
|----------|--------------|
| Guess at performance | Query Prometheus, prove it with numbers |
| `console.log` debugging | Query Loki with LogQL — structured, searchable, filterable |
| Skip observability for "small changes" | Every runtime behavior change gets measured |
| Manage prod observability | Humans own production. Agents own dev/worktree only |
| Metrics without SLA thresholds | Every metric has a defined threshold in this file |
| Leave observability stack running | Teardown is mandatory — ephemeral means ephemeral |
| Hardcode service URLs | Use env vars: `LOKI_URL`, `PROMETHEUS_URL`, `TEMPO_URL` |

## Integration with Logging Convention

This extends `logging.md`. Pino structured logs are the **input** to Loki via `pino-loki`:

```typescript
// Dev transport addition (alongside pino-pretty)
{ target: 'pino-loki', options: {
    host: process.env.LOKI_URL || 'http://localhost:3100',
    labels: { service: 'api', env: 'dev' },
}}
```

OpenTelemetry auto-instrumentation handles trace context propagation automatically.
No manual span creation unless measuring a specific code block.
