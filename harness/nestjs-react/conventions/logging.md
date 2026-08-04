# Logging Conventions
> Canon: <!-- canon: constitution/05-logging-and-observability.md --> — this file only adds NestJS-React scaffold specifics.

## Format

All environments emit **JSON logs**. No plain-text, no `console.log`.

Logger: NestJS built-in logger wrapping **pino** via `nestjs-pino`.

## Log Levels

| Level | Use | Production |
|-------|-----|------------|
| `error` | Unrecoverable failures — include stack trace + request context | ✅ |
| `warn` | Recoverable failures, degraded paths, retry exhaustion | ✅ |
| `info` | Business events: `user.created`, `invoice.paid`, `deploy.started` | ✅ |
| `debug` | Detailed flow tracing, variable dumps | ❌ Off |

## Required Fields (Every Entry)

```
timestamp, level, message, correlationId, service, module
```

## Pino Config

```typescript
// src/logger.config.ts
import { Params } from 'nestjs-pino';

export const loggerConfig: Params = {
  pinoHttp: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
    serializers: {
      req: (req) => ({ method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie'],
      censor: '[REDACTED]',
    },
  },
};
```

## Correlation IDs

Generated per request via middleware, propagated through `AsyncLocalStorage`.

```typescript
// src/common/correlation/correlation.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { correlationStorage } from './correlation.storage';

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    const correlationId = req.headers['x-correlation-id'] || randomUUID();
    res.setHeader('x-correlation-id', correlationId);

    correlationStorage.run({ correlationId }, () => next());
  }
}
```

```typescript
// src/common/correlation/correlation.storage.ts
import { AsyncLocalStorage } from 'async_hooks';

interface CorrelationContext {
  correlationId: string;
}

export const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

export function getCorrelationId(): string {
  return correlationStorage.getStore()?.correlationId || 'no-correlation';
}
```

Attach to all downstream calls:

```typescript
// When calling external services
const headers = { 'x-correlation-id': getCorrelationId() };
```

Include in error responses so support can trace issues:

```json
{ "statusCode": 500, "message": "Internal error", "correlationId": "a1b2c3d4" }
```

## PII Masking

Applied **automatically via serializer** — never mask manually per log call.

```typescript
// src/common/logger/pii-serializer.ts
const PII_PATTERNS = {
  email: /([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
  phone: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
};

export function maskPii(value: string): string {
  return value
    .replace(PII_PATTERNS.email, (_, local, domain) =>
      `${local.slice(0, 2)}***@${domain}`)
    .replace(PII_PATTERNS.phone, (match) =>
      `***${match.slice(-4)}`);
}

export function sanitizeObject(obj: unknown): unknown {
  if (typeof obj === 'string') return maskPii(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (obj && typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      const lower = key.toLowerCase();
      if (['password', 'token', 'secret', 'authorization'].includes(lower)) {
        sanitized[key] = '[REDACTED]';
      } else if (['name', 'firstname', 'lastname', 'fullname'].includes(lower)) {
        sanitized[key] = '[PII_REMOVED]';
      } else {
        sanitized[key] = sanitizeObject(val);
      }
    }
    return sanitized;
  }
  return obj;
}
```

**Masking rules:**

| Field | Format | Example |
|-------|--------|---------|
| Email | First 2 chars + domain | `ra***@knacklabs.ai` |
| Phone | Last 4 digits | `***5474` |
| Names | Never logged | `[PII_REMOVED]` |
| Tokens/passwords | Never logged | `[REDACTED]` |

## Frontend Logging

- **Dev:** Console is fine.
- **Production:** Errors → error tracking service (Sentry/equivalent). No console output.
- **Lint rule:** `no-console` is an **error**, not a warning.

```typescript
// apps/web/src/lib/logger.ts
const isProd = process.env.NODE_ENV === 'production';

export const logger = {
  error: (msg: string, context?: Record<string, unknown>) => {
    if (isProd) {
      // Sentry.captureException or equivalent
      errorTracker.capture(msg, context);
    } else {
      console.error(msg, context);
    }
  },
  info: (msg: string, context?: Record<string, unknown>) => {
    if (!isProd) console.info(msg, context);
  },
};
```

```jsonc
// .eslintrc (frontend)
{ "rules": { "no-console": "error" } }
```

## Anti-Patterns

| ❌ Don't | ✅ Do |
|----------|-------|
| `console.log('user:', user)` | `logger.info('user.created', { userId: user.id })` |
| `logger.info('Req body: ' + JSON.stringify(body))` | `logger.debug({ event: 'request.received', path: req.path })` |
| `logger.info(\`User ${email} logged in\`)` | `logger.info({ event: 'user.login', email })` — PII auto-masked |
| Log full request/response bodies | Log event name + safe identifiers only |
| Manual PII redaction per call | Rely on the serializer — it's automatic |

## Usage Example

```typescript
import { Logger } from '@nestjs/common';
import { getCorrelationId } from '../correlation/correlation.storage';

export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  async processPayment(invoiceId: string) {
    this.logger.log({
      event: 'payment.processing',
      invoiceId,
      correlationId: getCorrelationId(),
    });

    try {
      const result = await this.stripe.charge(invoiceId);
      this.logger.log({ event: 'payment.success', invoiceId, chargeId: result.id });
    } catch (error) {
      this.logger.error({
        event: 'payment.failed',
        invoiceId,
        correlationId: getCorrelationId(),
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
}
```
